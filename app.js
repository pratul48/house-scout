/* House Scout – main app. Uses free, key-less services:
 *  - OpenStreetMap Nominatim (address lookup), Overpass (buildings, streets, places)
 *  - OSRM demo server (driving distance/time), Open-Meteo (elevation), FEMA NFHL (flood zone)
 */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const enc = encodeURIComponent;
  const miles = m => m / 1609.344;
  const fmtMi = m => { const v = miles(m); return v < 0.1 ? `${Math.round(m * 3.28084)} ft` : `${v < 10 ? v.toFixed(1) : Math.round(v)} mi`; };
  const fmtMin = s => s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;

  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  const OSRM = 'https://router.project-osrm.org';

  const state = { place: null, facing: null, estimate: null, nearby: {}, map: null, layers: {}, runId: 0 };

  // ---------- storage ----------
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem('hs_' + k)) ?? d; } catch { return d; } },
    set(k, v) { localStorage.setItem('hs_' + k, JSON.stringify(v)); }
  };

  // ---------- network ----------
  async function fetchJSON(url, opts = {}, timeout = 25000) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { ...opts, signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  async function overpass(query) {
    let lastErr;
    for (const url of OVERPASS) {
      try {
        return await fetchJSON(url, { method: 'POST', body: 'data=' + enc(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 40000);
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  const geocode = q => fetchJSON(`${NOMINATIM}/search?format=jsonv2&addressdetails=1&limit=5&q=${enc(q)}`);
  const reverse = (lat, lon) => fetchJSON(`${NOMINATIM}/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${lat}&lon=${lon}`);

  function placeFromNominatim(r) {
    const a = r.address || {};
    const street = a.road || a.pedestrian || a.residential || '';
    const line1 = [a.house_number, street].filter(Boolean).join(' ');
    const city = a.city || a.town || a.village || a.hamlet || a.suburb || '';
    const label = [line1, city, a.state, a.postcode].filter(Boolean).join(', ') || r.display_name;
    return { lat: +r.lat, lon: +r.lon, label, street, city, county: a.county || '', st: a.state || '', zip: a.postcode || '', country: a.country_code || '', display: r.display_name };
  }

  // ---------- UI helpers ----------
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 2800); }

  function showView(id) {
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === id));
    document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === id));
    if (id === 'view-saved') renderSaved();
    if (id === 'view-search' && state.map) setTimeout(() => state.map.invalidateSize(), 50);
    window.scrollTo(0, 0);
  }

  // ---------- search ----------
  async function onSearch(e) {
    e.preventDefault();
    const q = $('#addr').value.trim(); if (!q) return;
    const box = $('#search-results'); box.innerHTML = '<div class="loading">Finding address…</div>';
    try {
      const res = await geocode(q);
      if (!res.length) { box.innerHTML = '<p class="warn">Address not found. Try adding the city and state.</p>'; return; }
      if (res.length === 1 || (res[0].importance ?? 0) - (res[1].importance ?? 0) > 0.1) { box.innerHTML = ''; return analyze(placeFromNominatim(res[0])); }
      box.innerHTML = '<p class="small muted">Which one?</p>' + res.map((r, i) => `<button class="btn wide pick" data-i="${i}">${esc(placeFromNominatim(r).label)}</button>`).join('');
      box.querySelectorAll('.pick').forEach(b => b.onclick = () => { box.innerHTML = ''; analyze(placeFromNominatim(res[+b.dataset.i])); });
    } catch (err) { box.innerHTML = `<p class="warn">Address lookup failed (${esc(err.message)}). Check your connection and try again.</p>`; }
  }

  function onGPS() {
    if (!navigator.geolocation) return toast('Location not available on this device');
    const box = $('#search-results'); box.innerHTML = '<div class="loading">Getting your location…</div>';
    navigator.geolocation.getCurrentPosition(async pos => {
      const { latitude: lat, longitude: lon } = pos.coords;
      try { const r = await reverse(lat, lon); box.innerHTML = ''; const p = placeFromNominatim(r); p.lat = lat; p.lon = lon; $('#addr').value = p.label; analyze(p); }
      catch { box.innerHTML = ''; analyze({ lat, lon, label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, street: '' }); }
    }, err => { box.innerHTML = `<p class="warn">Couldn't get location: ${esc(err.message)}</p>`; }, { enableHighAccuracy: true, timeout: 15000 });
  }

  // ---------- main analysis ----------
  async function analyze(place, saved) {
    const run = ++state.runId;
    state.place = place; state.facing = null; state.estimate = null; state.nearby = {};
    $('#results').hidden = false;
    $('#addr-title').textContent = place.label;
    $('#verdict').innerHTML = '<div class="loading">Working out which way the house faces…</div>';
    $('#facing-info').innerHTML = ''; renderDial(null);
    ['#nearby', '#nuisances', '#property'].forEach(s => $(s).innerHTML = '<div class="loading">Loading…</div>');
    fillNotes(saved || findSaved(place) || {});
    renderLinks(place);
    initMap(place);
    setTimeout(() => $('#card-header').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);

    // facing direction first (most important), then everything else in parallel
    const facingP = runFacing(place, run);
    loadNearby(place, run);
    loadProperty(place, run);
    await facingP;
    if (saved && saved.facingSource && saved.facingSource !== 'map' && run === state.runId) setFacing(saved.bearing, saved.facingSource);
  }

  async function runFacing(point, run) {
    const q = `[out:json][timeout:25];(way["building"](around:70,${point.lat},${point.lon});way["highway"](around:200,${point.lat},${point.lon}););out tags geom;`;
    try {
      const data = await overpass(q);
      if (run !== state.runId) return;
      const ways = data.elements.filter(e => e.type === 'way');
      const est = Geo.estimateFacing(point, ways.filter(w => w.tags.building), ways.filter(w => w.tags.highway), state.place.street);
      state.estimate = est;
      if (!est.ok) { $('#verdict').innerHTML = `<p class="warn">${esc(est.reason)} Use the compass check below.</p>`; return; }
      setFacing(est.bearing, 'map');
      drawEstimateOnMap(est);
    } catch (e) {
      if (run !== state.runId) return;
      $('#verdict').innerHTML = `<p class="warn">Map data service is busy (${esc(e.message)}). Tap the house on the map to retry, or use the compass check below.</p>`;
    }
  }

  function setFacing(bearing, source) {
    const c = Geo.classify(bearing);
    state.facing = { ...c, source };
    const srcText = { map: 'Estimated from the map', compass: 'Measured with your compass', manual: 'Set by you' }[source];
    const est = state.estimate;
    const conf = source === 'map' && est ? est.confidence : null;
    const backDir = Geo.classify(bearing + 180);

    $('#verdict').innerHTML = c.avoid
      ? `<div class="badge bad">✖ Faces ${c.name} – avoid</div>`
      : `<div class="badge good">✔ Faces ${c.name} – OK</div>`;
    if (c.nearBoundary) $('#verdict').innerHTML += `<p class="warn small">⚠️ This is within ${Math.round(c.edgeDist)}° of the ${c.avoid ? 'OK' : 'avoid'} zone. Double-check with the compass at the front door.</p>`;
    if (conf && conf !== 'high') $('#verdict').innerHTML += `<p class="warn small">⚠️ Map confidence is ${conf}. Confirm with the compass or Street View.</p>`;

    let html = `<div class="big-dir">${c.dir} <span>${Math.round(c.bearing)}°</span></div>
      <div class="small">${srcText}${conf ? ` · confidence: <b>${conf}</b>` : ''}</div>
      <div class="small">Backyard faces <b>${backDir.name}</b></div>`;
    if (source === 'map' && est && est.ok) {
      html += `<div class="small muted">Front street: ${esc(est.street)} (${Math.round(est.streetDist * 3.28)} ft from house center)</div>`;
      html += est.notes.map(n => `<p class="small warn">${esc(n)}</p>`).join('');
    }
    if (source !== 'map' && est && est.ok) {
      const m = Geo.classify(est.bearing);
      html += `<div class="small muted">Map estimate was ${m.dir} (${Math.round(m.bearing)}°). <a href="#" id="reset-map">Use map estimate</a></div>`;
    }
    $('#facing-info').innerHTML = html;
    const r = $('#reset-map'); if (r) r.onclick = ev => { ev.preventDefault(); setFacing(est.bearing, 'map'); };
    renderDial(c.bearing);
    drawArrow();
  }

  // ---------- dial ----------
  function renderDial(bearing) {
    const cx = 100, cy = 100, r = 84;
    const pt = (deg, rad) => { const a = (deg - 90) * Math.PI / 180; return [cx + rad * Math.cos(a), cy + rad * Math.sin(a)]; };
    const [x1, y1] = pt(Geo.AVOID_START, r), [x2, y2] = pt(Geo.AVOID_END, r);
    let svg = `<svg viewBox="0 0 200 200" class="dial" role="img" aria-label="Compass">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="#ecfdf5" stroke="#94a3b8"/>
      <path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 0 1 ${x2},${y2} Z" fill="#fecaca" opacity=".9"/>`;
    Geo.DIRS.forEach(d => { const [x, y] = pt(Geo.DIR_CENTER[d], r - 14); svg += `<text x="${x}" y="${y + 4}" text-anchor="middle" font-size="${d.length === 1 ? 15 : 11}" font-weight="700" fill="${['S', 'SE', 'SW'].includes(d) ? '#b91c1c' : '#334155'}">${d}</text>`; });
    if (bearing != null) {
      const [ax, ay] = pt(bearing, r - 28), [bx, by] = pt(bearing + 180, 18);
      svg += `<line x1="${bx}" y1="${by}" x2="${ax}" y2="${ay}" stroke="#0f172a" stroke-width="5" stroke-linecap="round"/>
        <circle cx="${ax}" cy="${ay}" r="7" fill="${Geo.classify(bearing).avoid ? '#dc2626' : '#16a34a'}"/>
        <text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="18">🏠</text>`;
    }
    $('#dial').innerHTML = svg + '</svg>';
  }

  // ---------- map ----------
  function initMap(place) {
    if (typeof L === 'undefined') { $('#map').innerHTML = '<p class="warn">Map library failed to load.</p>'; return; }
    if (!state.map) {
      const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
      const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery © Esri' });
      state.map = L.map('map', { layers: [sat], zoomControl: true });
      L.control.layers({ Satellite: sat, Street: street }, null, { position: 'topright' }).addTo(state.map);
      state.map.on('click', ev => {
        const p = { ...state.place, lat: ev.latlng.lat, lon: ev.latlng.lng };
        state.place = p;
        $('#verdict').innerHTML = '<div class="loading">Re-checking this building…</div>';
        if (state.layers.marker) state.layers.marker.setLatLng(ev.latlng);
        runFacing(p, state.runId);
      });
    }
    Object.values(state.layers).forEach(l => l && state.map.removeLayer(l)); state.layers = {};
    state.layers.marker = L.marker([place.lat, place.lon]).addTo(state.map);
    state.map.setView([place.lat, place.lon], 19);
    setTimeout(() => state.map.invalidateSize(), 100);
  }

  function drawEstimateOnMap(est) {
    if (!state.map) return;
    ['building', 'road'].forEach(k => { if (state.layers[k]) { state.map.removeLayer(state.layers[k]); delete state.layers[k]; } });
    if (est.building) state.layers.building = L.polygon(est.building.geometry.map(g => [g.lat, g.lon]), { color: '#facc15', weight: 3, fillOpacity: 0.15 }).addTo(state.map);
    state.layers.road = L.circleMarker([est.roadPoint.lat, est.roadPoint.lon], { radius: 5, color: '#38bdf8' }).addTo(state.map).bindTooltip(est.street);
  }

  function drawArrow() {
    if (!state.map || !state.facing) return;
    if (state.layers.arrow) state.map.removeLayer(state.layers.arrow);
    const o = state.estimate && state.estimate.ok ? state.estimate.origin : state.place;
    const len = 22, b = state.facing.bearing * Math.PI / 180;
    const end = [o.lat + (len * Math.cos(b)) / 110540, o.lon + (len * Math.sin(b)) / (111320 * Math.cos(o.lat * Math.PI / 180))];
    const color = state.facing.avoid ? '#ef4444' : '#22c55e';
    state.layers.arrow = L.layerGroup([
      L.polyline([[o.lat, o.lon], end], { color, weight: 6 }),
      L.circleMarker(end, { radius: 7, color, fillColor: color, fillOpacity: 1 }).bindTooltip('Front', { permanent: true, direction: 'top' })
    ]).addTo(state.map);
  }

  // ---------- compass ----------
  const compass = { readings: [], on: false, handler: null };
  async function startCompass() {
    const D = window.DeviceOrientationEvent;
    if (!D) return toast('This device has no compass sensor');
    try { if (typeof D.requestPermission === 'function' && (await D.requestPermission()) !== 'granted') return toast('Compass permission denied'); }
    catch (e) { return toast('Compass permission failed: ' + e.message); }
    stopCompass();
    compass.readings = []; compass.on = true;
    compass.handler = ev => {
      let h = null;
      if (typeof ev.webkitCompassHeading === 'number') h = ev.webkitCompassHeading; // iOS
      else if (ev.absolute && ev.alpha != null) h = Geo.norm360(360 - ev.alpha + ((screen.orientation && screen.orientation.angle) || 0));
      if (h == null) return;
      compass.readings.push(h); if (compass.readings.length > 20) compass.readings.shift();
      const avg = Geo.circularMean(compass.readings), t = Geo.norm360(avg + decl());
      const c = Geo.classify(t);
      $('#compass-live').innerHTML = `Pointing: <b>${c.dir} ${Math.round(t)}°</b> (true) ${c.avoid ? '❌' : '✅'}`;
      $('#btn-lock').disabled = false;
    };
    const evName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    compass.evName = evName;
    window.addEventListener(evName, compass.handler);
    $('#compass-live').textContent = 'Waiting for compass… (move the phone in a figure-8 if it stays stuck)';
    setTimeout(() => { if (compass.on && !compass.readings.length) $('#compass-live').textContent = 'No compass readings. Your browser may not support it; set the direction manually instead.'; }, 4000);
  }
  function stopCompass() { if (compass.handler) window.removeEventListener(compass.evName, compass.handler); compass.on = false; compass.handler = null; }
  function lockCompass() {
    if (!compass.readings.length) return;
    const t = Geo.norm360(Geo.circularMean(compass.readings) + decl());
    stopCompass(); $('#btn-lock').disabled = true; $('#compass-live').textContent = `Locked at ${Math.round(t)}°`;
    setFacing(t, 'compass'); toast('Direction saved from compass');
    $('#card-header').scrollIntoView({ behavior: 'smooth' });
  }
  const decl = () => parseFloat($('#declination').value) || 0;

  // ---------- nearby places ----------
  const INDIAN_NAME = 'India|Indian|Patel|Desi|Apna|Bazaa?r|Masala|Spice|Subzi|Sabzi|Mandi|Namaste|Swadesh|Bombay|Mumbai|Delhi|Punjab|Bharat|Shalimar|Swagat|Mehran|Nirav|Subhlaxmi|Hindustan|Kerala|Gujarat|Chennai|Madras|Telugu|Ambica|Raja|Taj';
  const CATS = [
    { key: 'costco', label: 'Costco', icon: '🛒', r: 60000, q: ['nwr["brand:wikidata"="Q715583"]', 'nwr["name"~"^Costco",i]["shop"]'],
      test: t => (t['brand:wikidata'] === 'Q715583' || /^costco/i.test(t.name || '')) && !t.amenity && !/gas|fuel|tire|pharmacy|optical/i.test(t.name || '') },
    { key: 'indian', label: 'Indian grocery', icon: '🍛', r: 40000, q: [`nwr["shop"]["name"~"${INDIAN_NAME}",i]`, 'nwr["shop"]["cuisine"~"indian",i]', 'nwr["shop"]["origin"~"india",i]'],
      test: t => !!t.shop && /^(supermarket|convenience|grocery|greengrocer|deli|food|spices|general|variety_store)$/.test(t.shop) && (new RegExp(INDIAN_NAME, 'i').test(t.name || '') || /indian/i.test(t.cuisine || '') || /india/i.test(t.origin || '')) },
    { key: 'temple', label: 'Hindu temple', icon: '🛕', r: 50000, q: ['nwr["amenity"="place_of_worship"]["religion"="hindu"]'], test: t => t.religion === 'hindu' },
    { key: 'indianfood', label: 'Indian restaurant', icon: '🥘', r: 25000, q: ['nwr["amenity"~"^(restaurant|fast_food)$"]["cuisine"~"indian",i]'], test: t => /^(restaurant|fast_food)$/.test(t.amenity || '') && /indian/i.test(t.cuisine || '') },
    { key: 'grocery', label: 'Supermarket', icon: '🥦', r: 10000, q: ['nwr["shop"="supermarket"]'], test: t => t.shop === 'supermarket', show: 2 },
    { key: 'hospital', label: 'Hospital (ER)', icon: '🏥', r: 40000, q: ['nwr["amenity"="hospital"]'], test: t => t.amenity === 'hospital' },
    { key: 'urgent', label: 'Urgent care / clinic', icon: '🩺', r: 15000, q: ['nwr["healthcare"="urgent_care"]', 'nwr["amenity"="clinic"]'], test: t => t.healthcare === 'urgent_care' || t.amenity === 'clinic' },
    { key: 'pharmacy', label: 'Pharmacy', icon: '💊', r: 10000, q: ['nwr["amenity"="pharmacy"]'], test: t => t.amenity === 'pharmacy' },
    { key: 'school', label: 'Schools', icon: '🏫', r: 6000, q: ['nwr["amenity"="school"]'], test: t => t.amenity === 'school', show: 3 },
    { key: 'park', label: 'Park / playground', icon: '🌳', r: 4000, q: ['nwr["leisure"~"^(park|playground)$"]["name"]'], test: t => /^(park|playground)$/.test(t.leisure || '') && t.name },
    { key: 'library', label: 'Library', icon: '📚', r: 15000, q: ['nwr["amenity"="library"]'], test: t => t.amenity === 'library' },
    { key: 'gym', label: 'Gym', icon: '🏋️', r: 10000, q: ['nwr["leisure"="fitness_centre"]'], test: t => t.leisure === 'fitness_centre' },
    { key: 'fuel', label: 'Gas station', icon: '⛽', r: 10000, q: ['nwr["amenity"="fuel"]'], test: t => t.amenity === 'fuel' },
    { key: 'fire', label: 'Fire station', icon: '🚒', r: 15000, q: ['nwr["amenity"="fire_station"]'], test: t => t.amenity === 'fire_station' },
    { key: 'police', label: 'Police', icon: '🚓', r: 20000, q: ['nwr["amenity"="police"]'], test: t => t.amenity === 'police' },
    { key: 'transit', label: 'Train / metro station', icon: '🚆', r: 30000, q: ['nwr["railway"="station"]', 'nwr["public_transport"="station"]["train"="yes"]'], test: t => t.railway === 'station' || (t.public_transport === 'station' && t.train === 'yes') },
    { key: 'airport', label: 'Airport', icon: '✈️', r: 120000, q: ['nwr["aeroway"="aerodrome"]["iata"]'], test: t => t.aeroway === 'aerodrome' && t.iata }
  ];

  function catQuery(cats, p) {
    const parts = cats.flatMap(c => c.q.map(s => `${s}(around:${c.r},${p.lat},${p.lon});`));
    return `[out:json][timeout:60];(${parts.join('')});out tags center;`;
  }

  async function loadNearby(p, run) {
    const far = CATS.filter(c => c.r > 20000), near = CATS.filter(c => c.r <= 20000);
    const results = {};
    const collect = (data, cats) => {
      for (const el of data.elements) {
        const t = el.tags || {}; const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
        if (lat == null) continue;
        const d = Geo.haversine(p, { lat, lon });
        for (const c of cats) if (d <= c.r && c.test(t)) (results[c.key] ||= []).push({ name: t.name || t.brand || c.label, tags: t, lat, lon, dist: d });
      }
    };
    const errors = [];
    await Promise.all([
      overpass(catQuery(far, p)).then(d => collect(d, far)).catch(e => errors.push(e)),
      overpass(catQuery(near, p)).then(d => collect(d, near)).catch(e => errors.push(e))
    ]);
    if (run !== state.runId) return;
    for (const k in results) {
      // de-dup (same place mapped as node + building)
      const seen = []; results[k] = results[k].sort((a, b) => a.dist - b.dist).filter(x => { if (seen.some(s => s.name === x.name && Geo.haversine(s, x) < 300)) return false; seen.push(x); return true; });
    }
    state.nearby = results;
    renderNearby(p, errors.length === 2);
    await addDriveTimes(p, run);
  }

  async function addDriveTimes(p, run) {
    const targets = [];
    for (const c of CATS) (state.nearby[c.key] || []).slice(0, c.show || 1).forEach(x => targets.push(x));
    const myPlaces = store.get('places', []).filter(x => x.lat);
    myPlaces.forEach(x => targets.push(x));
    if (!targets.length) return;
    try {
      const coords = [p, ...targets].map(x => `${x.lon.toFixed(6)},${x.lat.toFixed(6)}`).join(';');
      const r = await fetchJSON(`${OSRM}/table/v1/driving/${coords}?sources=0&annotations=duration,distance`, {}, 20000);
      if (run !== state.runId || r.code !== 'Ok') return;
      targets.forEach((t, i) => { t.drive = { s: r.durations[0][i + 1], m: r.distances[0][i + 1] }; });
      renderNearby(p, false, myPlaces);
    } catch { /* straight-line distances already shown */ }
  }

  function renderNearby(p, failed, myPlaces) {
    const gmaps = (q) => `https://www.google.com/maps/search/${enc(q)}/@${p.lat},${p.lon},12z`;
    const dirLink = x => `https://www.google.com/maps/dir/?api=1&origin=${p.lat},${p.lon}&destination=${x.lat},${x.lon}`;
    const line = x => `<div class="place"><a href="${dirLink(x)}" target="_blank" rel="noopener">${esc(x.name)}</a>
        <span class="dist">${x.drive && x.drive.s != null ? `🚗 ${fmtMi(x.drive.m)} · ${fmtMin(x.drive.s)}` : `${fmtMi(x.dist)} straight-line`}</span></div>`;
    let html = failed ? '<p class="warn">Nearby search failed (map data server busy). Re-open the house in a minute to retry.</p>' : '';
    if (myPlaces && myPlaces.length) {
      html += `<div class="cat"><div class="cat-h">⭐ My places</div>${myPlaces.map(x => line({ ...x, name: x.label + ' – ' + x.address })).join('')}</div>`;
    }
    for (const c of CATS) {
      const list = state.nearby[c.key] || [];
      html += `<div class="cat"><div class="cat-h">${c.icon} ${c.label}</div>`;
      html += list.length ? list.slice(0, c.show || 1).map(line).join('') : `<div class="muted small">None found within ${Math.round(miles(c.r))} mi on OpenStreetMap.</div>`;
      if (c.key === 'indian') html += `<div class="small">OpenStreetMap misses many Indian stores. <a href="${gmaps('indian grocery store')}" target="_blank" rel="noopener">Search Google Maps →</a></div>`;
      if (c.key === 'temple') html += `<div class="small"><a href="${gmaps('hindu temple')}" target="_blank" rel="noopener">Search Google Maps →</a></div>`;
      if (c.key === 'costco' && !list.length) html += `<div class="small"><a href="https://www.costco.com/warehouse-locations" target="_blank" rel="noopener">Costco warehouse locator →</a></div>`;
      html += '</div>';
    }
    $('#nearby').innerHTML = html;
  }

  // ---------- nuisances ----------
  async function loadNuisances(p, run) {
    const q = `[out:json][timeout:40];(
      way["highway"~"^(motorway|trunk)$"](around:1000,${p.lat},${p.lon});
      way["railway"="rail"](around:1000,${p.lat},${p.lon});
      way["power"="line"](around:400,${p.lat},${p.lon});
      way["landuse"="industrial"](around:600,${p.lat},${p.lon});
      way["landuse"="landfill"](around:3000,${p.lat},${p.lon});
      nwr["landuse"="cemetery"](around:1000,${p.lat},${p.lon});
      nwr["amenity"="grave_yard"](around:1000,${p.lat},${p.lon});
      nwr["aeroway"="aerodrome"](around:8000,${p.lat},${p.lon});
      way["highway"~"^(primary|secondary)$"](around:120,${p.lat},${p.lon});
    );out tags geom;`;
    try {
      const data = await overpass(q);
      if (run !== state.runId) return;
      const items = {};
      const add = (k, label, el) => {
        const geom = el.geometry || (el.lat ? [{ lat: el.lat, lon: el.lon }] : el.bounds ? [{ lat: (el.bounds.minlat + el.bounds.maxlat) / 2, lon: (el.bounds.minlon + el.bounds.maxlon) / 2 }] : null);
        const d = Geo.distToGeometry(p, geom);
        if (!items[k] || d < items[k].d) items[k] = { label, d, name: el.tags.name || el.tags.ref || '' };
      };
      for (const el of data.elements) {
        const t = el.tags || {};
        if (/^(motorway|trunk)$/.test(t.highway)) add('hwy', '🛣️ Highway / freeway (noise)', el);
        else if (/^(primary|secondary)$/.test(t.highway)) add('busy', '🚙 Busy road right next to house', el);
        else if (t.railway === 'rail') add('rail', '🚂 Railroad tracks (noise)', el);
        else if (t.power === 'line') add('power', '⚡ High-voltage power lines', el);
        else if (t.landuse === 'industrial') add('ind', '🏭 Industrial area', el);
        else if (t.landuse === 'landfill') add('fill', '🗑️ Landfill', el);
        else if (t.landuse === 'cemetery' || t.amenity === 'grave_yard') add('cem', '🪦 Cemetery', el);
        else if (t.aeroway === 'aerodrome') add('air', '🛩️ Airport / airfield (plane noise)', el);
      }
      const list = Object.values(items).sort((a, b) => a.d - b.d);
      $('#nuisances').innerHTML = list.length
        ? list.map(i => `<div class="place"><span>${i.label}${i.name ? ` <span class="muted">(${esc(i.name)})</span>` : ''}</span><span class="dist ${i.d < 300 ? 'bad-t' : ''}">${fmtMi(i.d)}</span></div>`).join('')
        : '<p class="good-t">✔ No highways, rail lines, power lines, industrial areas, cemeteries or airports found close by.</p>';
    } catch (e) {
      if (run === state.runId) $('#nuisances').innerHTML = `<p class="warn">Couldn't check (${esc(e.message)}).</p>`;
    }
  }

  // ---------- property facts ----------
  async function loadProperty(p, run) {
    loadNuisances(p, run);
    const rows = [];
    const put = () => { if (run === state.runId) $('#property').innerHTML = rows.map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join('') + roofNote(p); };
    rows.push(['County', esc(p.county || '—')]);
    put();
    const tasks = [
      fetchJSON(`https://api.open-meteo.com/v1/elevation?latitude=${p.lat}&longitude=${p.lon}`).then(r => {
        const m = r.elevation && r.elevation[0]; if (m != null) rows.push(['Elevation', `${Math.round(m * 3.28084)} ft above sea level`]);
      }).catch(() => {}),
      (p.country === 'us' || !p.country) ? fetchJSON(`https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?geometry=${p.lon},${p.lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,ZONE_SUBTY,SFHA_TF&returnGeometry=false&f=json`, {}, 20000).then(r => {
        const f = r.features && r.features[0] && r.features[0].attributes;
        if (!f) { rows.push(['Flood zone', 'No FEMA flood map data here']); return; }
        const high = f.SFHA_TF === 'T';
        rows.push(['Flood zone', `<b class="${high ? 'bad-t' : 'good-t'}">${esc(f.FLD_ZONE)}</b> ${high ? '– HIGH risk, flood insurance likely required' : '– not high-risk'}${f.ZONE_SUBTY ? `<br><span class="small muted">${esc(f.ZONE_SUBTY.toLowerCase())}</span>` : ''}`]);
      }).catch(() => rows.push(['Flood zone', `<a href="https://msc.fema.gov/portal/search?AddressQuery=${enc(p.label)}" target="_blank" rel="noopener">Check on FEMA →</a>`])) : Promise.resolve()
    ];
    await Promise.all(tasks);
    // OSM building details (if mapped)
    const b = state.estimate && state.estimate.building && state.estimate.building.tags;
    if (b) {
      if (b['building:levels']) rows.push(['Stories (OSM)', esc(b['building:levels'])]);
      if (b.start_date) rows.push(['Built (OSM)', esc(b.start_date)]);
      if (b['roof:shape']) rows.push(['Roof shape (OSM)', esc(b['roof:shape'])]);
      if (b['roof:material']) rows.push(['Roof material (OSM)', esc(b['roof:material'])]);
    }
    put();
  }

  function roofNote(p) {
    const g = q => `https://www.google.com/search?q=${enc(q)}`;
    return `<div class="roof"><b>🏚️ Roof age</b><p class="small">There's no free public database of roof replacement dates. These usually find it:</p>
      <ol class="small">
        <li><a href="${g(`"${p.label}" new roof`)}" target="_blank" rel="noopener">Search the listing for “new roof”</a> (Zillow/Redfin descriptions often say “roof 2019”).</li>
        <li><a href="${g(`${p.city} ${p.st} building permit search`)}" target="_blank" rel="noopener">City building-permit search</a>: look up the address for a “re-roof” permit.</li>
        <li><a href="${g(`buildzoom ${p.label}`)}" target="_blank" rel="noopener">BuildZoom permit history</a></li>
        <li>Ask the agent for the seller's disclosure, and have the inspector estimate it.</li>
      </ol></div>`;
  }

  // ---------- links ----------
  function renderLinks(p) {
    const g = q => `https://www.google.com/search?q=${enc(q)}`;
    const L2 = [
      ['👀 Street View (see the front door)', `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat},${p.lon}`],
      ['🏡 Zillow', `https://www.zillow.com/homes/${enc(p.label)}_rb/`],
      ['🏡 Redfin', g(`redfin ${p.label}`)],
      ['🏡 Realtor.com', g(`realtor.com ${p.label}`)],
      ['🧾 County property records / taxes', g(`${p.county} ${p.st} property appraiser search`)],
      ['🏫 School ratings (GreatSchools)', `https://www.greatschools.org/search/search.page?lat=${p.lat}&lon=${p.lon}&distance=5`],
      ['🚨 Crime map', `https://www.crimemapping.com/map/location/${enc(p.label)}`],
      ['🌊 FEMA flood map', `https://msc.fema.gov/portal/search?AddressQuery=${enc(p.label)}`],
      ['🔥 Climate risk (fire, heat, flood)', `https://riskfactor.com/search?query=${enc(p.label)}`],
      ['📶 Internet providers', `https://broadbandmap.fcc.gov/location-summary/fixed?addr=${enc(p.label)}`],
      ['🛰️ Google Earth', `https://earth.google.com/web/@${p.lat},${p.lon},100a,150d,35y,0h,45t,0r`]
    ];
    $('#links').innerHTML = L2.map(([t, u]) => `<a class="link" href="${u}" target="_blank" rel="noopener">${t}</a>`).join('');
  }

  // ---------- notes & saved ----------
  const FIELDS = ['price', 'roof', 'hoa', 'built', 'hvac', 'wh', 'notes'];
  function fillNotes(s) { FIELDS.forEach(f => $('#f-' + f).value = s[f] || ''); }
  const keyOf = p => `${(+p.lat).toFixed(4)},${(+p.lon).toFixed(4)}`;
  function findSaved(p) { return store.get('saved', []).find(s => s.key === keyOf(p) || s.label === p.label); }

  function saveHouse() {
    const p = state.place; if (!p) return;
    const list = store.get('saved', []);
    const near = k => { const x = (state.nearby[k] || [])[0]; return x ? { name: x.name, dist: x.dist, drive: x.drive } : null; };
    const rec = {
      ...p, key: keyOf(p), savedAt: Date.now(),
      bearing: state.facing ? state.facing.bearing : null, dir: state.facing ? state.facing.dir : null,
      avoid: state.facing ? state.facing.avoid : null, facingSource: state.facing ? state.facing.source : null,
      costco: near('costco'), indian: near('indian'), temple: near('temple')
    };
    FIELDS.forEach(f => rec[f] = $('#f-' + f).value.trim());
    const i = list.findIndex(s => s.key === rec.key || s.label === rec.label);
    if (i >= 0) list[i] = rec; else list.unshift(rec);
    store.set('saved', list); updateCount(); toast('Saved ⭐');
  }

  function updateCount() { const n = store.get('saved', []).length; $('#saved-count').textContent = n ? `(${n})` : ''; }

  function renderSaved() {
    const list = store.get('saved', []);
    const places = store.get('places', []);
    let html = `<div class="card"><h2>My important places</h2><p class="small muted">Add work, family, etc. Drive time from each house will show under “Nearby”.</p>
      ${places.map((x, i) => `<div class="place"><span><b>${esc(x.label)}</b> – ${esc(x.address)}</span><button class="btn tiny" data-delplace="${i}">✕</button></div>`).join('')}
      <form id="place-form" class="grid2"><input id="pl-label" placeholder="Name (e.g. Work)" required><input id="pl-addr" placeholder="Address" required>
      <button class="btn wide" style="grid-column:1/-1">+ Add place</button></form></div>`;
    if (!list.length) html += '<div class="card"><p class="muted">No saved houses yet. Check a house and tap “Save this house”.</p></div>';
    const sorted = [...list].sort((a, b) => (a.avoid === b.avoid ? 0 : a.avoid ? 1 : -1));
    html += sorted.map(s => {
      const idx = list.indexOf(s);
      const badge = s.dir ? `<span class="badge ${s.avoid ? 'bad' : 'good'} sm">${s.avoid ? '✖' : '✔'} ${s.dir}</span>` : '<span class="badge sm">?</span>';
      const d = x => x ? (x.drive && x.drive.s != null ? fmtMin(x.drive.s) : fmtMi(x.dist)) : '—';
      return `<div class="card saved ${s.avoid ? 'dim' : ''}">
        <div class="saved-top">${badge}<b>${esc(s.label)}</b></div>
        <div class="chips">${s.price ? `<span>💲${esc(s.price)}</span>` : ''}${s.roof ? `<span>🏚️ Roof ${esc(s.roof)}</span>` : ''}${s.built ? `<span>🧱 ${esc(s.built)}</span>` : ''}${s.hoa ? `<span>HOA ${esc(s.hoa)}</span>` : ''}
          <span>🛒 Costco ${d(s.costco)}</span><span>🍛 ${s.indian ? esc(s.indian.name) + ' ' + d(s.indian) : '—'}</span></div>
        ${s.notes ? `<p class="small">${esc(s.notes)}</p>` : ''}
        <div class="row"><button class="btn" data-open="${idx}">Open</button><button class="btn danger" data-del="${idx}">Delete</button></div></div>`;
    }).join('');
    $('#saved-list').innerHTML = html;
    $('#saved-list').querySelectorAll('[data-open]').forEach(b => b.onclick = () => { const s = list[+b.dataset.open]; showView('view-search'); $('#addr').value = s.label; analyze(s, s); });
    $('#saved-list').querySelectorAll('[data-del]').forEach(b => b.onclick = () => { if (!confirm('Delete this house?')) return; list.splice(+b.dataset.del, 1); store.set('saved', list); updateCount(); renderSaved(); });
    $('#saved-list').querySelectorAll('[data-delplace]').forEach(b => b.onclick = () => { places.splice(+b.dataset.delplace, 1); store.set('places', places); renderSaved(); });
    $('#place-form').onsubmit = async e => {
      e.preventDefault();
      const label = $('#pl-label').value.trim(), address = $('#pl-addr').value.trim();
      try {
        const r = await geocode(address); if (!r.length) return toast('Address not found');
        places.push({ label, address, lat: +r[0].lat, lon: +r[0].lon }); store.set('places', places); renderSaved(); toast('Place added');
      } catch { toast('Lookup failed, try again'); }
    };
  }

  // ---------- init ----------
  function init() {
    $('#search-form').addEventListener('submit', onSearch);
    $('#btn-gps').onclick = onGPS;
    $('#btn-compass').onclick = startCompass;
    $('#btn-lock').onclick = lockCompass;
    $('#btn-save').onclick = saveHouse;
    $('#declination').value = store.get('decl', 0);
    $('#declination').onchange = () => store.set('decl', decl());
    document.querySelectorAll('.tabbar button').forEach(b => b.onclick = () => showView(b.dataset.view));
    $('#manual-dirs').innerHTML = Geo.DIRS.map(d => `<button type="button" class="btn ${['S', 'SE', 'SW'].includes(d) ? 'danger' : ''}" data-dir="${d}">${d}</button>`).join('');
    $('#manual-dirs').querySelectorAll('button').forEach(b => b.onclick = () => { setFacing(Geo.DIR_CENTER[b.dataset.dir], 'manual'); $('#card-header').scrollIntoView({ behavior: 'smooth' }); });
    updateCount();
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  init();
})();

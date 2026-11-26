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

  const state = { place: null, facing: null, estimate: null, nearby: {}, custom: {}, map: null, layers: {}, runId: 0 };

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

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // The free Overpass servers reject (429/504) when one phone sends many queries at once,
  // so queries go through a queue (max 2 at a time) and each one retries across mirrors.
  const ovq = { active: 0, waiting: [] };
  function overpass(query) {
    return new Promise((resolve, reject) => { ovq.waiting.push({ query, resolve, reject }); pumpOverpass(); });
  }
  function pumpOverpass() {
    while (ovq.active < 2 && ovq.waiting.length) {
      const job = ovq.waiting.shift(); ovq.active++;
      overpassRun(job.query).then(job.resolve, job.reject).finally(() => { ovq.active--; pumpOverpass(); });
    }
  }
  async function overpassRun(query) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const url of OVERPASS) {
        try {
          const data = await fetchJSON(url, { method: 'POST', body: 'data=' + enc(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 45000);
          if (data.remark && /error|timed out|out of memory/i.test(data.remark)) throw new Error('server timeout');
          return data;
        } catch (e) { lastErr = e; }
      }
      await sleep(2500 * (attempt + 1));
    }
    const m = lastErr && lastErr.name === 'AbortError' ? 'timed out' : (lastErr ? lastErr.message : 'unknown error');
    throw new Error(`map data servers are busy: ${m}`);
  }

  const geocode = q => fetchJSON(`${NOMINATIM}/search?format=jsonv2&addressdetails=1&limit=5&q=${enc(q)}`);
  const reverse = (lat, lon) => fetchJSON(`${NOMINATIM}/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${lat}&lon=${lon}`);

  function placeFromNominatim(r) {
    const a = r.address || {};
    const street = a.road || a.pedestrian || a.residential || '';
    const line1 = [a.house_number, street].filter(Boolean).join(' ');
    const city = a.city || a.town || a.village || a.hamlet || a.suburb || '';
    const label = [line1, city, a.state, a.postcode].filter(Boolean).join(', ') || r.display_name;
    return { lat: +r.lat, lon: +r.lon, label, street, num: a.house_number || '', city, county: a.county || '', st: a.state || '', zip: a.postcode || '', country: a.country_code || '', display: r.display_name };
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
    ['#nearby', '#nuisances', '#property', '#roof'].forEach(s => $(s).innerHTML = '<div class="loading">Loading…</div>');
    fillNotes(saved || findSaved(place) || {});
    renderLinks(place);
    initMap(place);
    setTimeout(() => $('#card-header').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);

    // facing direction first (most important). Map-data queries are queued in this order.
    const facingP = runFacing(place, run);
    loadNuisances(place, run);
    loadNearby(place, run);
    loadProperty(place, run);
    loadRoof(place, run);
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

    $('#verdict').innerHTML = (c.avoid
      ? `<div class="badge bad">✖ ${c.name} facing – avoid</div>`
      : `<div class="badge good">✔ ${c.name} facing – OK</div>`) +
      `<p class="exit-line">🚪 Walking out the front door, you face <b>${c.name}</b>.</p>`;
    if (c.nearBoundary) $('#verdict').innerHTML += `<p class="warn small">⚠️ This is within ${Math.round(c.edgeDist)}° of the ${c.avoid ? 'OK' : 'avoid'} zone. Double-check with the compass at the front door.</p>`;
    if (conf && conf !== 'high') $('#verdict').innerHTML += `<p class="warn small">⚠️ Map confidence is ${conf}. Confirm with the compass or Street View.</p>`;

    let html = `<div class="small muted">Direction you face stepping out the front door</div>
      <div class="big-dir">${c.dir} <span>${Math.round(c.bearing)}°</span></div>
      <div class="small">${srcText}${conf ? ` · confidence: <b>${conf}</b>` : ''}</div>
      <div class="small">Stepping out the back door you face <b>${backDir.name}</b></div>`;
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
      L.circleMarker(end, { radius: 7, color, fillColor: color, fillOpacity: 1 }).bindTooltip(`Out the front door: ${state.facing.dir}`, { permanent: true, direction: 'top' })
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
    { key: 'indian', label: 'Indian grocery', icon: '🍛', r: 40000, group: 'indian', q: [`nwr["shop"~"^(supermarket|convenience|grocery|greengrocer|deli|food|spices|general)$"]["name"~"${INDIAN_NAME}",i]`, 'nwr["shop"]["cuisine"~"indian",i]', 'nwr["shop"]["origin"~"india",i]'],
      test: t => !!t.shop && /^(supermarket|convenience|grocery|greengrocer|deli|food|spices|general|variety_store)$/.test(t.shop) && (new RegExp(INDIAN_NAME, 'i').test(t.name || '') || /indian/i.test(t.cuisine || '') || /india/i.test(t.origin || '')) },
    { key: 'temple', label: 'Hindu temple', icon: '🛕', r: 50000, q: ['nwr["amenity"="place_of_worship"]["religion"="hindu"]'], test: t => t.religion === 'hindu' },
    { key: 'indianfood', label: 'Indian restaurant', icon: '🥘', r: 25000, group: 'indian', q: ['nwr["amenity"~"^(restaurant|fast_food)$"]["cuisine"~"indian",i]'], test: t => /^(restaurant|fast_food)$/.test(t.amenity || '') && /indian/i.test(t.cuisine || '') },
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

  // ---------- custom "also look for" searches ----------
  // Uses Nominatim, which understands both names ("Patel Brothers") and kinds of place ("mosque").
  // Nominatim allows ~1 request per second, so these run one after another.
  const customTerms = () => store.get('custom', []);
  let nomChain = Promise.resolve();
  function nominatimQueued(url) {
    const job = nomChain.then(() => fetchJSON(url, {}, 20000));
    nomChain = job.catch(() => {}).then(() => sleep(1100));
    return job;
  }
  async function searchCustom(term, p) {
    const d = 0.45; // ~30 mile box around the house
    const vb = [p.lon - d / Math.cos(p.lat * Math.PI / 180), p.lat + d, p.lon + d / Math.cos(p.lat * Math.PI / 180), p.lat - d].map(v => v.toFixed(5)).join(',');
    const r = await nominatimQueued(`${NOMINATIM}/search?format=jsonv2&limit=20&bounded=1&viewbox=${vb}&q=${enc(term)}`);
    const seen = [];
    return r.map(x => ({ name: x.name || x.display_name.split(',')[0], addr: x.display_name.split(',').slice(1, 3).join(',').trim(), lat: +x.lat, lon: +x.lon, dist: Geo.haversine(p, { lat: +x.lat, lon: +x.lon }) }))
      .sort((a, b) => a.dist - b.dist)
      .filter(x => { if (seen.some(s => Geo.haversine(s, x) < 150)) return false; seen.push(x); return true; });
  }
  async function loadCustom(p, run, terms) {
    await Promise.all(terms.map(t => searchCustom(t, p)
      .then(list => { if (run === state.runId) state.custom[t] = { list }; })
      .catch(e => { if (run === state.runId) state.custom[t] = { list: [], error: e.message }; })));
  }

  function renderCustomChips() {
    const terms = customTerms();
    $('#custom-count').textContent = terms.length ? `(${terms.length})` : '';
    $('#custom-chips').innerHTML = terms.map((t, i) => `<button type="button" class="chip" data-i="${i}">${esc(t)} ✕</button>`).join('');
    $('#custom-chips').querySelectorAll('button').forEach(b => b.onclick = () => {
      const list = customTerms(); const [gone] = list.splice(+b.dataset.i, 1); store.set('custom', list);
      delete state.custom[gone]; renderCustomChips(); if (state.place && state.nearbyDone) renderNearby(state.place);
    });
  }
  async function addCustomTerm() {
    const t = $('#custom-term').value.trim(); if (!t) return;
    const list = customTerms();
    if (list.some(x => x.toLowerCase() === t.toLowerCase())) return toast('Already in your list');
    list.push(t); store.set('custom', list); $('#custom-term').value = ''; renderCustomChips(); toast(`Will look for “${t}” near every house`);
    if (state.place) {
      const p = state.place, run = state.runId;
      state.custom[t] = { loading: true };
      if (state.nearbyDone) renderNearby(p);
      await loadCustom(p, run, [t]);
      if (run !== state.runId || !state.nearbyDone) return; // a running nearby search will render it
      renderNearby(p); addDriveTimes(p, run);
    }
  }

  async function loadNearby(p, run) {
    const groups = [CATS.filter(c => c.group === 'indian'), CATS.filter(c => !c.group && c.r > 20000), CATS.filter(c => !c.group && c.r <= 20000)];
    const results = {};
    state.custom = {}; state.nearbyDone = false;
    const collect = (data, cats) => {
      for (const el of data.elements) {
        const t = el.tags || {}; const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
        if (lat == null) continue;
        const d = Geo.haversine(p, { lat, lon });
        for (const c of cats) if (d <= c.r && c.test(t)) (results[c.key] ||= []).push({ name: t.name || t.brand || c.label, tags: t, lat, lon, dist: d });
      }
    };
    const failed = [];
    const customP = loadCustom(p, run, customTerms());
    await Promise.all(groups.map(g => overpass(catQuery(g, p)).then(d => collect(d, g)).catch(() => failed.push(...g.map(c => c.key)))));
    await customP;
    if (run !== state.runId) return;
    for (const k in results) {
      // de-dup (same place mapped as node + building)
      const seen = []; results[k] = results[k].sort((a, b) => a.dist - b.dist).filter(x => { if (seen.some(s => s.name === x.name && Geo.haversine(s, x) < 300)) return false; seen.push(x); return true; });
    }
    state.nearby = results; state.nearbyFailed = new Set(failed); state.nearbyDone = true;
    state.myPlaces = store.get('places', []).filter(x => x.lat).map(x => ({ ...x }));
    renderNearby(p);
    await addDriveTimes(p, run);
  }

  async function addDriveTimes(p, run) {
    const targets = [];
    for (const c of CATS) (state.nearby[c.key] || []).slice(0, c.show || 1).forEach(x => targets.push(x));
    for (const t in state.custom) (state.custom[t].list || []).slice(0, 2).forEach(x => targets.push(x));
    (state.myPlaces || []).forEach(x => targets.push(x));
    const todo = targets.filter(x => !x.drive);
    if (!todo.length) return;
    try {
      const coords = [p, ...todo].map(x => `${x.lon.toFixed(6)},${x.lat.toFixed(6)}`).join(';');
      const r = await fetchJSON(`${OSRM}/table/v1/driving/${coords}?sources=0&annotations=duration,distance`, {}, 20000);
      if (run !== state.runId || r.code !== 'Ok') return;
      todo.forEach((t, i) => { t.drive = { s: r.durations[0][i + 1], m: r.distances[0][i + 1] }; });
      renderNearby(p);
    } catch { /* straight-line distances already shown */ }
  }

  function renderNearby(p) {
    const failedKeys = state.nearbyFailed || new Set();
    const myPlaces = state.myPlaces;
    const gmaps = (q) => `https://www.google.com/maps/search/${enc(q)}/@${p.lat},${p.lon},12z`;
    const dirLink = x => `https://www.google.com/maps/dir/?api=1&origin=${p.lat},${p.lon}&destination=${x.lat},${x.lon}`;
    const line = x => `<div class="place"><a href="${dirLink(x)}" target="_blank" rel="noopener">${esc(x.name)}</a>
        <span class="dist">${x.drive && x.drive.s != null ? `🚗 ${fmtMi(x.drive.m)} · ${fmtMin(x.drive.s)}` : `${fmtMi(x.dist)} straight-line`}</span></div>`;
    let html = failedKeys.size ? `<p class="warn">Some categories couldn't load because the free map servers are busy. <button type="button" class="btn tiny" id="retry-nearby">Retry</button></p>` : '';
    for (const t of customTerms()) {
      const r = state.custom[t];
      html += `<div class="cat"><div class="cat-h">🔎 ${esc(t)}</div>`;
      if (!r || r.loading) html += '<div class="loading">Searching…</div>';
      else if (r.error) html += `<div class="warn small">Search failed (${esc(r.error)}).</div>`;
      else html += r.list.length ? r.list.slice(0, 2).map(x => line({ ...x, name: x.name + (x.addr ? ` (${x.addr})` : '') })).join('') : '<div class="muted small">Nothing found within ~30 mi on OpenStreetMap.</div>';
      html += `<div class="small"><a href="${gmaps(t)}" target="_blank" rel="noopener">Search “${esc(t)}” on Google Maps →</a></div></div>`;
    }
    if (myPlaces && myPlaces.length) {
      html += `<div class="cat"><div class="cat-h">⭐ My places</div>${myPlaces.map(x => line({ ...x, name: x.label + ' – ' + x.address })).join('')}</div>`;
    }
    for (const c of CATS) {
      const list = state.nearby[c.key] || [];
      html += `<div class="cat"><div class="cat-h">${c.icon} ${c.label}</div>`;
      html += list.length ? list.slice(0, c.show || 1).map(line).join('')
        : failedKeys.has(c.key) ? '<div class="warn small">Couldn’t load (server busy).</div>'
        : `<div class="muted small">None found within ${Math.round(miles(c.r))} mi on OpenStreetMap.</div>`;
      if (c.key === 'indian') html += `<div class="small">OpenStreetMap misses many Indian stores. <a href="${gmaps('indian grocery store')}" target="_blank" rel="noopener">Search Google Maps →</a></div>`;
      if (c.key === 'temple') html += `<div class="small"><a href="${gmaps('hindu temple')}" target="_blank" rel="noopener">Search Google Maps →</a></div>`;
      if (c.key === 'costco' && !list.length) html += `<div class="small"><a href="https://www.costco.com/warehouse-locations" target="_blank" rel="noopener">Costco warehouse locator →</a></div>`;
      html += '</div>';
    }
    $('#nearby').innerHTML = html;
    const rb = $('#retry-nearby');
    if (rb) rb.onclick = () => { $('#nearby').innerHTML = '<div class="loading">Retrying…</div>'; loadNearby(p, state.runId); };
  }

  // ---------- nuisances ----------
  async function loadNuisances(p, run) {
    const a = `${p.lat},${p.lon}`;
    // Lines near the house: geometry clipped to a ~1.2 km box keeps the response small.
    const dLat = 0.011, dLon = 0.011 / Math.cos(p.lat * Math.PI / 180);
    const clip = [p.lat - dLat, p.lon - dLon, p.lat + dLat, p.lon + dLon].map(v => v.toFixed(5)).join(',');
    const qLines = `[out:json][timeout:25];(
      way["highway"~"^(motorway|trunk)$"](around:1000,${a});
      way["railway"="rail"](around:1000,${a});
      way["power"="line"](around:400,${a});
      way["landuse"="industrial"](around:600,${a});
      way["highway"~"^(primary|secondary)$"](around:120,${a});
    );out tags geom(${clip});`;
    // Big areas (airports, cemeteries, landfills) only need a bounding box, not their full outline.
    const qAreas = `[out:json][timeout:25];(
      nwr["landuse"="landfill"](around:3000,${a});
      nwr["landuse"="cemetery"](around:1000,${a});
      nwr["amenity"="grave_yard"](around:1000,${a});
      nwr["aeroway"="aerodrome"](around:8000,${a});
    );out tags bb;`;
    const box = $('#nuisances');
    try {
      const results = await Promise.allSettled([overpass(qLines), overpass(qAreas)]);
      if (run !== state.runId) return;
      if (results.every(r => r.status === 'rejected')) throw results[0].reason;
      const elements = results.flatMap(r => r.status === 'fulfilled' ? r.value.elements : []);
      const partial = results.some(r => r.status === 'rejected');
      const items = {};
      const add = (k, label, el) => {
        let d;
        if (el.geometry) d = Geo.distToGeometry(p, el.geometry.filter(Boolean));
        else if (el.bounds) { // distance to the bounding box (0 if the house is inside it)
          const b = el.bounds, cl = { lat: Math.min(Math.max(p.lat, b.minlat), b.maxlat), lon: Math.min(Math.max(p.lon, b.minlon), b.maxlon) };
          d = Geo.haversine(p, cl);
        } else if (el.lat != null) d = Geo.haversine(p, el);
        if (d == null || !isFinite(d)) return;
        if (!items[k] || d < items[k].d) items[k] = { label, d, name: el.tags.name || el.tags.ref || '' };
      };
      const data = { elements };
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
      box.innerHTML = (list.length
        ? list.map(i => `<div class="place"><span>${i.label}${i.name ? ` <span class="muted">(${esc(i.name)})</span>` : ''}</span><span class="dist ${i.d < 300 ? 'bad-t' : ''}">${fmtMi(i.d)}</span></div>`).join('')
        : '<p class="good-t">✔ No highways, rail lines, power lines, industrial areas, cemeteries or airports found close by.</p>')
        + (partial ? '<p class="warn small">Part of this check didn’t load. <button type="button" class="btn tiny" id="retry-nuis">Retry</button></p>' : '');
    } catch (e) {
      if (run !== state.runId) return;
      box.innerHTML = `<p class="warn">Couldn't check right now (${esc(e.message)}). <button type="button" class="btn tiny" id="retry-nuis">Retry</button></p>`;
    }
    const rb = $('#retry-nuis');
    if (rb) rb.onclick = () => { box.innerHTML = '<div class="loading">Retrying…</div>'; loadNuisances(p, state.runId); };
  }

  // ---------- property facts ----------
  async function loadProperty(p, run) {
    const rows = [];
    const put = () => { if (run === state.runId) $('#property').innerHTML = rows.map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join(''); };
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

  // ---------- roof age: search public building-permit records ----------
  // Many cities and counties publish permits as open data on Socrata or ArcGIS. Both allow
  // browser requests, so the app can search them directly for permits at this address.
  const ROOF_RE = /re-?roof|shingle|tear[- ]?off|\broof(ing)?\b/i;
  const NOT_ROOF_RE = /solar|photovoltaic|\bpv\b|roof ?top unit|\brtu\b|antenna|cell tower/i;
  const DIRWORDS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest']);
  const U = v => String(v ?? '').toUpperCase();

  function addrParts(p) {
    const num = (p.num || (p.label.match(/^\s*(\d+[A-Za-z]?)\s/) || [])[1] || '').toUpperCase();
    const words = (p.street || '').split(/\s+/).filter(w => w && !DIRWORDS.has(w.toLowerCase()));
    return { num, core: U(words[0] || '').replace(/'/g, '') };
  }

  function rowToPermit(row, dateFields, source) {
    const flat = Object.entries(row).map(([k, v]) => [k, v && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')]);
    const text = flat.map(([, v]) => v).join(' | ');
    const descKeys = flat.filter(([k, v]) => /desc|work|scope|type|purpose|class|comment|subtype/i.test(k) && v && !/^\d+(\.\d+)?$/.test(v) && v.length < 400);
    const desc = [...new Set(descKeys.map(([, v]) => v.trim()))].join(' · ').slice(0, 200);
    let date = null;
    const pick = re => dateFields.filter(k => re.test(k)).map(k => row[k]).find(v => v != null && v !== '');
    const raw = pick(/issue/i) ?? pick(/appl|file|submit|open/i) ?? pick(/final|complete|close/i) ?? dateFields.map(k => row[k]).find(v => v != null && v !== '');
    if (raw != null) { const d = new Date(typeof raw === 'number' ? raw : String(raw)); if (!isNaN(d)) date = d; }
    const roof = ROOF_RE.test(text) && !NOT_ROOF_RE.test(desc || text);
    return { date, desc: desc || '(no description)', roof, source };
  }

  async function socrataPermits(p, parts, onSource) {
    const placeNames = [p.city, (p.county || '').replace(/ county$/i, '')].filter(Boolean).map(s => s.toLowerCase());
    if (!placeNames.length) return [];
    const cat = await fetchJSON(`https://api.us.socrata.com/api/catalog/v1?only=dataset&limit=30&q=${enc('building permits ' + (p.city || p.county))}`, {}, 15000);
    const sets = (cat.results || []).filter(r => {
      const hay = `${r.resource.name} ${r.resource.description || ''} ${r.metadata.domain} ${JSON.stringify(r.classification?.domain_metadata || [])}`.toLowerCase().replace(/[^a-z ]/g, '');
      return /permit/i.test(r.resource.name) && !/solar|right of way|sign|film|event|tree|food|alcohol|parking/i.test(r.resource.name)
        && placeNames.some(n => hay.includes(n) || hay.replace(/ /g, '').includes(n.replace(/[^a-z]/g, '')));
    }).slice(0, 4);
    const out = [];
    await Promise.all(sets.map(async s => {
      const src = `${s.resource.name} (${s.metadata.domain})`;
      try {
        const rows = await fetchJSON(`https://${s.metadata.domain}/resource/${s.resource.id}.json?$limit=300&$q=${enc(parts.num + ' ' + parts.core)}`, {}, 20000);
        onSource(src);
        const dateFields = (s.resource.columns_datatype || []).map((t, i) => /date|calendar/i.test(t) ? s.resource.columns_field_name[i] : null).filter(Boolean);
        for (const row of rows) {
          const vals = Object.values(row).map(v => U(v && typeof v === 'object' ? JSON.stringify(v) : v));
          const hit = vals.some(v => (v.startsWith(parts.num + ' ') || v.includes(`"${parts.num} `)) && v.includes(parts.core)) ||
            (vals.some(v => v.trim() === parts.num) && vals.some(v => v.includes(parts.core)));
          if (hit) out.push(rowToPermit(row, dateFields.length ? dateFields : Object.keys(row).filter(k => /date/i.test(k)), src));
        }
      } catch { /* this dataset failed; others may still work */ }
    }));
    return out;
  }

  async function arcgisPermits(p, parts, onSource) {
    const d = 0.002, bbox = [p.lon - d, p.lat - d, p.lon + d, p.lat + d].join(',');
    const s = await fetchJSON(`https://www.arcgis.com/sharing/rest/search?f=json&num=40&sortField=numViews&sortOrder=desc&bbox=${bbox}&q=${enc('permit type:"Feature Service"')}`, {}, 15000);
    const items = (s.results || []).filter(r => r.url && /permit/i.test(r.title) && !/solar|right.of.way|\brow\b|sign|film|event|tree|food|alcohol|parking|street use|encroach|well|septic|oil|gas well/i.test(r.title)).slice(0, 4);
    const out = [];
    const sqlEsc = v => v.replace(/'/g, "''");
    await Promise.all(items.map(async it => {
      try {
        let layers = [];
        if (/\/\d+\/?$/.test(it.url)) layers = [it.url.replace(/\/$/, '')];
        else {
          const svc = await fetchJSON(`${it.url}?f=json`, {}, 15000);
          const ls = [...(svc.layers || []), ...(svc.tables || [])];
          const pref = ls.filter(l => /permit/i.test(l.name));
          layers = (pref.length ? pref : ls).slice(0, 2).map(l => `${it.url.replace(/\/$/, '')}/${l.id}`);
        }
        for (const lu of layers) {
          const info = await fetchJSON(`${lu}?f=json`, {}, 15000);
          const fields = info.fields || [];
          const addrF = fields.filter(f => f.type === 'esriFieldTypeString' && /addr|location|site|full_?add|street/i.test(f.name) && !/city|zip|state|unit|apt|parcel|owner|contractor|mail|applicant|name$/i.test(f.name))
            .sort((a, b) => (/addr/i.test(b.name) ? 1 : 0) - (/addr/i.test(a.name) ? 1 : 0))[0];
          if (!addrF) continue;
          const where = `UPPER(${addrF.name}) LIKE '${sqlEsc(parts.num)} %' AND UPPER(${addrF.name}) LIKE '%${sqlEsc(parts.core)}%'`;
          const r = await fetchJSON(`${lu}/query?f=json&outFields=*&returnGeometry=false&where=${enc(where)}`, {}, 20000);
          const src = `${it.title} (${it.owner})`;
          onSource(src);
          const dateFields = fields.filter(f => f.type === 'esriFieldTypeDate').map(f => f.name);
          for (const f of r.features || []) out.push(rowToPermit(f.attributes, dateFields, src));
        }
      } catch { /* skip broken services */ }
    }));
    return out;
  }

  async function loadRoof(p, run) {
    const box = $('#roof');
    const parts = addrParts(p);
    const g = q => `https://www.google.com/search?q=${enc(q)}`;
    const links = `<div class="roof"><p class="small"><b>Also check the listing.</b> Zillow and Redfin block other apps from reading their pages, so open the listing and search the page for “roof”:</p>
      <div class="small">
        <a class="link" href="https://www.zillow.com/homes/${enc(p.label)}_rb/" target="_blank" rel="noopener">🏡 Zillow listing for this address</a>
        <a class="link" href="${g(`redfin ${p.label}`)}" target="_blank" rel="noopener">🏡 Redfin listing</a>
        <a class="link" href="${g(`"${p.num ? p.num + ' ' : ''}${p.street}" ${p.city} roof`)}" target="_blank" rel="noopener">🔎 Google: this address + “roof”</a>
        <a class="link" href="${g(`buildzoom ${p.label}`)}" target="_blank" rel="noopener">🧾 BuildZoom permit history</a>
        <a class="link" href="${g(`${p.city || p.county} ${p.st} building permit search by address`)}" target="_blank" rel="noopener">🏛️ City permit search website</a>
      </div><p class="small muted">The seller's disclosure and your home inspector are the final word on roof age.</p></div>`;
    if (!parts.num || !parts.core) {
      box.innerHTML = `<p class="small muted">Need a full street address (with house number) to search permit records.</p>${links}`;
      return;
    }
    const sources = new Set();
    const progress = () => { if (run === state.runId) box.innerHTML = `<div class="loading">Searching public permit records${sources.size ? ` (${sources.size} source${sources.size > 1 ? 's' : ''} checked)` : ''}…</div>`; };
    progress();
    const onSource = s => { sources.add(s); progress(); };
    const res = await Promise.allSettled([socrataPermits(p, parts, onSource), arcgisPermits(p, parts, onSource)]);
    if (run !== state.runId) return;
    const seen = new Set();
    const permits = res.flatMap(r => r.status === 'fulfilled' ? r.value : [])
      .filter(x => { const k = (x.date ? x.date.toISOString().slice(0, 10) : '') + x.desc; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => (b.date || 0) - (a.date || 0));
    const roofs = permits.filter(x => x.roof);
    const fmtD = d => d ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'date unknown';
    const row = x => `<div class="permit"><b>${fmtD(x.date)}</b> – ${esc(x.desc)}<div class="small muted">${esc(x.source)}</div></div>`;
    let html = '';
    if (roofs.length) {
      const y = roofs.find(x => x.date)?.date.getFullYear();
      html += `<p class="good-t"><b>✔ Roof permit found${y ? `: ${y} (${new Date().getFullYear() - y} years ago)` : ''}</b></p>${roofs.slice(0, 4).map(row).join('')}`;
      if (y && !$('#f-roof').value) { $('#f-roof').value = String(y); }
    } else if (sources.size) {
      html += `<p><b>No roof permit on file.</b> <span class="small">Checked ${sources.size} public permit source${sources.size > 1 ? 's' : ''}${permits.length ? `, found ${permits.length} other permit${permits.length > 1 ? 's' : ''} at this address` : ' and found no permits at this address'}. The roof may be original, done before records went online, or done without a permit.</span></p>`;
    } else {
      html += `<p class="small"><b>This city or county doesn't publish permits in a form the app can search</b>${res.every(r => r.status === 'rejected') ? ' (or the permit search services didn’t respond)' : ''}. Use the links below.</p>`;
    }
    const others = permits.filter(x => !x.roof);
    if (others.length) html += `<details class="howto"><summary>Other permits at this address (${others.length}) – HVAC, water heater, remodels…</summary>${others.slice(0, 15).map(row).join('')}</details>`;
    if (sources.size) html += `<details class="howto"><summary class="small">Sources searched</summary><ul class="small">${[...sources].map(s => `<li>${esc(s)}</li>`).join('')}</ul></details>`;
    box.innerHTML = html + links;
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
    $('#btn-custom-add').onclick = addCustomTerm;
    // Enter in this box adds the term instead of submitting the address search.
    $('#custom-term').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addCustomTerm(); } });
    renderCustomChips();
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

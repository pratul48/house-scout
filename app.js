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

  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
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
  function overpass(query, run) {
    return new Promise((resolve, reject) => { ovq.waiting.push({ query, run, resolve, reject }); pumpOverpass(); });
  }
  function pumpOverpass() {
    while (ovq.active < 2 && ovq.waiting.length) {
      const job = ovq.waiting.shift();
      if (job.run != null && job.run !== state.runId) { job.reject(new Error('cancelled')); continue; } // user moved to another house
      ovq.active++;
      overpassRun(job.query).then(job.resolve, job.reject).finally(() => { ovq.active--; pumpOverpass(); });
    }
  }
  async function overpassRun(query) {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const url of OVERPASS) {
        try {
          const data = await fetchJSON(url, { method: 'POST', body: 'data=' + enc(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 20000);
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
  // Ohio addresses go to the state's LBRS locator first: it matches field-verified address points
  // (the actual house), not an estimate along the street like general geocoders.
  const LBRS = 'https://maps.ohio.gov/arcgis/rest/services/LBRSLocator2023/GeocodeServer';
  let suggestTimer = null, suggestSeq = 0;
  function onAddrInput() {
    clearTimeout(suggestTimer);
    const q = $('#addr').value.trim(), box = $('#suggest');
    if (q.length < 5 || !/\d/.test(q)) { box.innerHTML = ''; return; }
    suggestTimer = setTimeout(async () => {
      const seq = ++suggestSeq;
      try {
        const j = await fetchJSON(`${LBRS}/suggest?text=${enc(q)}&maxSuggestions=5&f=json`, {}, 8000);
        if (seq !== suggestSeq) return;
        box.innerHTML = (j.suggestions || []).map((s, i) => `<button type="button" class="sugg" data-i="${i}">${esc(Ohio.title(s.text).replace(/, Oh,/, ', OH'))}</button>`).join('');
        box.querySelectorAll('.sugg').forEach(b => b.onclick = () => { const s = j.suggestions[+b.dataset.i]; $('#addr').value = Ohio.title(s.text).replace(/, Oh,/, ', OH'); box.innerHTML = ''; onSearch(null, s.magicKey); });
      } catch { box.innerHTML = ''; }
    }, 300);
  }

  async function onSearch(e, magicKey) {
    if (e) e.preventDefault();
    $('#suggest').innerHTML = '';
    const q = $('#addr').value.trim(); if (!q) return;
    const box = $('#search-results'); box.innerHTML = '<div class="loading">Finding address…</div>';
    try {
      let oh = [];
      try { oh = await Ohio.geocode(q, magicKey); } catch { /* state locator down: fall back */ }
      if (oh.length) {
        const exact = oh.filter(c => c.exact);
        const list = exact.length ? exact : oh;
        if (list.length === 1 || list[0].score - list[1].score >= 3) { box.innerHTML = ''; return analyze(list[0]); }
        box.innerHTML = '<p class="small muted">Which one?</p>' + list.map((r, i) => `<button class="btn wide pick" data-i="${i}">${esc(r.label)}</button>`).join('');
        box.querySelectorAll('.pick').forEach(b => b.onclick = () => { box.innerHTML = ''; analyze(list[+b.dataset.i]); });
        return;
      }
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
      try { const r = await reverse(lat, lon); box.innerHTML = ''; const p = placeFromNominatim(r); p.lat = lat; p.lon = lon; $('#addr').value = p.label; analyze(p, null, 'gps'); }
      catch { box.innerHTML = ''; analyze({ lat, lon, label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, street: '' }, null, 'gps'); }
    }, err => { box.innerHTML = `<p class="warn">Couldn't get location: ${esc(err.message)}</p>`; }, { enableHighAccuracy: true, timeout: 15000 });
  }

  // ---------- main analysis ----------
  async function analyze(place, saved, how) {
    const run = ++state.runId;
    state.place = place; state.facing = null; state.estimate = null; state.nearby = {};
    $('#results').hidden = false;
    $('#addr-title').textContent = place.label;
    $('#verdict').innerHTML = '<div class="loading">Working out which way the house faces…</div>';
    $('#facing-info').innerHTML = ''; renderDial(null);
    ['#nearby', '#nuisances', '#property', '#value', '#roof', '#daycare'].forEach(s => $(s).innerHTML = '<div class="loading">Loading…</div>');
    fillNotes(saved && saved.notes);
    state.rec = null; renderHeaderTools();
    const prev = await recordSearch(place, how).catch(() => null);
    if (run !== state.runId) return;
    if (!saved && prev) saved = prev;
    renderLinks(place);
    initMap(place);
    setTimeout(() => $('#card-header').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);

    // Facing direction first (most important). Roof, property and daycare need the house outline/lot from it.
    state.parcel = null; state.floodHigh = null; state.floodZone = null; state.district = null;
    const facingP = runFacing(place, run).catch(() => null);
    loadNuisances(place, run);
    loadNearby(place, run);
    const est = await facingP;
    if (run !== state.runId) return;
    // keep a compass reading or manual choice made on an earlier visit
    if (saved && saved.facing && saved.facing.source && saved.facing.source !== 'map') setFacing(saved.facing.bearing, saved.facing.source);
    const propP = loadProperty(place, run);
    loadRoof(place, run, est);
    loadValue(place, run, est);
    loadDaycare(place, run, est, propP);
  }

  async function osmWays(point) {
    const q = `[out:json][timeout:25];(way["building"](around:70,${point.lat},${point.lon});way["highway"](around:220,${point.lat},${point.lon}););out tags geom;`;
    const data = await overpass(q, state.runId);
    const ways = data.elements.filter(e => e.type === 'way');
    return { buildings: ways.filter(w => w.tags.building), roads: ways.filter(w => w.tags.highway) };
  }

  /**
   * Which way the house faces. In Ohio this uses official data:
   *  the state's field-verified address point, the county lot outline, FEMA building outlines and the state street centerlines.
   * Elsewhere (or if those fail) it uses OpenStreetMap.
   * `tapped` = the user tapped a roof on the map: use that point and ignore the lot from the address.
   */
  async function runFacing(point, run, tapped) {
    const ohio = Ohio.inOhio(point);
    state.ohio = ohio;
    let buildings = [], roads = [], parcel = null, srcB = 'OpenStreetMap', srcR = 'OpenStreetMap';
    const errs = [];
    if (ohio) {
      const [pr, br, sr, ar] = await Promise.allSettled([Ohio.parcel(point, tapped ? null : state.place.num), Ohio.buildings(point), Ohio.streets(point), tapped ? Promise.resolve(null) : Ohio.addressPoint(point)]);
      if (run !== state.runId) return;
      if (ar.status === 'fulfilled' && ar.value && ar.value.subdivision) state.place.subdivision = ar.value.subdivision;
      if (pr.status === 'fulfilled') parcel = pr.value; else errs.push('lot lines');
      if (br.status === 'fulfilled' && br.value.length) { buildings = br.value; srcB = 'FEMA USA Structures'; }
      if (sr.status === 'fulfilled' && sr.value.length) { roads = sr.value; srcR = 'Ohio LBRS street centerlines'; }
      if (!tapped) state.parcel = parcel;
    }
    if (!buildings.length || !roads.length) {
      try {
        const o = await osmWays(point);
        if (run !== state.runId) return;
        if (!buildings.length) buildings = o.buildings;
        if (!roads.length) roads = o.roads.filter(r => r.tags.name || /residential|tertiary|secondary|primary/.test(r.tags.highway));
      } catch (e) { errs.push('OpenStreetMap'); }
    }
    if (run !== state.runId) return;
    if (!roads.length) {
      $('#verdict').innerHTML = `<p class="warn">Couldn't load street data (${esc(errs.join(', ') || 'no data')}). Tap the house on the map to retry, or use the compass check below.</p>`;
      return;
    }
    const est = Geo.estimateFacing(point, buildings, roads, state.place.street, parcel);
    est.sources = { buildings: srcB, roads: srcR, parcel: parcel ? `${parcel.county} County parcel ${parcel.id}` : null };
    est.allBuildings = buildings;
    // Lot record check: the lot's own address should match the house number.
    if (parcel && parcel.situs && state.place.num && !tapped) {
      const n = (parcel.situs.match(/^\s*(\d+)/) || [])[1];
      if (n && n !== String(parseInt(state.place.num, 10))) est.notes.push(`The lot under this point is recorded as "${Ohio.title(parcel.situs)}", not ${state.place.num}. Tap the correct roof on the map.`);
    }
    state.estimate = est;
    if (!est.ok) { $('#verdict').innerHTML = `<p class="warn">${esc(est.reason)} Use the compass check below.</p>`; return; }
    setFacing(est.bearing, 'map');
    drawEstimateOnMap(est, parcel);
    return est;
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
      if (est.sources) html += `<details class="small muted"><summary>How this was worked out</summary>
        <p>House outline: ${esc(est.building ? est.sources.buildings : 'not found')}. Street: ${esc(est.sources.roads)}.${est.sources.parcel ? ` Lot: ${esc(est.sources.parcel)}.` : ''}</p>
        <p>The front of a house faces the street in its address. ${est.usedParcel ? 'The app finds where that street runs along the lot, then ' : 'The app finds the closest point on that street, then '}uses the wall of the house that faces it${est.wallDiff != null ? ` (wall is ${Math.round(est.wallDiff)}° off square to the street)` : ''}.</p></details>`;
    }
    if (source !== 'map' && est && est.ok) {
      const m = Geo.classify(est.bearing);
      html += `<div class="small muted">Map estimate was ${m.dir} (${Math.round(m.bearing)}°). <a href="#" id="reset-map">Use map estimate</a></div>`;
    }
    $('#facing-info').innerHTML = html;
    const r = $('#reset-map'); if (r) r.onclick = ev => { ev.preventDefault(); setFacing(est.bearing, 'map'); };
    renderDial(c.bearing);
    drawArrow();
    record({ facing: { bearing: c.bearing, dir: c.dir, name: c.name, avoid: c.avoid, source, confidence: conf, street: est && est.ok ? est.street : null } });
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
      const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 21, maxNativeZoom: 19, attribution: '© OpenStreetMap' });
      const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 21, maxNativeZoom: 19, attribution: 'Imagery © Esri' });
      // Ohio Statewide Imagery Program: 3–6 inch aerial photos, 2023–2025 around Mason. Much sharper than satellite.
      const ohio = L.tileLayer('https://maps.ohio.gov/image/rest/services/osip_most_current_cache/MapServer/tile/{z}/{y}/{x}', { maxZoom: 21, maxNativeZoom: 20, minZoom: 6, attribution: 'Imagery © State of Ohio OSIP' });
      state.baseLayers = { sat, ohio, street };
      state.map = L.map('map', { layers: [Ohio.inOhio(place) ? ohio : sat], zoomControl: true, maxZoom: 21 });
      L.control.layers({ 'Ohio aerial (newest)': ohio, 'Satellite': sat, 'Street map': street }, null, { position: 'topright' }).addTo(state.map);
      state.map.on('click', ev => {
        const p = { ...state.place, lat: ev.latlng.lat, lon: ev.latlng.lng };
        state.place = p;
        $('#verdict').innerHTML = '<div class="loading">Re-checking this building…</div>';
        if (state.layers.marker) state.layers.marker.setLatLng(ev.latlng);
        runFacing(p, state.runId, true).then(est => { if (est && est.ok) loadRoof(p, state.runId, est); });
      });
    } else {
      // switch the default photo layer when moving between Ohio and elsewhere
      const want = Ohio.inOhio(place) ? state.baseLayers.ohio : state.baseLayers.sat;
      Object.values(state.baseLayers).forEach(l => { if (l !== want && state.map.hasLayer(l)) state.map.removeLayer(l); });
      if (!state.map.hasLayer(want)) want.addTo(state.map);
    }
    Object.values(state.layers).forEach(l => l && state.map.removeLayer(l)); state.layers = {};
    state.layers.marker = L.marker([place.lat, place.lon]).addTo(state.map);
    state.map.setView([place.lat, place.lon], 20);
    setTimeout(() => state.map.invalidateSize(), 100);
  }

  function drawEstimateOnMap(est, parcel) {
    if (!state.map) return;
    ['building', 'road', 'parcel'].forEach(k => { if (state.layers[k]) { state.map.removeLayer(state.layers[k]); delete state.layers[k]; } });
    if (parcel) state.layers.parcel = L.polygon(parcel.geometry.map(g => [g.lat, g.lon]), { color: '#f472b6', weight: 2, dashArray: '5 4', fill: false, interactive: false }).addTo(state.map).bindTooltip('Lot line');
    if (est.building) state.layers.building = L.polygon(est.building.geometry.map(g => [g.lat, g.lon]), { color: '#facc15', weight: 3, fillOpacity: 0.12, interactive: false }).addTo(state.map);
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
    return r.map(x => ({ category: x.category, type: x.type, name: x.name || x.display_name.split(',')[0], addr: x.display_name.split(',').slice(1, 3).join(',').trim(), lat: +x.lat, lon: +x.lon, dist: Geo.haversine(p, { lat: +x.lat, lon: +x.lon }) }))
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
    await Promise.all(groups.map(g => overpass(catQuery(g, p), run).then(d => collect(d, g)).catch(() => failed.push(...g.map(c => c.key)))));
    // Backup when the OpenStreetMap query servers are overloaded: name/category search through Nominatim.
    const FALLBACK = { costco: [['Costco Wholesale', x => /costco/i.test(x.name) && !/gas|fuel/i.test(x.name + x.type)]],
      indian: [['Patel Brothers', x => x.category === 'shop'], ['India grocery', x => x.category === 'shop'], ['Indian market', x => x.category === 'shop'], ['Indian grocery store', x => x.category === 'shop']],
      temple: [['Hindu temple', x => /temple|mandir|hindu/i.test(x.name)]], indianfood: [['Indian restaurant', x => /restaurant|fast_food/.test(x.type)]],
      grocery: [['supermarket', x => x.type === 'supermarket']], hospital: [['hospital', x => x.type === 'hospital']], urgent: [['urgent care', () => true]],
      pharmacy: [['pharmacy', x => x.type === 'pharmacy' || x.type === 'chemist']], school: [['school', x => x.type === 'school']], park: [['park', x => x.type === 'park' || x.type === 'playground']],
      library: [['library', x => x.type === 'library']], gym: [['fitness centre', () => true]], fuel: [['gas station', x => x.type === 'fuel']], fire: [['fire station', x => x.type === 'fire_station']], police: [['police', x => x.type === 'police']] };
    const todoFb = [...new Set([...failed.filter(k => FALLBACK[k]), 'indian'])];
    await Promise.all(todoFb.map(async k => {
      const c = CATS.find(x => x.key === k);
      for (const [term, ok] of FALLBACK[k]) {
        try {
          const list = (await searchCustom(term, p)).filter(ok).filter(x => x.dist <= c.r);
          if (list.length) { (results[k] ||= []).push(...list.map(x => ({ name: x.name, lat: x.lat, lon: x.lon, dist: x.dist }))); }
        } catch { }
      }
      if (results[k] && results[k].length && failed.includes(k)) failed.splice(failed.indexOf(k), 1);
    }));
    await customP;
    if (run !== state.runId) return;
    for (const k in results) {
      // de-dup (same place mapped as node + building)
      const seen = []; results[k] = results[k].sort((a, b) => a.dist - b.dist).filter(x => { if (seen.some(s => s.name === x.name && Geo.haversine(s, x) < 300)) return false; seen.push(x); return true; });
    }
    state.nearby = results; state.nearbyFailed = new Set(failed); state.nearbyDone = true;
    state.myPlaces = store.get('places', []).filter(x => x.lat).map(x => ({ ...x }));
    renderNearby(p);
    recordNearby(run);
    await addDriveTimes(p, run);
  }

  function recordNearby(run) {
    const one = k => { const x = (state.nearby[k] || [])[0]; return x ? { name: x.name, dist: Math.round(x.dist), driveS: x.drive && x.drive.s != null ? Math.round(x.drive.s) : null } : null; };
    const out = {}; ['costco', 'indian', 'temple', 'indianfood', 'grocery', 'hospital', 'school'].forEach(k => out[k] = one(k));
    record({ nearby: out }, run);
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
      recordNearby(run);
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
      const results = await Promise.allSettled([overpass(qLines, run), overpass(qAreas, run)]);
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
  const auditorLink = parcel => {
    if (!parcel || !parcel.auditorUrl) return null;
    if (/account_nbr=$/.test(parcel.auditorUrl)) return null; // Warren records missing the account number
    return parcel.auditorUrl.replace(/^http:\/\/wedge1\.hcauditor\.org/, 'https://wedge1.hcauditor.org');
  };
  function auditorSearch(p, parcel) {
    const c = (parcel && parcel.county) || (p.county || '').replace(/ County$/i, '');
    if (/warren/i.test(c)) return 'https://auditor.warrencountyohio.gov/PropertySearch';
    if (/butler/i.test(c)) return 'https://propertysearch.bcohio.gov/search/commonsearch.aspx?mode=address';
    if (/hamilton/i.test(c)) return 'https://wedge1.hcauditor.org/';
    return `https://www.google.com/search?q=${enc(`${c} County ${p.st || ''} auditor property search`)}`;
  }

  async function loadProperty(p, run) {
    const rows = [];
    const put = () => { if (run === state.runId) $('#property').innerHTML = rows.map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join(''); };
    const parcel = state.parcel, est = state.estimate;
    rows.push(['County', esc(parcel ? parcel.county + ' County' : (p.county || '—'))]);
    if (parcel) {
      rows.push(['Parcel ID', esc(parcel.id)]);
      if (parcel.use) rows.push(['Land use', esc(parcel.use.replace(/^\d+:\s*/, ''))]);
      rows.push(['Lot size', `${(parcel.areaM2 / 4046.86).toFixed(2)} acres (${Math.round(parcel.areaM2 * 10.7639).toLocaleString()} sq ft)`]);
      const link = auditorLink(parcel) || auditorSearch(p, parcel);
      rows.push(['Year built, sales, taxes', `<a href="${esc(link)}" target="_blank" rel="noopener">County auditor record →</a>`]);
    }
    if (est && est.building && est.building.tags && est.building.tags.sqft) rows.push(['House footprint', `${Math.round(est.building.tags.sqft).toLocaleString()} sq ft on the ground (not living area)`]);
    if (p.subdivision) rows.push(['Subdivision', `${esc(p.subdivision)}<br><span class="small muted">Likely has an HOA. Ask for the covenants.</span>`]);
    put();
    const tasks = [
      fetchJSON(`https://api.open-meteo.com/v1/elevation?latitude=${p.lat}&longitude=${p.lon}`).then(r => {
        const m = r.elevation && r.elevation[0]; if (m != null) rows.push(['Elevation', `${Math.round(m * 3.28084)} ft above sea level`]);
      }).catch(() => {}),
      (p.country === 'us' || !p.country) ? fetchJSON(`https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?geometry=${p.lon},${p.lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,ZONE_SUBTY,SFHA_TF&returnGeometry=false&f=json`, {}, 20000).then(r => {
        const f = r.features && r.features[0] && r.features[0].attributes;
        if (!f) { rows.push(['Flood zone', 'No FEMA flood map data here']); state.floodHigh = false; return; }
        const high = f.SFHA_TF === 'T'; state.floodHigh = high; state.floodZone = f.FLD_ZONE + (high ? ' (high risk)' : '');
        rows.push(['Flood zone', `<b class="${high ? 'bad-t' : 'good-t'}">${esc(f.FLD_ZONE)}</b> ${high ? '– HIGH risk, flood insurance likely required' : '– not high-risk'}${f.ZONE_SUBTY ? `<br><span class="small muted">${esc(f.ZONE_SUBTY.toLowerCase())}</span>` : ''}`]);
      }).catch(() => rows.push(['Flood zone', `<a href="https://msc.fema.gov/portal/search?AddressQuery=${enc(p.label)}" target="_blank" rel="noopener">Check on FEMA →</a>`])) : Promise.resolve(),
      state.ohio ? Ohio.schoolDistrict(p).then(d => {
        if (d) { state.district = d; rows.push(['School district', `${esc(d.name)}<br><a class="small" href="https://reportcard.education.ohio.gov/district/overview/${esc(d.irn)}" target="_blank" rel="noopener">Ohio report card →</a>`]); }
      }).catch(() => {}) : Promise.resolve()
    ];
    await Promise.all(tasks);
    record({ property: { parcelId: parcel ? parcel.id : null, lotAcres: parcel ? +(parcel.areaM2 / 4046.86).toFixed(2) : null, footprintSqft: est && est.building && est.building.tags && est.building.tags.sqft ? Math.round(est.building.tags.sqft) : null, district: state.district ? state.district.name : null, flood: state.floodZone || null, subdivision: p.subdivision || null, auditorUrl: parcel ? auditorLink(parcel) : null } }, run);
    const b = est && est.building && est.building.tags;
    if (b) {
      if (b['building:levels']) rows.push(['Stories (OSM)', esc(b['building:levels'])]);
      if (b.start_date) rows.push(['Built (OSM)', esc(b.start_date)]);
    }
    put();
  }

  // ---------- value, sale history & owner ----------
  const money = v => v == null ? '—' : '$' + Math.round(v).toLocaleString();
  const parseMoney = s => { const m = String(s || '').replace(/[, ]/g, '').match(/(\d+(\.\d+)?)\s*(k|m)?/i); if (!m) return null; let v = +m[1]; if (/k/i.test(m[3] || '')) v *= 1e3; if (/m/i.test(m[3] || '')) v *= 1e6; if (v < 1000) v *= 1000; return v; };
  const parseWhen = s => { const m = String(s || '').match(/(\d{4})(?:[-/ ](\d{1,2}))?/); return m ? new Date(+m[1], m[2] ? +m[2] - 1 : 5, 15) : null; };

  async function loadValue(p, run, est) {
    const box = $('#value');
    if (!state.ohio) { box.innerHTML = '<p class="small muted">Owner and sale lookups use Ohio county records, so they only work for Ohio addresses.</p>'; return; }
    box.innerHTML = '<div class="loading">Looking up the owner and sale history…</div>';
    const pt = est && est.ok && est.building ? est.origin : p; // the house itself, not the driveway end
    const county = (state.parcel && state.parcel.county) || p.county || '';
    const [own, z] = await Promise.all([Value.owner(pt, county).catch(() => null), Value.zhvi(p.zip)]);
    if (run !== state.runId) return;
    let comps = null;
    if (own && own.county === 'Hamilton') comps = await Value.hamiltonComps(pt, own.cls).catch(() => null);
    if (run !== state.runId) return;
    state.valueCtx = { own, z, comps };
    renderValue(run);
  }

  function renderValue(run) {
    const box = $('#value'), { own, z, comps } = state.valueCtx || {};
    const manual = (state.rec && state.rec.valueManual) || {};
    const sale = own && own.sale ? own.sale : (parseMoney(manual.salePrice) && parseWhen(manual.saleDate) ? { price: parseMoney(manual.salePrice), date: parseWhen(manual.saleDate), manual: true } : null);
    const auditor = own && own.auditor ? own.auditor : (parseMoney(manual.auditorValue) ? { total: parseMoney(manual.auditorValue), manual: true } : null);
    const asking = parseMoney($('#f-price').value);
    const pc = Value.priceCheck({ asking, sale, auditor, ratio: comps && comps.ratio, z });
    let html = '';
    // price check
    html += `<label class="small">Asking price<input id="v-ask" inputmode="numeric" placeholder="$525,000" value="${esc($('#f-price').value)}"></label>`;
    if (pc.verdict) html += `<div class="dc-score ${pc.cls}"><div>${esc(pc.verdict)}</div><span>Estimated value ${money(pc.low)} – ${money(pc.high)}</span></div>`;
    else if (pc.value) html += `<p><b>Estimated value: ${money(pc.low)} – ${money(pc.high)}</b><br><span class="small muted">Enter the asking price to see if it's priced right.</span></p>`;
    pc.est.forEach(e => html += `<p class="small">• ${esc(e.text)}</p>`);
    if (z) html += `<p class="small muted">Typical single-family home in ${esc(z.zip)} (${esc(z.city)}): ${money(z.v[z.v.length - 1])}, ${Math.round((z.v[z.v.length - 1] / z.v[Math.max(0, z.v.length - 13)] - 1) * 100)}% over the past year. Source: Zillow Home Value Index.</p>`;
    // owner
    if (own) {
      html += `<h3>Owner (public record)</h3><div class="kv"><span>Owner</span><span><b>${esc(own.owner || '—')}</b></span></div>`;
      if (own.prevOwner) html += `<div class="kv"><span>Previous owner</span><span>${esc(own.prevOwner)}</span></div>`;
      if (own.mailing) html += `<div class="kv"><span>Tax bills sent to</span><span>${esc(own.mailing)}</span></div>`;
      if (own.type && own.type.text) html += `<p class="small">${esc(own.type.text)}</p>`;
      if (sale) html += `<div class="kv"><span>Bought</span><span><b>${money(sale.price)}</b> on ${esc(sale.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))}${sale.manual ? ' <span class="small muted">(you entered)</span>' : ''}<br><span class="small muted">owned ${Math.max(0, ((Date.now() - sale.date) / 3.15576e10)).toFixed(1)} years</span></span></div>`;
      if (auditor) html += `<div class="kv"><span>County value</span><span>${money(auditor.total)}${auditor.land ? `<br><span class="small muted">land ${money(auditor.land)} + building ${money(auditor.building)}</span>` : ''}${auditor.manual ? ' <span class="small muted">(you entered)</span>' : ''}</span></div>`;
      if (own.taxes) html += `<div class="kv"><span>Property taxes</span><span>${money(own.taxes)} / year</span></div>`;
      if (own.deed) html += `<div class="kv"><span>Deed</span><span>${esc(own.deed)}</span></div>`;
      if (own.subdivision) html += `<div class="kv"><span>Subdivision / lot</span><span>${esc(own.subdivision)}${own.lot ? `, lot ${esc(own.lot)}` : ''}</span></div>`;
      const flags = [own.rental && '🏘️ Registered as a rental', own.foreclosure && '⚠️ Foreclosure flag on the county record', own.delinquent && `⚠️ ${money(own.delinquent)} in unpaid property taxes`].filter(Boolean);
      if (flags.length) html += flags.map(x => `<p class="small warn">${esc(x)}</p>`).join('');
    } else html += '<p class="small warn">Couldn\'t find the county owner record for this lot.</p>';
    // manual entry for counties that block apps
    if (!own || own.needsManual) {
      html += `<div class="roof"><b>Add the sale price and county value</b>
        <p class="small">${esc((own && own.county) || 'This')} County's auditor website blocks other apps, so the app can't read these two numbers itself. Open the page, then type them here:</p>
        <a class="btn wide" href="${esc((own && own.auditorUrl) || auditorSearch(state.place, state.parcel))}" target="_blank" rel="noopener">🏛️ Open the county auditor page</a>
        <div class="grid2" style="margin-top:8px"><label>Last sale price<input id="v-sale" inputmode="numeric" placeholder="$410,000" value="${esc(manual.salePrice || '')}"></label>
        <label>Sale date<input id="v-date" placeholder="2019-06" value="${esc(manual.saleDate || '')}"></label>
        <label style="grid-column:1/-1">County appraised value (“Total”)<input id="v-aud" inputmode="numeric" placeholder="$385,000" value="${esc(manual.auditorValue || '')}"></label></div>
        <p class="small muted">On the Warren auditor page: “Sales” tab for the price and date, “Values” for the appraised total.</p></div>`;
    } else if (own && own.auditorUrl) html += `<p class="small"><a href="${esc(own.auditorUrl)}" target="_blank" rel="noopener">Full county auditor record →</a></p>`;
    if (comps && comps.list.length) {
      html += `<details class="howto"><summary>Recent sales nearby (${comps.list.length})</summary>${comps.list.slice(0, 12).map(c => `<div class="place"><span>${esc(c.addr)}<br><span class="small muted">${esc(c.date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }))} · county value ${money(c.value)}</span></span><span class="dist"><b>${money(c.price)}</b></span></div>`).join('')}</details>`;
    }
    html += `<p class="small muted">Estimates are a guide, not an appraisal. They don't know about remodels, condition or finished basements. Your agent's comparable sales and the lender's appraisal are the final word.</p>`;
    box.innerHTML = html;
    const sync = () => { $('#f-price').value = $('#v-ask').value; onNotesInput(); };
    $('#v-ask').onchange = () => { sync(); renderValue(run); };
    ['#v-sale', '#v-date', '#v-aud'].forEach(id => { const el = $(id); if (el) el.onchange = () => { const m = { salePrice: $('#v-sale').value.trim(), saleDate: $('#v-date').value.trim(), auditorValue: $('#v-aud').value.trim() }; if (state.rec) state.rec.valueManual = m; record({ valueManual: m }); renderValue(run); }; });
    record({ value: { owner: own ? own.owner : null, ownerKind: own && own.type ? own.type.kind : null, salePrice: sale ? sale.price : null, saleDate: sale ? +sale.date : null, countyValue: auditor ? auditor.total : null, taxes: own ? own.taxes : null, estLow: pc.low || null, estHigh: pc.high || null, verdict: pc.verdict || null } }, run);
  }

  // ---------- roof age ----------
  async function loadRoof(p, run, est) {
    const box = $('#roof');
    const g = q => `https://www.google.com/search?q=${enc(q)}`;
    const parcel = state.parcel;
    const ohioNote = state.ohio ? `<p class="small"><b>Why there's no permit date:</b> In Mason, Warren County and most of Ohio, replacing shingles doesn't need a building permit, so no public record of roof dates exists. The app reads the roof's history from dated aerial photos instead.</p>` : '';
    const links = `<div class="roof"><b>Confirm the exact year</b>
      <ol class="small">
        <li>Ask the listing agent for the <b>roofer's invoice or shingle warranty</b>. Warranties are registered with the shingle maker and show the install date.</li>
        <li><a href="${g(`"${p.num ? p.num + ' ' : ''}${p.street}" ${p.city} roof`)}" target="_blank" rel="noopener">Search the listing text for “roof”</a>, or open <a href="https://www.zillow.com/homes/${enc(p.label)}_rb/" target="_blank" rel="noopener">Zillow</a> / <a href="${g(`redfin ${p.label}`)}" target="_blank" rel="noopener">Redfin</a>. Listings often say “new roof 2021”. (These sites block other apps from reading them.)</li>
        <li><a href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat},${p.lon}" target="_blank" rel="noopener">Street View</a>: in the Google Maps app tap the photo date to step back through older years and look at the shingles.</li>
        ${parcel ? `<li><a href="${esc(auditorLink(parcel) || auditorSearch(p, parcel))}" target="_blank" rel="noopener">County auditor record</a>: year built. If no change shows in the photos, the roof may date from then.</li>` : ''}
        <li>Your home inspector will estimate remaining roof life.</li>
      </ol></div>`;
    if (!est || !est.ok || !est.building) {
      box.innerHTML = `${ohioNote}<p class="warn small">No house outline found, so the photo comparison can't run. Tap the house's roof on the map to try again.</p>${links}`;
      return;
    }
    box.innerHTML = `${ohioNote}<div class="loading" id="roof-status">Finding dated aerial photos…</div>`;
    const house = est.building;
    const P = Geo.projector(est.origin);
    const neighbours = (est.allBuildings || []).filter(b => b.id !== house.id && b.geometry && b.geometry.length > 3)
      .filter(b => { const a = Geo.areaM2(b.geometry); return a > 60 && a < 900; })
      .map(b => ({ b, d: Math.hypot(...Object.values(P.fwd(b.geometry[0]))) })).sort((a, b) => a.d - b.d).map(x => x.b);
    let res;
    try {
      res = await Roof.history(house, neighbours, { ohio: state.ohio, county: parcel ? parcel.county : p.county }, t => { if (run === state.runId && $('#roof-status')) $('#roof-status').textContent = t; });
    } catch (e) {
      if (run !== state.runId) return;
      box.innerHTML = `${ohioNote}<p class="warn small">Couldn't load the aerial photos (${esc(e.message)}).</p>${links}`;
      return;
    }
    if (run !== state.runId) return;
    const s = res.summary;
    const cls = s.level === 'likely' ? 'good-t' : s.level === 'possible' ? 'warn' : '';
    let html = `${ohioNote}<p class="${cls}"><b>${esc(s.headline)}</b></p>${s.detail ? `<p class="small">${esc(s.detail)}</p>` : ''}`;
    if (s.level === 'likely' && s.to && !$('#f-roof').value) $('#f-roof').value = `${s.from.getFullYear()}–${s.to.getFullYear()} (photos)`;
    if (res.photos.length) {
      html += `<p class="small muted">${res.photos.length} dated photos of this roof (yellow outline; red = where the change was seen). Tap one to enlarge.</p><div class="roof-strip">` +
        res.photos.map((ph, i) => `<figure class="${ph.flag ? 'flag' : ''}${ph.hidden ? ' hid' : ''}"><img src="${ph.thumb}" alt="Roof ${esc(ph.cap.date.getFullYear())}" data-i="${i}"><figcaption>${esc(ph.cap.date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }))}<br><span>${esc(ph.cap.label)}</span>${ph.hidden ? '<br><span>roof hidden</span>' : ''}</figcaption></figure>`).join('') + '</div>';
    }
    const fy = d => d ? d.getFullYear() : '';
    record({ roof: { level: s.level, headline: s.headline, from: s.from ? +s.from : null, to: s.to ? +s.to : null, photos: res.photos.length, short: s.level === 'likely' ? `new roof ${fy(s.from)}–${fy(s.to)}` : s.level === 'possible' ? `maybe new ${fy(s.from)}–${fy(s.to)}` : s.level === 'none' ? `no change since ${fy(s.from)}` : 'unknown' } }, run);
    box.innerHTML = html + links;
    box.querySelectorAll('.roof-strip img').forEach(im => im.onclick = () => im.closest('figure').classList.toggle('big'));
  }

  // ---------- home daycare ----------
  async function nearestRamp(p) {
    const d = await overpass(`[out:json][timeout:20];node["highway"="motorway_junction"](around:20000,${p.lat},${p.lon});out;`, state.runId);
    const list = (d.elements || []).map(e => ({ name: e.tags.name || (e.tags.ref ? `Exit ${e.tags.ref}` : 'Highway ramp'), lat: e.lat, lon: e.lon, dist: Geo.haversine(p, e) })).sort((a, b) => a.dist - b.dist);
    return list[0] || null;
  }
  async function driveTimes(p, targets) {
    const coords = [p, ...targets].map(x => `${(+x.lon).toFixed(6)},${(+x.lat).toFixed(6)}`).join(';');
    const r = await fetchJSON(`${OSRM}/table/v1/driving/${coords}?sources=0&annotations=duration`, {}, 20000);
    if (r.code !== 'Ok') throw new Error('routing failed');
    return targets.map((_, i) => r.durations[0][i + 1]);
  }

  async function loadDaycare(p, run, est, propP) {
    const box = $('#daycare');
    if (!state.ohio) { box.innerHTML = '<p class="small muted">The daycare check uses Ohio licensing data, so it only works for Ohio addresses.</p>'; return; }
    box.innerHTML = '<div class="loading">Checking families, daycares and schools nearby…</div>';
    await Promise.race([propP, sleep(8000)]);
    // the house's own street (speed limit, lanes, court/circle) from the state centerlines
    const street = est && est.ok ? est.streetTags || null : null;
    let d;
    try { d = await Daycare.analyze(p, { street, floodHigh: state.floodHigh, nearestRamp, driveTimes }); }
    catch (e) { if (run === state.runId) box.innerHTML = `<p class="warn">Couldn't run the daycare check (${esc(e.message)}).</p>`; return; }
    if (run !== state.runId) return;
    const bar = v => `<span class="bar"><span style="width:${v * 5}%"></span></span>`;
    const gcls = { Strong: 'good', Good: 'good', Fair: 'mid', Weak: 'bad' }[d.grade];
    let html = `<div class="dc-score ${gcls}"><b>${d.pct}</b><span>/100</span><div>${d.grade} spot for a home daycare</div></div>`;
    html += d.parts.map(x => `<div class="dc-part"><div class="dc-h"><span>${esc(x.label)}</span><span>${x.score}/20</span></div>${bar(x.score)}<p class="small">${esc(x.text)}</p></div>`).join('');
    if (d.demo) {
      const total = d.demo.age0to4 + d.demo.age5to9 + d.demo.age10to14 || 1;
      const seg = (n, l, c) => `<div class="age"><span>${l}</span><span class="bar"><span style="width:${Math.round(n / total * 100)}%;background:${c}"></span></span><b>${n.toLocaleString()}</b></div>`;
      html += `<h3>Kids within 3 miles</h3>${seg(d.demo.age0to4, 'Age 0–4', '#0f766e')}${seg(d.demo.age5to9, 'Age 5–9', '#14b8a6')}${seg(d.demo.age10to14, 'Age 10–14', '#5eead4')}
        <p class="small muted">${d.demo.under6Working.toLocaleString()} children under 6 and ${d.demo.schoolWorking.toLocaleString()} school-age children (6–17) live with parents who all work. These families are the ones who need care. Census ACS 5-year estimates, ${d.demo.tracts} census tracts weighted by how much of each is within 3 miles.</p>`;
    }
    const near = d.providers.filter(x => x.dist <= 3 * 1609.344);
    if (near.length) {
      const by = {}; near.forEach(x => by[x.type] = (by[x.type] || 0) + 1);
      html += `<h3>Licensed child care within 3 miles (${near.length})</h3><p class="small">${Object.entries(by).map(([k, v]) => `${esc(k)}: <b>${v}</b>`).join(' · ')}</p>
        <details class="howto"><summary>Closest ${Math.min(12, near.length)}</summary>${near.slice(0, 12).map(x => `<div class="place"><span>${x.link ? `<a href="${esc(x.link)}" target="_blank" rel="noopener">${esc(x.name)}</a>` : esc(x.name)}<br><span class="small muted">${esc(x.type)}${x.stars && x.stars !== 'NR' ? ` · Step Up To Quality: ${esc(x.stars)}★` : ''}</span></span><span class="dist">${fmtMi(x.dist)}</span></div>`).join('')}</details>`;
    }
    if (d.elem.length) html += `<h3>Nearest elementary schools</h3>${d.elem.map(s => `<div class="place"><span>${esc(s.name)}<br><span class="small muted">Grades ${esc(s.lo || '?')}–${esc(s.hi || '?')}${s.students ? ` · ${s.students} students` : ''}</span></span><span class="dist">${s.driveMin != null ? `🚗 ${Math.max(1, Math.round(s.driveMin))} min` : fmtMi(s.dist)}</span></div>`).join('')}`;
    html += `<div class="roof"><b>Ohio rules for a home daycare (Type B)</b><ul class="small">
      <li>Up to <b>7 children</b> at one time, no more than <b>3 under age 2</b>. Your mom's own children under 6 who live there count toward the 7.</li>
      <li>State law treats a Type B home as a residential use: it's allowed anywhere houses are allowed (Ohio Revised Code 5104.054). <b>HOA covenants are separate</b> and can still restrict a home business, so read them before buying.</li>
      <li>Licensing is through the Ohio Department of Children and Youth, which includes a home inspection.</li></ul>
      <p class="small"><a href="https://jfs.ohio.gov/child-care/information-for-providers/become-a-provider" target="_blank" rel="noopener">How to become a provider →</a> · <a href="https://codes.ohio.gov/ohio-revised-code/section-5104.054" target="_blank" rel="noopener">ORC 5104.054 →</a></p></div>
      <p class="small muted">The score is a guide built from public data (Ohio child care licensing list, Census ACS, NCES schools, Ohio street data), not a guarantee of enrollment.</p>`;
    box.innerHTML = html;
    record({ daycare: { pct: d.pct, grade: d.grade, age0to4: d.demo ? d.demo.age0to4 : null, under6Working: d.demo ? d.demo.under6Working : null, programs3mi: near.length, homes1mi: d.providers.filter(x => x.dist <= 1609.344 && Daycare.isHome(x.type)).length } }, run);
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

  // ---------- house database (all searched / visited houses) ----------
  const FIELDS = ['price', 'roof', 'hoa', 'built', 'hvac', 'wh', 'notes'];
  const keyOf = p => `${(+p.lat).toFixed(4)},${(+p.lon).toFixed(4)}`;
  function fillNotes(n) { n = n || {}; FIELDS.forEach(f => $('#f-' + f).value = n[f] || ''); }
  const readNotes = () => { const n = {}; FIELDS.forEach(f => n[f] = $('#f-' + f).value.trim()); return n; };

  // Write part of the current house's record. Ignored if the user has moved on to another house.
  function record(patch, run) {
    if (!state.key || (run != null && run !== state.runId) || !window.HouseDB) return;
    HouseDB.update(state.key, patch).then(r => { state.rec = r; updateCount(); renderHeaderTools(); }).catch(() => {});
  }

  async function recordSearch(place, how) {
    state.key = keyOf(place);
    let cur = null; try { cur = await HouseDB.get(state.key); } catch { }
    const visits = (cur && cur.visits) || [];
    if (how === 'gps') visits.push({ at: Date.now(), how: 'gps' });
    const base = { label: place.label, lat: place.lat, lon: place.lon, num: place.num || '', street: place.street || '', city: place.city || '', county: place.county || '', st: place.st || '', zip: place.zip || '', country: place.country || '' };
    state.rec = await HouseDB.update(state.key, { ...base, lastSeen: Date.now(), timesSearched: ((cur && cur.timesSearched) || 0) + 1, visits }).catch(() => null);
    if (cur && cur.notes) fillNotes(cur.notes);
    renderHeaderTools(); updateCount();
    return cur;
  }

  function renderHeaderTools() {
    const r = state.rec, box = $('#house-tools'); if (!box) return;
    if (!r) { box.innerHTML = ''; return; }
    const v = (r.visits || []).length;
    box.innerHTML = `<button type="button" class="btn tiny" id="btn-star">${r.starred ? '⭐ Starred' : '☆ Star'}</button>
      <button type="button" class="btn tiny" id="btn-visit">📍 ${v ? `Visited ${v}×` : 'Mark visited'}</button>
      <span class="small muted">Searched ${r.timesSearched || 1}× · saved automatically</span>`;
    $('#btn-star').onclick = () => record({ starred: !r.starred });
    $('#btn-visit').onclick = () => { record({ visits: [...(r.visits || []), { at: Date.now(), how: 'tap' }] }); toast('Visit recorded'); };
  }

  let notesTimer = null;
  function onNotesInput() { clearTimeout(notesTimer); if (state.valueCtx && document.activeElement && document.activeElement.id === 'f-price') renderValue(state.runId); notesTimer = setTimeout(() => record({ notes: readNotes() }), 600); }
  function saveHouse() { record({ notes: readNotes(), starred: true }); toast('Saved ⭐'); }

  async function updateCount() {
    try { const n = (await HouseDB.all()).length; $('#saved-count').textContent = n ? `(${n})` : ''; } catch { }
  }

  const histUI = { filter: 'all', sort: 'recent', q: '' };
  async function renderSaved() {
    let list = [];
    try { list = await HouseDB.all(); } catch (e) { $('#saved-list').innerHTML = `<div class="card warn">Couldn't open the house database (${esc(e.message)}).</div>`; return; }
    const places = store.get('places', []);
    const f = histUI.filter, q = histUI.q.toLowerCase();
    let shown = list.filter(r => f === 'all' || (f === 'starred' && r.starred) || (f === 'visited' && (r.visits || []).length) || (f === 'ok' && r.facing && !r.facing.avoid))
      .filter(r => !q || `${r.label} ${(r.notes && r.notes.notes) || ''}`.toLowerCase().includes(q));
    const costcoS = r => r.nearby && r.nearby.costco ? (r.nearby.costco.driveS ?? r.nearby.costco.dist * 0.06) : Infinity;
    if (histUI.sort === 'daycare') shown.sort((a, b) => ((b.daycare && b.daycare.pct) || -1) - ((a.daycare && a.daycare.pct) || -1));
    if (histUI.sort === 'costco') shown.sort((a, b) => costcoS(a) - costcoS(b));
    const fmtD = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const dd = x => x ? (x.driveS != null ? fmtMin(x.driveS) : fmtMi(x.dist)) : '—';
    const chip = (k, l) => `<button class="chip ${histUI.filter === k ? 'on' : ''}" data-f="${k}">${l}</button>`;
    let html = `<div class="card"><h2>🗂️ All houses (${list.length})</h2>
      <p class="small muted">Every house you search is saved here automatically, on this phone only.</p>
      <input id="h-q" type="search" placeholder="Search address or notes" value="${esc(histUI.q)}">
      <div class="chips" style="margin:8px 0">${chip('all', 'All')}${chip('starred', '⭐ Starred')}${chip('visited', '📍 Visited')}${chip('ok', '✔ OK direction')}</div>
      <label class="small">Sort <select id="h-sort"><option value="recent">Most recent</option><option value="daycare">Best daycare score</option><option value="costco">Closest Costco</option></select></label></div>`;
    if (!shown.length) html += `<div class="card"><p class="muted">${list.length ? 'No houses match.' : 'No houses yet. Search an address and it will appear here.'}</p></div>`;
    html += shown.map(r => {
      const fa = r.facing;
      const badge = fa && fa.dir ? `<span class="badge ${fa.avoid ? 'bad' : 'good'} sm">${fa.avoid ? '✖' : '✔'} ${fa.dir}</span>` : '<span class="badge sm">?</span>';
      const n = r.notes || {};
      const v = (r.visits || []).length;
      return `<div class="card saved ${fa && fa.avoid ? 'dim' : ''}">
        <div class="saved-top">${badge}<b>${esc(r.label)}</b>${r.starred ? ' ⭐' : ''}</div>
        <div class="small muted">Last looked ${fmtD(r.lastSeen)} · searched ${r.timesSearched || 1}×${v ? ` · visited ${v}×` : ''}</div>
        <div class="chips">${n.price ? `<span>💲${esc(n.price)}</span>` : ''}
          ${r.roof ? `<span>🏚️ ${esc(r.roof.short || r.roof.level)}</span>` : (n.roof ? `<span>🏚️ ${esc(n.roof)}</span>` : '')}
          ${r.daycare ? `<span>👶 Daycare ${r.daycare.pct}/100</span>` : ''}
          ${r.nearby ? `<span>🛒 Costco ${dd(r.nearby.costco)}</span><span>🍛 ${r.nearby.indian ? esc(r.nearby.indian.name) + ' ' + dd(r.nearby.indian) : '—'}</span>` : ''}
          ${r.property && r.property.lotAcres ? `<span>📐 ${r.property.lotAcres} ac</span>` : ''}</div>
        ${n.notes ? `<p class="small">${esc(n.notes)}</p>` : ''}
        <div class="row"><button class="btn" data-open="${esc(r.key)}">Open</button><button class="btn" data-star="${esc(r.key)}">${r.starred ? '★ Unstar' : '☆ Star'}</button><button class="btn danger" data-del="${esc(r.key)}">Delete</button></div></div>`;
    }).join('');
    html += `<div class="card"><h2>Backup</h2><p class="small muted">The browser can erase website data, for example if you clear Safari history. Export a backup now and then.</p>
      <div class="row"><button class="btn" id="h-json">⬇️ Backup file</button><button class="btn" id="h-csv">📊 Spreadsheet (CSV)</button></div>
      <label class="btn wide" style="text-align:center">⬆️ Restore from backup<input type="file" id="h-import" accept=".json,application/json" hidden></label></div>`;
    html += `<div class="card"><h2>My important places</h2><p class="small muted">Add work, family, etc. Drive time from each house will show under “Nearby”.</p>
      ${places.map((x, i) => `<div class="place"><span><b>${esc(x.label)}</b> – ${esc(x.address)}</span><button class="btn tiny" data-delplace="${i}">✕</button></div>`).join('')}
      <form id="place-form" class="grid2"><input id="pl-label" placeholder="Name (e.g. Work)" required><input id="pl-addr" placeholder="Address" required>
      <button class="btn wide" style="grid-column:1/-1">+ Add place</button></form></div>`;
    const box = $('#saved-list');
    box.innerHTML = html;
    $('#h-sort').value = histUI.sort;
    $('#h-sort').onchange = e => { histUI.sort = e.target.value; renderSaved(); };
    $('#h-q').oninput = e => { histUI.q = e.target.value; clearTimeout(renderSaved._t); renderSaved._t = setTimeout(() => { renderSaved().then(() => { const i = $('#h-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 250); };
    box.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { histUI.filter = b.dataset.f; renderSaved(); });
    const byKey = k => list.find(r => r.key === k);
    box.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { const r = byKey(b.dataset.open); showView('view-search'); $('#addr').value = r.label; analyze(r, r); });
    box.querySelectorAll('[data-star]').forEach(b => b.onclick = async () => { const r = byKey(b.dataset.star); await HouseDB.update(r.key, { starred: !r.starred }); renderSaved(); });
    box.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (!confirm('Delete this house from the database?')) return; await HouseDB.del(b.dataset.del); updateCount(); renderSaved(); });
    box.querySelectorAll('[data-delplace]').forEach(b => b.onclick = () => { places.splice(+b.dataset.delplace, 1); store.set('places', places); renderSaved(); });
    const download = (name, text, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); };
    const stamp = new Date().toISOString().slice(0, 10);
    $('#h-json').onclick = () => download(`house-scout-${stamp}.json`, JSON.stringify({ app: 'house-scout', version: 1, exported: Date.now(), houses: list }, null, 1), 'application/json');
    $('#h-csv').onclick = () => {
      const cols = ['label', 'direction', 'degrees', 'avoid', 'direction_source', 'roof', 'daycare_score', 'costco', 'indian_store', 'lot_acres', 'school_district', 'flood_zone', 'owner', 'bought_for', 'bought_on', 'county_value', 'estimated_value', 'price_check', 'price', 'hoa', 'notes', 'times_searched', 'visits', 'last_seen', 'starred'];
      const q2 = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const rows = list.map(r => { const n = r.notes || {}, fa = r.facing || {}, nb = r.nearby || {}, pr = r.property || {};
        return [r.label, fa.dir, fa.bearing != null ? Math.round(fa.bearing) : '', fa.avoid ? 'yes' : (fa.dir ? 'no' : ''), fa.source, r.roof ? r.roof.headline : n.roof, r.daycare ? r.daycare.pct : '', nb.costco ? dd(nb.costco) : '', nb.indian ? `${nb.indian.name} (${dd(nb.indian)})` : '', pr.lotAcres, pr.district, pr.flood, (r.value || {}).owner, (r.value || {}).salePrice, (r.value || {}).saleDate ? new Date(r.value.saleDate).toISOString().slice(0, 10) : '', (r.value || {}).countyValue, (r.value || {}).estLow ? `${Math.round(r.value.estLow / 1000)}k–${Math.round(r.value.estHigh / 1000)}k` : '', (r.value || {}).verdict, n.price, n.hoa, n.notes, r.timesSearched, (r.visits || []).length, new Date(r.lastSeen).toISOString().slice(0, 10), r.starred ? 'yes' : ''].map(q2).join(','); });
      download(`house-scout-${stamp}.csv`, [cols.join(','), ...rows].join('\n'), 'text/csv');
    };
    $('#h-import').onchange = async e => {
      const file = e.target.files[0]; if (!file) return;
      try { const j = JSON.parse(await file.text()); const n = await HouseDB.importAll(j.houses || j); toast(`Restored ${n} houses`); updateCount(); renderSaved(); }
      catch (err) { toast('That file is not a House Scout backup'); }
    };
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
    $('#addr').addEventListener('input', onAddrInput);
    $('#btn-gps').onclick = onGPS;
    $('#btn-compass').onclick = startCompass;
    $('#btn-lock').onclick = lockCompass;
    $('#btn-save').onclick = saveHouse;
    FIELDS.forEach(f => $('#f-' + f).addEventListener('input', onNotesInput));
    HouseDB.migrate().catch(() => {}).then(updateCount);
    HouseDB.persist();
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

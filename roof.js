/* Roof history from dated aerial photos.
 *
 * In Ohio (Mason, Warren County and most of the state) replacing shingles does not need a building permit,
 * so there is no public record of roof dates. What does exist is a series of dated aerial photos.
 * A new roof shows up as a sudden change in the roof's colour/brightness between two photos.
 *
 * To avoid false alarms from different cameras, seasons and lighting, each change is compared with the
 * change seen on the neighbouring roofs in the same two photos. Only a change that is much bigger than
 * the neighbours' is flagged. The photos are always shown so the result can be checked by eye.
 *
 * Sources (all public, browser-accessible):
 *  - Ohio Statewide Imagery Program (OSIP) 6-inch photos: osip_3_cache (2017–2024) and osip_most_current_cache
 *  - Hamilton County CAGIS yearly aerials (1996–2025) for Hamilton County houses
 *  - Esri World Imagery Wayback (every distinct capture since 2014, often back to ~2012)
 */
(function (root) {
  'use strict';
  const M = 20037508.342789244;
  const merc = p => ({ x: p.lon * M / 180, y: Math.log(Math.tan((90 + p.lat) * Math.PI / 360)) * M / Math.PI });

  // ---------- pure analysis (testable in Node) ----------
  function rgb2lab(r, g, b) {
    const f = c => { c /= 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92; };
    const R = f(r), G = f(g), B = f(b);
    let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047, y = (R * 0.2126 + G * 0.7152 + B * 0.0722), z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const h = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    x = h(x); y = h(y); z = h(z);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }
  const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const mad = a => { const m = median(a); return median(a.map(v => Math.abs(v - m))); };

  /** Stats for the pixels inside a polygon (pixel coords). Uses the middle 60% of the roof to tolerate small misalignment. */
  function roofStats(data, W, H, poly, shrink = 0.6) {
    const n = poly.length; let cx = 0, cy = 0; for (const q of poly) { cx += q.x; cy += q.y; } cx /= n; cy /= n;
    const P = poly.map(q => ({ x: cx + (q.x - cx) * shrink, y: cy + (q.y - cy) * shrink }));
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const q of P) { minx = Math.min(minx, q.x); maxx = Math.max(maxx, q.x); miny = Math.min(miny, q.y); maxy = Math.max(maxy, q.y); }
    const rs = [], gs = [], bs = [], Ls = []; let veg = 0, dark = 0, blank = 0;
    for (let y = Math.max(0, Math.floor(miny)); y <= Math.min(H - 1, Math.ceil(maxy)); y++) {
      for (let x = Math.max(0, Math.floor(minx)); x <= Math.min(W - 1, Math.ceil(maxx)); x++) {
        let inside = false;
        for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
          const a = P[i], b = P[j];
          if ((a.y > y + 0.5) !== (b.y > y + 0.5) && x + 0.5 < (b.x - a.x) * (y + 0.5 - a.y) / (b.y - a.y) + a.x) inside = !inside;
        }
        if (!inside) continue;
        const k = (y * W + x) * 4, r = data[k], g = data[k + 1], bl = data[k + 2], al = data[k + 3];
        if (al < 200) { blank++; continue; }
        rs.push(r); gs.push(g); bs.push(bl);
        Ls.push(0.2126 * r + 0.7152 * g + 0.0722 * bl);
        if (g > r + 8 && g > bl + 4) veg++;
        if (r + g + bl < 45) dark++;
      }
    }
    const count = rs.length;
    if (count < 12) return { ok: false, count, blank };
    const lab = rgb2lab(median(rs), median(gs), median(bs));
    const Lm = median(Ls);
    return { ok: true, count, lab, L: lab[0], spread: median(Ls.map(v => Math.abs(v - Lm))), veg: veg / count, dark: dark / count, blank: blank / (count + blank) };
  }

  /**
   * Given a time-ordered series of photos, find roof changes.
   * series: [{date, house: stats, neighbours: [stats|null,...]}]  (neighbour i is the same building in every photo)
   * Returns {usable:[indices], changes:[{from,to,excess,houseDelta,neighbourDelta,level,darker}], notVisible:[indices]}
   */
  function detectChanges(series) {
    const usable = [], notVisible = [];
    series.forEach((s, i) => {
      if (!s.house || !s.house.ok) return;
      // Mostly green = trees over the roof, or the house wasn't built yet.
      if (s.house.veg > 0.45) { notVisible.push(i); return; }
      usable.push(i);
    });
    const changes = [];
    for (let k = 1; k < usable.length; k++) {
      const a = series[usable[k - 1]], b = series[usable[k]];
      const dh = dE(a.house.lab, b.house.lab);
      const nd = [];
      const nn = Math.min(a.neighbours.length, b.neighbours.length);
      for (let i = 0; i < nn; i++) {
        const x = a.neighbours[i], y = b.neighbours[i];
        if (x && y && x.ok && y.ok && x.veg <= 0.45 && y.veg <= 0.45) nd.push(dE(x.lab, y.lab));
      }
      if (nd.length < 3) { changes.push({ from: usable[k - 1], to: usable[k], houseDelta: dh, neighbourDelta: null, excess: null, level: 'unknown', darker: b.house.L < a.house.L - 3 }); continue; }
      const base = median(nd), spread = mad(nd);
      const excess = dh - base;
      const rank = nd.filter(v => v < dh).length / nd.length; // share of neighbours that changed less than this roof
      let level = 'none';
      if (excess > Math.max(10, 3 * spread + 4) && rank >= 0.8) level = 'likely';
      else if (excess > Math.max(6, 2 * spread + 2) && rank >= 0.7) level = 'possible';
      changes.push({ from: usable[k - 1], to: usable[k], houseDelta: dh, neighbourDelta: base, spread, excess, rank, level, darker: b.house.L < a.house.L - 3, n: nd.length });
    }
    return { usable, notVisible, changes };
  }

  /** Plain-English summary of the roof history. dates: array of Date for each series index. */
  function summarize(result, dates) {
    const fmt = d => d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    const { usable, changes, notVisible } = result;
    if (usable.length < 2) return { headline: 'Not enough clear aerial photos of this roof to compare.', level: 'unknown' };
    const strong = changes.filter(c => c.level === 'likely');
    const weak = changes.filter(c => c.level === 'possible');
    const last = strong.length ? strong[strong.length - 1] : null;
    const first = dates[usable[0]], latest = dates[usable[usable.length - 1]];
    if (last) {
      const yrs = (Date.now() - dates[last.to].getTime()) / 3.15576e10;
      return {
        level: 'likely', from: dates[last.from], to: dates[last.to],
        headline: `Roof most likely replaced between ${fmt(dates[last.from])} and ${fmt(dates[last.to])}`,
        detail: `The roof changed colour much more than the neighbours' roofs between those two photos${last.darker ? ' and got darker, which is typical of new shingles' : ''}. That makes the roof about ${Math.max(0, Math.floor(yrs))}–${Math.ceil(yrs + (dates[last.to] - dates[last.from]) / 3.15576e10)} years old.`
      };
    }
    if (weak.length) {
      const w = weak[weak.length - 1];
      return {
        level: 'possible', from: dates[w.from], to: dates[w.to],
        headline: `Possible roof change between ${fmt(dates[w.from])} and ${fmt(dates[w.to])}`,
        detail: 'The roof changed more than most neighbours, but not by enough to be sure. Compare those two photos below.'
      };
    }
    const builtNote = notVisible.length && notVisible[0] < usable[0] ? ` The house is not visible in photos before ${fmt(first)}, so it may have been built around then.` : '';
    return {
      level: 'none', from: first, to: latest,
      headline: `No roof replacement seen from ${fmt(first)} to ${fmt(latest)}`,
      detail: `The roof looks the same in every clear photo in that period.${builtNote} A roof replaced after ${fmt(latest)} would not show up yet.`
    };
  }

  // ---------- imagery sources (browser) ----------
  const fetchJSON = (u, t) => root.Ohio.getJSON(u, t);
  const OSIP3 = 'https://maps.ohio.gov/image/rest/services/osip_3_cache/MapServer';
  const OSIPCUR = 'https://maps.ohio.gov/image/rest/services/osip_most_current_cache/MapServer';
  const OSIPCUR_IS = 'https://maps.ohio.gov/image/rest/services/osip_most_current/ImageServer';
  const OSIP_IDX_CUR = 'https://maps.ohio.gov/arcgis/rest/services/Hosted/OSIP_Index_June_2026/FeatureServer/0';
  const OSIP_IDX_OLD = 'https://maps.ohio.gov/arcgis/rest/services/Hosted/OSIP_Most_Current_Index/FeatureServer/0';
  const CAGIS = 'https://cagisonline.hamilton-co.org/arcgis/rest/services/Basemaps';
  const WB_CFG = 'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json';
  const pt = p => `geometry=${p.lon},${p.lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects`;
  const tileOf = (p, z) => { const n = 2 ** z; return { x: Math.floor((p.lon + 180) / 360 * n), y: Math.floor((1 - Math.log(Math.tan(p.lat * Math.PI / 180) + 1 / Math.cos(p.lat * Math.PI / 180)) / Math.PI) / 2 * n) }; };

  async function waybackConfig() {
    try { const c = JSON.parse(localStorage.getItem('hs_wbcfg') || 'null'); if (c && Date.now() - c.t < 7 * 864e5) return c.v; } catch { }
    const v = await fetchJSON(WB_CFG, 20000);
    try { localStorage.setItem('hs_wbcfg', JSON.stringify({ t: Date.now(), v })); } catch { }
    return v;
  }

  /** Every distinct Esri capture at this spot (newest first). ~2 requests per capture. */
  async function waybackCaptures(p) {
    const cfg = await waybackConfig();
    const rel = Object.entries(cfg).map(([id, v]) => ({ id: +id, date: (v.itemTitle.match(/\d{4}-\d{2}-\d{2}/) || [''])[0], url: v.itemURL, meta: v.metadataLayerUrl })).filter(r => r.date).sort((a, b) => b.date.localeCompare(a.date));
    const z = 19, t = tileOf(p, z), steps = [];
    let i = 0;
    while (i < rel.length && steps.length < 25) {
      let r;
      try { r = await fetchJSON(`https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tilemap/${rel[i].id}/${z}/${t.y}/${t.x}`, 12000); } catch { break; }
      if (!r || !r.data || !r.data[0]) break;
      const sel = (r.select && r.select[0]) || rel[i].id;
      const idx = rel.findIndex(q => q.id === sel);
      if (idx < 0) break;
      steps.push(rel[idx]);
      i = idx + 1;
    }
    const caps = await Promise.all(steps.map(async s => {
      try {
        const m = await fetchJSON(`${s.meta}/identify?geometry=${p.lon},${p.lat}&geometryType=esriGeometryPoint&sr=4326&layers=all&tolerance=0&mapExtent=${p.lon - 0.001},${p.lat - 0.001},${p.lon + 0.001},${p.lat + 0.001}&imageDisplay=400,400,96&returnGeometry=false&f=json`, 12000);
        const a = (m.results || []).map(x => x.attributes).find(x => +x.MinMapLevel <= 19 && +x.MaxMapLevel >= 19) || ((m.results || [])[0] || {}).attributes;
        if (!a || !a.SRC_DATE) return null;
        const d = String(a.SRC_DATE); const date = new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8) || 1);
        return { key: 'esri-' + d + a.NICE_NAME, date, label: `${a.NICE_NAME || 'Satellite'} (${(+a.SRC_RES || 0.5).toFixed(1)} m)`, source: 'Esri World Imagery', kind: 'tiles', z: 19, tile: (z, y, x) => s.url.replace('{level}', z).replace('{row}', y).replace('{col}', x) };
      } catch { return null; }
    }));
    const seen = new Set();
    return caps.filter(c => c && !seen.has(c.key) && seen.add(c.key));
  }

  async function osipCaptures(p) {
    const out = [];
    const [old, cur, idxCur, idxOld] = await Promise.allSettled([
      fetchJSON(`${OSIP3}/2/query?${pt(p)}&where=${encodeURIComponent('Category=1')}&outFields=Name&returnGeometry=false&f=json`),
      fetchJSON(`${OSIPCUR_IS}/query?${pt(p)}&where=${encodeURIComponent('Category<>2')}&outFields=Name,ZOrder&returnGeometry=false&f=json`),
      fetchJSON(`${OSIP_IDX_CUR}/query?${pt(p)}&outFields=year,month_flown,resolution&returnGeometry=false&f=json`),
      fetchJSON(`${OSIP_IDX_OLD}/query?${pt(p)}&outFields=year,month_flown,resolution&returnGeometry=false&f=json`)
    ]);
    const months = {};
    for (const r of [idxCur, idxOld]) if (r.status === 'fulfilled') for (const f of r.value.features || []) months[f.attributes.year] = { m: f.attributes.month_flown, res: f.attributes.resolution };
    const yearOf = n => +((n.match(/(19|20)\d{2}/) || [])[0]);
    const mk = (name, base) => {
      const y = yearOf(name); if (!y) return null;
      const mm = months[y] ? months[y].m : 4;
      return { key: 'osip-' + y, date: new Date(y, (mm || 4) - 1, 15), label: `Ohio aerial ${y}${months[y] ? ` (${months[y].res})` : ''}`, source: 'Ohio Statewide Imagery Program', kind: 'tiles', z: 20, tile: (z, yy, x) => `${base}/tile/${z}/${yy}/${x}` };
    };
    if (old.status === 'fulfilled') for (const f of old.value.features || []) { const c = mk(f.attributes.Name, OSIP3); if (c) out.push(c); }
    if (cur.status === 'fulfilled') {
      // The "most current" cache shows the newest dataset (lowest ZOrder wins). Only add it if it's a different year.
      const names = (cur.value.features || []).map(f => f.attributes).sort((a, b) => (a.ZOrder ?? 99) - (b.ZOrder ?? 99));
      if (names[0]) { const c = mk(names[0].Name, OSIPCUR); if (c && !out.some(o => o.key === c.key)) out.push(c); }
    }
    return out;
  }

  function cagisCaptures() {
    return [1996, 2001, 2006, 2010, 2011, 2015, 2017, 2019, 2020, 2021, 2022, 2023, 2025].map(y => ({
      key: 'cagis-' + y, date: new Date(y, 3, 15), label: `Hamilton County aerial ${y}`, source: 'Hamilton County CAGIS', kind: 'export',
      url: (bb, w, h) => `${CAGIS}/Cagis_Aerial_${y}/MapServer/export?bbox=${bb.join(',')}&bboxSR=3857&imageSR=3857&size=${w},${h}&format=jpg&f=image`
    }));
  }

  function loadImg(src, timeout = 15000) {
    return new Promise(res => {
      const im = new Image(); im.crossOrigin = 'anonymous';
      const t = setTimeout(() => { im.src = ''; res(null); }, timeout);
      im.onload = () => { clearTimeout(t); res(im); }; im.onerror = () => { clearTimeout(t); res(null); };
      im.src = src;
    });
  }

  /** Draw a capture for the mercator bbox [minx,miny,maxx,maxy] into a W×H canvas. */
  async function render(cap, bb, W, H) {
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (cap.kind === 'export') {
      const im = await loadImg(cap.url(bb, W, H));
      if (!im) return null;
      ctx.drawImage(im, 0, 0, W, H);
      return cv;
    }
    const z = cap.z, size = 2 * M / 2 ** z;
    const tx0 = Math.floor((bb[0] + M) / size), tx1 = Math.floor((bb[2] + M) / size);
    const ty0 = Math.floor((M - bb[3]) / size), ty1 = Math.floor((M - bb[1]) / size);
    const jobs = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push(loadImg(cap.tile(z, ty, tx)).then(im => ({ im, tx, ty })));
    const tiles = await Promise.all(jobs);
    if (tiles.filter(t => t.im).length < tiles.length * 0.75) return null;
    const sx = W / (bb[2] - bb[0]), sy = H / (bb[3] - bb[1]);
    for (const { im, tx, ty } of tiles) {
      if (!im) continue;
      const left = tx * size - M, top = M - ty * size;
      ctx.drawImage(im, (left - bb[0]) * sx, (bb[3] - top) * sy, size * sx, size * sy);
    }
    return cv;
  }

  /**
   * Full roof history for a house.
   * house: {geometry:[{lat,lon}]}, neighbours: [{geometry}], opts: {ohio:bool, county:string}
   * onProgress(text) is called with status updates.
   */
  async function history(house, neighbours, opts = {}, onProgress = () => { }) {
    const hm = house.geometry.map(merc);
    const cx = hm.reduce((s, q) => s + q.x, 0) / hm.length, cy = hm.reduce((s, q) => s + q.y, 0) / hm.length;
    // Analysis area: 90 m (mercator) around the house – includes the nearest neighbours.
    const half = 45 / Math.cos(house.geometry[0].lat * Math.PI / 180) * 1; // ~45 m ground each side
    const bb = [cx - half, cy - half, cx + half, cy + half];
    const W = 360, H = 360;
    const toPx = q => ({ x: (q.x - bb[0]) / (bb[2] - bb[0]) * W, y: (bb[3] - q.y) / (bb[3] - bb[1]) * H });
    const housePx = hm.map(toPx);
    const nbPx = neighbours.map(n => n.geometry.map(merc).map(toPx))
      .filter(poly => poly.every(q => q.x > 2 && q.y > 2 && q.x < W - 2 && q.y < H - 2)).slice(0, 25);

    onProgress('Finding dated aerial photos…');
    const p = { lat: house.geometry[0].lat, lon: house.geometry[0].lon };
    const lists = await Promise.allSettled([
      waybackCaptures(p),
      opts.ohio ? osipCaptures(p) : Promise.resolve([]),
      Promise.resolve(/hamilton/i.test(opts.county || '') ? cagisCaptures() : [])
    ]);
    let caps = lists.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    // Same year from two sources: keep the sharper local one (OSIP / CAGIS) over Esri satellite.
    caps.sort((a, b) => a.date - b.date);
    const pref = c => c.source.startsWith('Esri') ? 1 : 0;
    caps = caps.filter((c, i) => !caps.some((d, j) => j !== i && Math.abs(d.date - c.date) < 45 * 864e5 && (pref(d) < pref(c) || (pref(d) === pref(c) && j < i))));
    if (!caps.length) return { photos: [], summary: { headline: 'No aerial photos found for this spot.', level: 'unknown' } };

    const photos = [];
    let done = 0;
    await Promise.all(caps.map(async cap => {
      const cv = await render(cap, bb, W, H).catch(() => null);
      onProgress(`Comparing the roof in ${++done} of ${caps.length} photos…`);
      if (!cv) return;
      let data;
      try { data = cv.getContext('2d').getImageData(0, 0, W, H).data; } catch { return; } // CORS failure
      // Blank / no-coverage image check
      let sum = 0, sum2 = 0; for (let k = 0; k < data.length; k += 16) { const v = data[k] + data[k + 1] + data[k + 2]; sum += v; sum2 += v * v; }
      const nS = data.length / 16, mean = sum / nS, sd = Math.sqrt(Math.max(0, sum2 / nS - mean * mean));
      if (sd < 6) return;
      photos.push({ cap, canvas: cv, house: roofStats(data, W, H, housePx), neighbours: nbPx.map(poly => roofStats(data, W, H, poly)) });
    }));
    photos.sort((a, b) => a.cap.date - b.cap.date);
    const series = photos.map(ph => ({ date: ph.cap.date, house: ph.house, neighbours: ph.neighbours }));
    const result = detectChanges(series);
    const summary = summarize(result, photos.map(ph => ph.cap.date));
    // thumbnails with the house outline (crop the middle 60%)
    const crop = 0.6, cw = W * crop, ox = (W - cw) / 2;
    const changed = new Set(result.changes.filter(c => c.level === 'likely' || c.level === 'possible').flatMap(c => [c.from, c.to]));
    photos.forEach((ph, i) => {
      const t = document.createElement('canvas'); t.width = 240; t.height = 240;
      const c = t.getContext('2d'); c.drawImage(ph.canvas, ox, ox, cw, cw, 0, 0, 240, 240);
      c.strokeStyle = changed.has(i) ? '#ef4444' : '#facc15'; c.lineWidth = 2; c.beginPath();
      housePx.forEach((q, k) => { const x = (q.x - ox) / cw * 240, y = (q.y - ox) / cw * 240; k ? c.lineTo(x, y) : c.moveTo(x, y); }); c.closePath(); c.stroke();
      ph.thumb = t.toDataURL('image/jpeg', 0.85);
      ph.canvas = null;
      ph.flag = changed.has(i);
      ph.hidden = result.notVisible.includes(i);
    });
    return { photos, result, summary };
  }

  const api = { rgb2lab, roofStats, detectChanges, summarize, history, waybackCaptures, osipCaptures };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Roof = api;
})(typeof window !== 'undefined' ? window : globalThis);

async function get(label, url, opts = {}) {
  try {
    const r = await fetch(url, { headers: { Origin: 'https://pratul48.github.io' }, signal: AbortSignal.timeout(25000) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    let show = t; try { if (opts.pick && j) show = JSON.stringify(opts.pick(j)); } catch (e) { show = 'pick err ' + e.message; }
    console.log(`\n### ${label}\nHTTP ${r.status} CORS=${r.headers.get('access-control-allow-origin')} len=${t.length}\n${show.slice(0, opts.max || 1500)}`);
    return j;
  } catch (e) { console.log(`\n### ${label}\nERROR ${e.message}`); return null; }
}
const fieldsOf = j => (j.fields || []).map(f => f.name + (f.alias && f.alias !== f.name ? '=' + f.alias : '') + ':' + (f.type || '').replace('esriFieldType', '')).join(' | ');
const attrs = j => (j.features || []).map(f => f.attributes);
const R = 'https://maps.warrencountyohio.gov/server/rest/services';
const W = [-84.31821, 39.36491], H = [-84.3540, 39.2280];
const pt = ([x, y], d) => `geometry=${x},${y}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects${d ? `&distance=${d}&units=esriSRUnit_Meter` : ''}&returnGeometry=false&f=json`;
(async () => {
  const f = await get('AuditorsMap folder', `${R}/AuditorsMap?f=json`, { max: 2000 });
  for (const s of (f && f.services) || []) {
    const svc = await get('svc ' + s.name, `${R}/${s.name}/${s.type}?f=json`, { pick: j => [...(j.layers || []), ...(j.tables || [])].map(l => l.id + ':' + l.name), max: 1500 });
    for (const l of [...((svc && svc.layers) || []), ...((svc && svc.tables) || [])].filter(l => /parcel|sale|owner|cama|value|apprais|tax|dwell|build|res/i.test(l.name)).slice(0, 8)) {
      const base = `${R}/${s.name}/${s.type}/${l.id}`;
      await get(`  fields ${s.name}/${l.id} ${l.name}`, base + '?f=json', { pick: fieldsOf, max: 3500 });
      await get(`  at point ${s.name}/${l.id}`, `${base}/query?${pt(W)}&outFields=*`, { pick: attrs, max: 2500 });
    }
  }
  for (const fo of ['Dynamic', 'Hosted', 'Maproom']) await get('folder ' + fo, `${R}/${fo}?f=json`, { pick: j => (j.services || []).map(s => s.name + ':' + s.type), max: 1500 });
  await get('Hamilton CLASS type', 'https://cagisonline.hamilton-co.org/arcgis/rest/services/COUNTYWIDE/Cadastral/MapServer/0?f=json', { pick: j => (j.fields || []).filter(x => /CLASS|SALDAT|SALAMT|MKT_TOTAL|ADDRNO|VALID|SALTYP/.test(x.name)).map(x => x.name + ':' + x.type), max: 600 });
  await get('Hamilton comps', `https://cagisonline.hamilton-co.org/arcgis/rest/services/COUNTYWIDE/Cadastral/MapServer/0/query?${pt(H, 800)}&where=${encodeURIComponent('SALAMT > 50000')}&outFields=ADDRNO,ADDRST,SALDAT,SALAMT,MKT_TOTAL_VAL,CLASS,ACREDEED&resultRecordCount=8`, { pick: j => j.error || attrs(j), max: 1500 });
  await get('Hamilton Parcel Attributes layer 2 with sales?', `https://cagisonline.hamilton-co.org/arcgis/rest/services/COUNTYWIDE/Cadastral/MapServer/2/query?where=${encodeURIComponent("PARCELID='6030001002100'")}&outFields=*&f=json`, { pick: j => j.error || attrs(j), max: 1500 });
  await get('search Butler services', 'https://www.arcgis.com/sharing/rest/search?f=json&num=20&q=' + encodeURIComponent('Butler County Ohio Auditor (owner:BCAuditor OR "Butler County Auditor") '), { pick: j => (j.results || []).map(r => [r.title, r.owner, r.type, r.url]), max: 3000 });
})();

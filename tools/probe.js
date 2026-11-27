async function get(label, url, opts = {}) {
  try {
    const r = await fetch(url, { headers: { Origin: 'https://pratul48.github.io' }, signal: AbortSignal.timeout(25000) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    let show = t; try { if (opts.pick && j) show = JSON.stringify(opts.pick(j)); } catch (e) { show = 'pick err ' + e.message; }
    console.log(`\n### ${label}\nHTTP ${r.status} CORS=${r.headers.get('access-control-allow-origin')} len=${t.length}\n${show.slice(0, opts.max || 1500)}`);
    return j ?? t;
  } catch (e) { console.log(`\n### ${label}\nERROR ${e.message}`); return null; }
}
const fieldsOf = j => (j.fields || []).map(f => f.name + (f.alias && f.alias !== f.name ? '=' + f.alias : '')).join(' | ');
const attrs = j => (j.features || []).map(f => f.attributes);
const B = [-84.3570, 39.3480];
const pt = ([x, y], d) => `geometry=${x},${y}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects${d ? `&distance=${d}&units=esriSRUnit_Meter` : ''}&returnGeometry=false&f=json`;
(async () => {
  const s = await get('search butler maps', 'https://www.arcgis.com/sharing/rest/search?f=json&num=10&q=' + encodeURIComponent('"Butler County Auditor GIS Viewer" owner:bcauditor_admin'), { pick: j => (j.results || []).map(r => [r.id, r.title, r.type]), max: 800 });
  const ids = ((s && s.results) || []).filter(r => r.type === 'Web Map').map(r => r.id);
  const urls = new Set();
  for (const id of ids) {
    const d = await get('webmap ' + id, `https://www.arcgis.com/sharing/rest/content/items/${id}/data?f=json`, { max: 100 });
    (JSON.stringify(d || '').match(/https?:\/\/[^"]+?(MapServer|FeatureServer)(\/\d+)?/g) || []).forEach(u => urls.add(u));
  }
  console.log('\n### butler service urls\n' + [...urls].join('\n'));
  for (const u of [...urls].filter(u => /parcel|cama|auditor|tax/i.test(u)).slice(0, 6)) {
    const layer = /\/\d+$/.test(u) ? u : u + '/0';
    await get('fields ' + layer, layer + '?f=json', { pick: fieldsOf, max: 3000 });
    await get('at point ' + layer, `${layer}/query?${pt(B)}&outFields=*`, { pick: attrs, max: 2500 });
  }
  await get('Warren auditor sales page', 'https://auditor.warrencountyohio.gov/RealEstate/Sales/Index', { max: 400 });
  await get('Warren TaxParcels query maxRecord/capabilities', 'https://maps.warrencountyohio.gov/server/rest/services/AuditorsMap/TaxParcels/FeatureServer/0?f=json', { pick: j => ({ max: j.maxRecordCount, caps: j.capabilities, rel: j.relationships }), max: 800 });
  await get('Warren TaxParcels feature service root', 'https://maps.warrencountyohio.gov/server/rest/services/AuditorsMap/TaxParcels/FeatureServer?f=json', { pick: j => ({ layers: j.layers, tables: j.tables }), max: 800 });
})();

async function get(label, url, opts = {}) {
  try {
    const r = await fetch(url, { headers: { Origin: 'https://pratul48.github.io' }, signal: AbortSignal.timeout(30000) });
    const ct = r.headers.get('content-type') || '';
    if (/image/.test(ct)) { const b = Buffer.from(await r.arrayBuffer()); let mean = ''; console.log(`\n### ${label}\nHTTP ${r.status} CORS=${r.headers.get('access-control-allow-origin')} IMAGE ${ct} ${b.length} bytes`); return b; }
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    let show = t; try { if (opts.pick && j) show = JSON.stringify(opts.pick(j)); } catch (e) { show = 'pick error ' + e.message + ' ' + t.slice(0, 200); }
    console.log(`\n### ${label}\nHTTP ${r.status} CORS=${r.headers.get('access-control-allow-origin')} len=${t.length}\n${show.slice(0, opts.max || 1500)}`);
    return j ?? t;
  } catch (e) { console.log(`\n### ${label}\nERROR ${e.message}`); return null; }
}
const attrs = j => (j.features || []).map(f => f.attributes);
const lon = -84.31821, lat = 39.36491;
const IS = 'https://maps.ohio.gov/image/rest/services/osip_most_current/ImageServer';
(async () => {
  const cat = await get('catalog datasets at Mason', `${IS}/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&where=${encodeURIComponent('Category <> 2')}&outFields=OBJECTID,Name,Category,LowPS,ZOrder&returnGeometry=false&f=json`, { pick: attrs, max: 2000 });
  const bb = [lon - 0.00025, lat - 0.0002, lon + 0.00025, lat + 0.0002].join(',');
  for (const f of (cat && cat.features || []).map(f => f.attributes)) {
    const mr = encodeURIComponent(JSON.stringify({ mosaicMethod: 'esriMosaicLockRaster', lockRasterIds: [f.OBJECTID], ascending: true, mosaicOperation: 'MT_FIRST' }));
    await get(`export lock ${f.Name}`, `${IS}/exportImage?bbox=${bb}&bboxSR=4326&imageSR=3857&size=300,300&format=jpg&mosaicRule=${mr}&f=image`);
  }
  await get('osip_3_cache info', 'https://maps.ohio.gov/image/rest/services/osip_3_cache/MapServer?f=json', { pick: j => ({ desc: (j.description || j.serviceDescription || '').slice(0, 300), sr: j.spatialReference && j.spatialReference.wkid, lods: j.tileInfo && j.tileInfo.lods.slice(-3).map(l => l.level), layers: (j.layers || []).map(l => l.name) }), max: 1200 });
  const n = 2 ** 20, x = Math.floor((lon + 180) / 360 * n), y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n);
  await get('osip_3_cache tile z20', `https://maps.ohio.gov/image/rest/services/osip_3_cache/MapServer/tile/20/${y}/${x}`);
  await get('osip_3_cache tile z19', `https://maps.ohio.gov/image/rest/services/osip_3_cache/MapServer/tile/19/${y >> 1}/${x >> 1}`);
  await get('Imagery folder', 'https://maps.ohio.gov/image/rest/services/Imagery?f=json', { max: 2000 });
  await get('OSIP3 index sample anywhere', `https://maps.ohio.gov/arcgis/rest/services/Hosted/OSIP_3_Tile_Index_from_2017_through_2024/FeatureServer/0/query?where=1%3D1&outFields=*&resultRecordCount=2&returnGeometry=false&f=json`, { pick: attrs, max: 1200 });
  await get('OSIP3 index Warren', `https://maps.ohio.gov/arcgis/rest/services/Hosted/OSIP_3_Tile_Index_from_2017_through_2024/FeatureServer/0/query?where=${encodeURIComponent("county='WAR' OR county='Warren' OR folder='WAR'")}&outFields=*&resultRecordCount=2&returnGeometry=false&f=json`, { pick: j => j.error || attrs(j), max: 1200 });
  await get('OSIP3 layer fields', `https://maps.ohio.gov/arcgis/rest/services/Hosted/OSIP_3_Tile_Index_from_2017_through_2024/FeatureServer/0?f=json`, { pick: j => (j.fields || []).map(f => f.name).join(','), max: 800 });
  await get('OSIP index June 2026 fields+Mason', `https://maps.ohio.gov/arcgis/rest/services/Hosted/OSIP_Index_June_2026/FeatureServer/0/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false&f=json`, { pick: attrs, max: 1200 });
  // Hamilton CAGIS yearly exports (house in Montgomery)
  const hl = -84.3540, ht = 39.2280, hb = [hl - 0.0004, ht - 0.0003, hl + 0.0004, ht + 0.0003].join(',');
  for (const yr of ['2010', '2017', '2022', '2024', '2025', '2026', 'Current']) await get('CAGIS ' + yr, `https://cagisonline.hamilton-co.org/arcgis/rest/services/Basemaps/Cagis_Aerial_${yr}/MapServer/export?bbox=${hb}&bboxSR=4326&imageSR=3857&size=300,225&format=jpg&f=image`);
  await get('CAGIS 2025 layers', 'https://cagisonline.hamilton-co.org/arcgis/rest/services/Basemaps/Cagis_Aerial_2025/MapServer?f=json', { pick: j => ({ layers: (j.layers || []).map(l => [l.id, l.name, l.minScale, l.maxScale]), desc: (j.description || '').slice(0, 200), cr: j.copyrightText }), max: 1500 });
})();

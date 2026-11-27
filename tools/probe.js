async function get(label, url, opts = {}) {
  try {
    const r = await fetch(url, { headers: { Origin: 'https://pratul48.github.io' }, signal: AbortSignal.timeout(25000) });
    const ct = r.headers.get('content-type') || '';
    if (/image/.test(ct)) { const b = await r.arrayBuffer(); console.log(`\n### ${label}\nHTTP ${r.status} CORS=${r.headers.get('access-control-allow-origin')} IMAGE ${ct} ${b.byteLength} bytes`); return null; }
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    let show = t; try { if (opts.pick && j) show = JSON.stringify(opts.pick(j)); } catch (e) { show = 'pick error ' + e.message + ' ' + t.slice(0, 200); }
    console.log(`\n### ${label}\nHTTP ${r.status} CORS=${r.headers.get('access-control-allow-origin')} len=${t.length}\n${show.slice(0, opts.max || 1500)}`);
    return j ?? t;
  } catch (e) { console.log(`\n### ${label}\nERROR ${e.message}`); return null; }
}
const attrs = j => (j.features || []).map(f => f.attributes);
const tileXY = (lon, lat, z) => { const n = 2 ** z; return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n)]; };
const pts = [[-84.31821, 39.36491, 'Mason (Warren)'], [-84.3570, 39.3480, 'West Chester (Butler)'], [-84.3540, 39.2280, 'Montgomery (Hamilton)']];
(async () => {
  await get('image folder', 'https://maps.ohio.gov/image/rest/services?f=json', { max: 3000 });
  const c = await get('osip cache info', 'https://maps.ohio.gov/image/rest/services/osip_most_current_cache/MapServer?f=json', { pick: j => ({ desc: (j.description || j.serviceDescription || '').slice(0, 400), sr: j.spatialReference, lods: j.tileInfo && j.tileInfo.lods && j.tileInfo.lods.slice(-4), origin: j.tileInfo && j.tileInfo.origin, rows: j.tileInfo && j.tileInfo.rows, fmt: j.tileInfo && j.tileInfo.format, copyright: j.copyrightText, layers: j.layers }), max: 2500 });
  for (const [lon, lat, nm] of pts) {
    for (const z of [19, 20, 21]) { const [x, y] = tileXY(lon, lat, z); await get(`osip tile z${z} ${nm}`, `https://maps.ohio.gov/image/rest/services/osip_most_current_cache/MapServer/tile/${z}/${y}/${x}`); }
    await get('OSIP_Most_Current_Index ' + nm, `https://maps.ohio.gov/arcgis/rest/services/Hosted/OSIP_Most_Current_Index/FeatureServer/0/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false&f=json`, { pick: attrs, max: 1200 });
    await get('OSIP_4 index ' + nm, `https://maps.ohio.gov/arcgis/rest/services/Hosted/OSIP_4_Tile_Index_from_2024_through_2028/FeatureServer/0/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false&f=json`, { pick: attrs, max: 1200 });
    await get('OSIP_3 index ' + nm, `https://maps.ohio.gov/arcgis/rest/services/Hosted/OSIP_3_Tile_Index_from_2017_through_2024/FeatureServer/0/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false&f=json`, { pick: attrs, max: 1200 });
  }
  await get('osip image service', 'https://maps.ohio.gov/image/rest/services/osip_most_current/ImageServer?f=json', { pick: j => ({ desc: (j.description || '').slice(0, 300), px: j.pixelSizeX, sr: j.spatialReference && j.spatialReference.wkid, fields: (j.fields || []).map(f => f.name).join(',') }), max: 1500 });
  await get('osip image catalog at Mason', `https://maps.ohio.gov/image/rest/services/osip_most_current/ImageServer/query?geometry=-84.31821,39.36491&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false&f=json`, { pick: attrs, max: 1500 });
  const cg = await get('CAGIS 2024 info', 'https://cagisonline.hamilton-co.org/arcgis/rest/services/Basemaps/Cagis_Aerial_2024/MapServer?f=json', { pick: j => ({ sr: j.spatialReference, lods: j.tileInfo && j.tileInfo.lods && j.tileInfo.lods.slice(-3), origin: j.tileInfo && j.tileInfo.origin, single: j.singleFusedMapCache, fmt: j.tileInfo && j.tileInfo.format, ext: j.fullExtent }), max: 1500 });
  await get('CAGIS 2024 export', 'https://cagisonline.hamilton-co.org/arcgis/rest/services/Basemaps/Cagis_Aerial_2024/MapServer/export?bbox=-84.3545,39.2276,-84.3535,39.2284&bboxSR=4326&imageSR=3857&size=256,256&format=jpg&f=image');
  await get('CAGIS 2010 export', 'https://cagisonline.hamilton-co.org/arcgis/rest/services/Basemaps/Cagis_Aerial_2010/MapServer/export?bbox=-84.3545,39.2276,-84.3535,39.2284&bboxSR=4326&imageSR=3857&size=256,256&format=jpg&f=image');
  await get('Ohio osip export', 'https://maps.ohio.gov/image/rest/services/osip_most_current_cache/MapServer/export?bbox=-84.3184,39.3647,-84.3180,39.3651&bboxSR=4326&imageSR=3857&size=256,256&format=jpg&f=image');
  await get('osip2 1ft', 'https://geo1.oit.ohio.gov/arcgis/rest/services/OSIP/osip_best_avail_1ft/ImageServer?f=json', { max: 300 });
})();

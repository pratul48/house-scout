const H = { 'User-Agent': 'house-scout-probe/1.0 (github actions)', Origin: 'https://pratul48.github.io' };
async function get(label, url, opts = {}) {
  try {
    const r = await fetch(url, { ...opts, headers: { ...H, ...(opts.headers || {}) }, signal: AbortSignal.timeout(30000) });
    const t = await r.text();
    console.log(`\n### ${label}\nHTTP ${r.status} CORS=${r.headers.get('access-control-allow-origin')} len=${t.length}\n${t.slice(0, opts.max || 1500)}`);
    try { return JSON.parse(t); } catch { return null; }
  } catch (e) { console.log(`\n### ${label}\nERROR ${e.message}`); return null; }
}
(async () => {
  const addr = '6000 Mason Montgomery Rd, Mason, OH 45040';
  await get('LBRS locator', `https://maps.ohio.gov/arcgis/rest/services/LBRSLocator2023/GeocodeServer/findAddressCandidates?SingleLine=${encodeURIComponent(addr)}&outFields=*&outSR=4326&maxLocations=3&f=json`, { max: 2500 });
  await get('Ohio Hosted folder', 'https://maps.ohio.gov/arcgis/rest/services/Hosted?f=json', { max: 12000 });
  await get('OGRIP folder', 'https://maps.ohio.gov/arcgis/rest/services/OGRIP?f=json', { max: 3000 });
  await get('root folder', 'https://maps.ohio.gov/arcgis/rest/services?f=json', { max: 3000 });
  await get('PUCO parcels', 'https://maps.puco.ohio.gov/arcgis/rest/services/ohio_parcels/MapServer?f=json', { max: 1500 });
  await get('PUCO parcels SW fields', 'https://maps.puco.ohio.gov/arcgis/rest/services/ohio_parcels/MapServer/2?f=json', { max: 3000 });
  await get('PUCO parcel at point', 'https://maps.puco.ohio.gov/arcgis/rest/services/ohio_parcels/MapServer/2/query?geometry=-84.3099,39.3601&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false&f=json', { max: 2500 });
  await get('LBRS centerlines', 'https://maps.ohio.gov/arcgis/rest/services/Hosted/Ohio_Statewide_LBRS_Centerlines/FeatureServer/0?f=json', { max: 2500 });
  await get('schools2526', 'https://maps.ohio.gov/arcgis/rest/services/Hosted/schools2526_Geocoded/FeatureServer/0?f=json', { max: 3000 });
  await get('USA structures search', 'https://www.arcgis.com/sharing/rest/search?f=json&num=8&q=' + encodeURIComponent('title:"USA Structures" type:"Feature Service"'), { max: 4000 });
  await get('Warren county search', 'https://www.arcgis.com/sharing/rest/search?f=json&num=15&q=' + encodeURIComponent('Warren County Ohio (parcels OR building OR footprints OR address) type:"Feature Service"'), { max: 5000 });
  await get('child care search', 'https://www.arcgis.com/sharing/rest/search?f=json&num=10&q=' + encodeURIComponent('Ohio child care providers type:"Feature Service"'), { max: 5000 });
  await get('wayback config', 'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json', { max: 800 });
  await get('census acs', 'https://api.census.gov/data/2023/acs/acs5?get=NAME,B01001_003E,B01001_027E&for=tract:*&in=state:39%20county:165', { max: 600 });
  await get('tigerweb bg', 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_ACS2023/MapServer/10/query?geometry=-84.3099,39.3601&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=GEOID,STATE,COUNTY,TRACT,BLKGRP&returnGeometry=false&f=json', { max: 800 });
  await get('nominatim', 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(addr), { max: 800 });
  await get('overpass buildings near mason', 'https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent('[out:json];way["building"](around:400,39.3540,-84.3200);out count;'), max: 600 });
})();

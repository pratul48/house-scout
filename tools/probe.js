const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
async function get(label, url, opts = {}) {
  try {
    const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, Origin: 'https://pratul48.github.io', Accept: '*/*', ...(opts.headers || {}) }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    let t = await r.text();
    if (opts.grep) { const re = new RegExp(opts.grep, 'gi'); const hits = []; let m; while ((m = re.exec(t)) && hits.length < 25) hits.push(t.slice(Math.max(0, m.index - 150), m.index + 250).replace(/\s+/g, ' ')); t = hits.join('\n  ~ ') || '(no grep hits) ' + t.slice(0, 400); }
    console.log(`\n### ${label}\nHTTP ${r.status} CORS=${r.headers.get('access-control-allow-origin')} url=${r.url} len=${t.length}\n${t.slice(0, opts.max || 1500)}`);
    try { return JSON.parse(t.replace(/^\{\}&&/, '')); } catch { return t; }
  } catch (e) { console.log(`\n### ${label}\nERROR ${e.message}`); return null; }
}
const O = 'https://maps.ohio.gov/arcgis/rest/services/Hosted';
(async () => {
  // a real Mason house: find one address point near downtown Mason
  const ap = await get('LBRS address points layer', `${O}/Ohio_Statewide_LBRS_Address_Points/FeatureServer/0?f=json`, { max: 6000 });
  const near = await get('address points near Mason', `${O}/Ohio_Statewide_LBRS_Address_Points/FeatureServer/0/query?geometry=-84.3175,39.3655&geometryType=esriGeometryPoint&inSR=4326&distance=150&units=esriSRUnit_Meter&outFields=*&outSR=4326&returnGeometry=true&resultRecordCount=5&f=json`, { max: 4000 });
  await get('centerlines near Mason', `https://maps.ohio.gov/arcgis/rest/services/Hosted/Ohio_Statewide_LBRS_Centerlines/FeatureServer/0/query?geometry=-84.3175,39.3655&geometryType=esriGeometryPoint&inSR=4326&distance=120&units=esriSRUnit_Meter&outFields=str_name,str_type,str_pre,stype,speed,lanes,l_add_from,l_add_to,r_add_from,r_add_to&outSR=4326&returnGeometry=true&resultRecordCount=4&f=json`, { max: 3000 });
  for (const s of ['Ohio_Day_Care_Centers', 'Ohio_Daycares_view', 'AllProviderDataProd23_view', 'AllProviderDataProdFeatures']) {
    await get('daycare layer ' + s, `${O}/${s}/FeatureServer/0?f=json`, { max: 200, grep: '"fields":\\[|"name":"[^"]+","type":"esriField|editingInfo|lastEditDate' });
    await get('daycare sample ' + s, `${O}/${s}/FeatureServer/0/query?geometry=-84.3175,39.3655&geometryType=esriGeometryPoint&inSR=4326&distance=4000&units=esriSRUnit_Meter&outFields=*&returnGeometry=false&resultRecordCount=3&returnCountOnly=false&f=json`, { max: 2500 });
    await get('daycare count ' + s, `${O}/${s}/FeatureServer/0/query?geometry=-84.3175,39.3655&geometryType=esriGeometryPoint&inSR=4326&distance=4000&units=esriSRUnit_Meter&returnCountOnly=true&f=json`, { max: 200 });
  }
  await get('schools2526 sample', `${O}/schools2526_Geocoded/FeatureServer/0/query?geometry=-84.3175,39.3655&geometryType=esriGeometryPoint&inSR=4326&distance=5000&units=esriSRUnit_Meter&outFields=*&returnGeometry=false&resultRecordCount=3&f=json`, { max: 3000 });
  await get('school districts', `${O}/Ohio_School_Districts_2025/FeatureServer/0/query?geometry=-84.3175,39.3655&geometryType=esriGeometryPoint&inSR=4326&outFields=*&returnGeometry=false&f=json`, { max: 1500 });
  // Wayback imagery
  const cfg = await get('wayback config', 'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json', { max: 300 });
  if (cfg && typeof cfg === 'object') {
    const ids = Object.keys(cfg).map(Number).sort((a, b) => b - a);
    console.log('releases', ids.length, JSON.stringify(cfg[ids[0]]), JSON.stringify(cfg[ids[ids.length - 1]]));
    const z = 19, lat = 39.3655, lon = -84.3175, n = 2 ** z;
    const x = Math.floor((lon + 180) / 360 * n), y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n);
    await get('wayback tilemap', `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tilemap/${ids[0]}/${z}/${y}/${x}`, { max: 400 });
    const r = await fetch(`https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${ids[0]}/${z}/${y}/${x}`, { headers: { Origin: 'https://pratul48.github.io' } });
    console.log('\n### wayback tile', r.status, r.headers.get('content-type'), 'CORS=' + r.headers.get('access-control-allow-origin'));
    const m = cfg[ids[0]].metadataLayerUrl;
    if (m) await get('wayback metadata', `${m}/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false&f=json`, { max: 1500 });
    if (m) await get('wayback metadata service', `${m.replace(/\/\d+$/, '')}?f=json`, { max: 1500 });
  }
  // listing / auditor sources
  const addr = '6000 Mason Montgomery Rd, Mason, OH 45040';
  await get('redfin autocomplete', 'https://www.redfin.com/stingray/do/location-autocomplete?v=2&location=' + encodeURIComponent('4855 Wexford Way Mason OH'), { max: 1500 });
  await get('zillow search', 'https://www.zillow.com/homes/' + encodeURIComponent('4855 Wexford Way Mason OH 45040') + '_rb/', { max: 300, grep: 'roof|captcha|px-captcha|denied' });
  await get('realtor', 'https://www.realtor.com/api/v1/hulk_main_srp?client_id=rdc-x&schema=vesta', { max: 300 });
  await get('wcauditor summary', 'https://www.wcauditor.org/Property_Search/summary.aspx?account_nbr=1102745', { max: 500, grep: 'roof|year built|permit|remodel' });
  await get('warren auditor new', 'https://auditor.warrencountyohio.gov/PropertySearch/Property/Index?parcelNumber=16362870050', { max: 500, grep: 'roof|year built|permit|remodel|building' });
  await get('census B23008', 'https://api.census.gov/data/2023/acs/acs5?get=B23008_001E,B23008_002E,B23008_004E,B23008_008E,B23008_010E,B23008_013E,B01001_003E,B01001_027E,B19013_001E&for=block%20group:*&in=state:39%20county:165%20tract:032001', { max: 800 });
  await get('census variables B23008', 'https://api.census.gov/data/2023/acs/acs5/groups/B23008.json', { max: 200, grep: 'B23008_0\\d\\dE":\\{"label":"[^"]+' });
})();

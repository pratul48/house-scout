const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
async function get(label, url, opts = {}) {
  try {
    const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, Origin: 'https://pratul48.github.io', ...(opts.headers || {}) }, signal: AbortSignal.timeout(25000) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    let show = t; try { if (opts.pick && j) show = JSON.stringify(opts.pick(j)); } catch (e) { show = 'pick error ' + e.message + ' ' + t.slice(0, 300); }
    console.log(`\n### ${label}\nHTTP ${r.status} CORS=${r.headers.get('access-control-allow-origin')} len=${t.length}\n${show.slice(0, opts.max || 1500)}`);
    return j ?? t;
  } catch (e) { console.log(`\n### ${label}\nERROR ${e.message}`); return null; }
}
const items = j => (j.results || []).map(r => [r.title, r.owner, r.url]);
const fieldsOf = j => (j.fields || []).map(f => f.name + (f.alias && f.alias !== f.name ? '=' + f.alias : '')).join(' | ');
const lon = -84.31821, lat = 39.36491;
const pt = `geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects`;
const attrs = j => (j.features || []).map(f => f.attributes);
(async () => {
  const OGP = 'https://services2.arcgis.com/MlJ0G8iWUyC7jAmu/arcgis/rest/services/OhioStatewidePacels_full_view/FeatureServer/0';
  await get('OGRIP parcels fields', OGP + '?f=json', { pick: j => ({ f: fieldsOf(j), max: j.maxRecordCount }), max: 4000 });
  await get('OGRIP parcel at point', `${OGP}/query?${pt}&outFields=*&returnGeometry=false&f=json`, { pick: attrs, max: 2500 });
  const US = 'https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0';
  await get('USA Structures fields', US + '?f=json', { pick: j => ({ f: fieldsOf(j), max: j.maxRecordCount, name: j.name }), max: 3000 });
  await get('USA Structures at point', `${US}/query?${pt}&outFields=*&outSR=4326&returnGeometry=true&f=json`, { max: 2500 });
  const MS = 'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/MSBFP2/FeatureServer/0';
  await get('MSBFP2 at point', `${MS}/query?${pt}&outFields=*&outSR=4326&returnGeometry=true&f=json`, { max: 1500 });
  await get('USA Structures near count', `${US}/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&distance=80&units=esriSRUnit_Meter&returnCountOnly=true&f=json`, { max: 300 });
  // census-like layers from Esri Living Atlas
  const L = 'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services';
  for (const s of ['ACS_Children_by_Parental_Labor_Force_Participation_Boundaries', 'ACS_Population_by_Age_Boundaries' , 'ACS_Highlights_Child_Well_Being_Boundaries', 'ACS_Median_Income_by_Race_and_Age_Selp_Emp_Boundaries', 'ACS_Context_for_Child_Well_Being_Boundaries']) {
    await get('svc ' + s, `${L}/${s}/FeatureServer?f=json`, { pick: j => (j.layers || []).map(l => l.id + ':' + l.name), max: 600 });
  }
  await get('search ACS age sex', 'https://www.arcgis.com/sharing/rest/search?f=json&num=15&q=' + encodeURIComponent('owner:esri_demographics title:"ACS Population by Age" OR title:"ACS Age"'), { pick: items, max: 2500 });
  await get('search ACS income', 'https://www.arcgis.com/sharing/rest/search?f=json&num=10&q=' + encodeURIComponent('owner:esri_demographics title:"Median Household Income" ACS Latest'), { pick: items, max: 2500 });
  await get('search ACS child well', 'https://www.arcgis.com/sharing/rest/search?f=json&num=10&q=' + encodeURIComponent('owner:esri_demographics "Child Well-Being" Latest'), { pick: items, max: 2500 });
  const PL = 'https://P3ePLMYs2RVChkJx.svcs.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/ACS_Children_by_Parental_Labor_Force_Participation_View_Boundaries/FeatureServer';
  await get('PLFP layers', PL + '?f=json', { pick: j => (j.layers || []).map(l => l.id + ':' + l.name), max: 600 });
  await get('PLFP fields L2', PL + '/2?f=json', { pick: j => ({ f: fieldsOf(j) }), max: 6000 });
  await get('PLFP at point L2', `${PL}/2/query?${pt}&outFields=*&returnGeometry=false&f=json`, { pick: attrs, max: 3000 });
  // auditor / county
  await get('Warren auditor main', 'https://auditor.warrencountyohio.gov/', { max: 300 });
  await get('search warren owner items', 'https://www.arcgis.com/sharing/rest/search?f=json&num=25&bbox=-84.45,39.28,-84.0,39.6&q=' + encodeURIComponent('warren type:"Feature Service" OR type:"Map Service"'), { pick: items, max: 4000 });
  await get('Hamilton cadastral', 'https://cagisonline.hamilton-co.org/arcgis/rest/services/COUNTYWIDE/Cadastral/MapServer?f=json', { pick: j => (j.layers || []).map(l => l.id + ':' + l.name), max: 1500 });
  await get('Butler GIS search', 'https://www.arcgis.com/sharing/rest/search?f=json&num=15&q=' + encodeURIComponent('Butler County Ohio auditor parcels type:"Feature Service" OR type:"Map Service"'), { pick: items, max: 3000 });
  await get('schools2526 more fields', 'https://maps.ohio.gov/arcgis/rest/services/Hosted/schools2526_Geocoded/FeatureServer/0?f=json', { pick: j => fieldsOf(j).split(' | ').filter(f => /user_|grade|level|type|irn|name/i.test(f)).join(' | '), max: 3000 });
  await get('NCES admin fields', 'https://nces.ed.gov/opengis/rest/services/K12_School_Locations/EDGE_ADMINDATA_PUBLICSCH_2425/MapServer/0?f=json', { pick: j => fieldsOf(j), max: 3000 });
  await get('NCES admin near', `https://nces.ed.gov/opengis/rest/services/K12_School_Locations/EDGE_ADMINDATA_PUBLICSCH_2425/MapServer/0/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&distance=5000&units=esriSRUnit_Meter&outFields=*&returnGeometry=false&resultRecordCount=2&f=json`, { pick: attrs, max: 2500 });
  // wayback tilemap walk test
  const cfg = await get('wayback cfg', 'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json', { max: 50 });
  const z = 19, n = 2 ** z, x = Math.floor((lon + 180) / 360 * n), y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n);
  const ids = Object.keys(cfg).map(Number).sort((a, b) => b - a);
  let cur = ids[0]; const seen = [];
  for (let k = 0; k < 40 && cur; k++) {
    const r = await (await fetch(`https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tilemap/${cur}/${z}/${y}/${x}`)).json().catch(() => null);
    const sel = r && r.select && r.select[0] ? r.select[0] : (r && r.data && r.data[0] ? cur : null);
    if (!sel) { seen.push([cur, 'none', JSON.stringify(r)]); break; }
    const meta = cfg[sel].metadataLayerUrl;
    const m = await (await fetch(`${meta}/identify?geometry=${lon},${lat}&geometryType=esriGeometryPoint&sr=4326&layers=all&tolerance=0&mapExtent=${lon - 0.001},${lat - 0.001},${lon + 0.001},${lat + 0.001}&imageDisplay=400,400,96&returnGeometry=false&f=json`)).json().catch(() => null);
    const a = m && m.results && m.results[0] && m.results[0].attributes;
    seen.push([cur, sel, cfg[sel].itemTitle, a && a.SRC_DATE, a && a.NICE_NAME, a && a.SRC_RES, JSON.stringify(r)]);
    const older = ids.filter(i => i < sel); cur = older[0];
  }
  console.log('\n### wayback walk\n' + seen.map(s => s.join(' | ')).join('\n'));
  // level 20 availability
  const z2 = 20, n2 = 2 ** z2, x2 = Math.floor((lon + 180) / 360 * n2), y2 = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n2);
  const t20 = await fetch(`https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${ids[0]}/${z2}/${y2}/${x2}`);
  console.log('\n### z20 tile', t20.status, t20.headers.get('content-type'), t20.headers.get('content-length'));
})();

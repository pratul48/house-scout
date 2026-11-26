const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
async function get(label, url, opts = {}) {
  try {
    const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, Origin: 'https://pratul48.github.io', ...(opts.headers || {}) }, signal: AbortSignal.timeout(25000) });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    const show = opts.pick && j ? JSON.stringify(opts.pick(j)) : t;
    console.log(`\n### ${label}\nHTTP ${r.status} CORS=${r.headers.get('access-control-allow-origin')} len=${t.length}\n${show.slice(0, opts.max || 1500)}`);
    return j ?? t;
  } catch (e) { console.log(`\n### ${label}\nERROR ${e.message}`); return null; }
}
const items = j => (j.results || []).map(r => [r.title, r.owner, r.url, r.type]);
const fieldsOf = j => (j.fields || []).map(f => f.name + ':' + (f.alias || '')).join(' | ');
const lon = -84.31821, lat = 39.36491; // 5517 Patriot Ct, Mason (LBRS point)
const pt = `geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects`;
(async () => {
  await get('site home', 'https://pratulsaini.fyi/', { max: 300 });
  await get('site house path', 'https://pratulsaini.fyi/house/', { max: 200 });
  await get('search USA Structures', 'https://www.arcgis.com/sharing/rest/search?f=json&num=12&q=' + encodeURIComponent('"USA Structures" owner:FEMA_GIS OR owner:fema_admin OR owner:FEMA'), { pick: items, max: 3000 });
  await get('search USA Structures 2', 'https://www.arcgis.com/sharing/rest/search?f=json&num=12&q=' + encodeURIComponent('title:"USA Structures" type:"Feature Service"'), { pick: items, max: 3000 });
  await get('search MS footprints', 'https://www.arcgis.com/sharing/rest/search?f=json&num=12&q=' + encodeURIComponent('Microsoft Building Footprints type:"Feature Service" owner:esri'), { pick: items, max: 3000 });
  await get('search Warren buildings', 'https://www.arcgis.com/sharing/rest/search?f=json&num=20&bbox=-84.33,39.35,-84.30,39.38&q=' + encodeURIComponent('(building OR footprint OR structure) type:"Feature Service"'), { pick: items, max: 4000 });
  await get('search Warren auditor', 'https://www.arcgis.com/sharing/rest/search?f=json&num=20&bbox=-84.33,39.35,-84.30,39.38&q=' + encodeURIComponent('(parcel OR auditor OR CAMA) type:"Feature Service"'), { pick: items, max: 4000 });
  await get('search Warren mapserver', 'https://www.arcgis.com/sharing/rest/search?f=json&num=20&q=' + encodeURIComponent('Warren County Ohio type:"Map Service"'), { pick: items, max: 4000 });
  await get('search ACS age', 'https://www.arcgis.com/sharing/rest/search?f=json&num=12&q=' + encodeURIComponent('ACS "Age and Sex" Boundaries owner:esri_demographics'), { pick: items, max: 3000 });
  await get('search ACS parents', 'https://www.arcgis.com/sharing/rest/search?f=json&num=12&q=' + encodeURIComponent('ACS children parents labor force owner:esri_demographics'), { pick: items, max: 3000 });
  await get('search ACS households children', 'https://www.arcgis.com/sharing/rest/search?f=json&num=12&q=' + encodeURIComponent('ACS household children under 18 owner:esri_demographics'), { pick: items, max: 3000 });
  await get('NCES schools', `https://nces.ed.gov/opengis/rest/services/K12_School_Locations/EDGE_GEOCODE_PUBLICSCH_2324/MapServer/0/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&distance=4000&units=esriSRUnit_Meter&outFields=*&returnGeometry=false&resultRecordCount=2&f=json`, { max: 1500 });
  await get('NCES services', 'https://nces.ed.gov/opengis/rest/services/K12_School_Locations?f=json', { max: 1500 });
  await get('schools2526 fields', 'https://maps.ohio.gov/arcgis/rest/services/Hosted/schools2526_Geocoded/FeatureServer/0?f=json', { pick: fieldsOf, max: 5000 });
  await get('daycare program types', `https://maps.ohio.gov/arcgis/rest/services/Hosted/Ohio_Daycares_view/FeatureServer/0/query?where=1%3D1&outStatistics=${encodeURIComponent(JSON.stringify([{ statisticType: 'count', onStatisticField: 'objectid', outStatisticFieldName: 'n' }]))}&groupByFieldsForStatistics=program_type&f=json`, { pick: j => (j.features || []).map(f => f.attributes), max: 2000 });
  await get('daycare view info', 'https://maps.ohio.gov/arcgis/rest/services/Hosted/Ohio_Daycares_view/FeatureServer/0?f=json', { pick: j => ({ fields: fieldsOf(j), edit: j.editingInfo, desc: (j.description || '').slice(0, 300) }), max: 3000 });
  await get('daycare centers info', 'https://maps.ohio.gov/arcgis/rest/services/Hosted/Ohio_Day_Care_Centers/FeatureServer/0?f=json', { pick: j => ({ edit: j.editingInfo, desc: (j.description || '').slice(0, 300) }), max: 1000 });
  await get('daycare near count by type', `https://maps.ohio.gov/arcgis/rest/services/Hosted/Ohio_Daycares_view/FeatureServer/0/query?${pt.replace('&spatialRel=esriSpatialRelIntersects', '')}&distance=3219&units=esriSRUnit_Meter&outStatistics=${encodeURIComponent(JSON.stringify([{ statisticType: 'count', onStatisticField: 'objectid', outStatisticFieldName: 'n' }]))}&groupByFieldsForStatistics=program_type&f=json`, { pick: j => (j.features || []).map(f => f.attributes), max: 1500 });
  await get('LBRS AP fields', 'https://maps.ohio.gov/arcgis/rest/services/Hosted/Ohio_Statewide_LBRS_Address_Points/FeatureServer/0?f=json', { pick: j => ({ f: fieldsOf(j), max: j.maxRecordCount, desc: (j.description || '').slice(0, 600) }), max: 3000 });
  await get('PUCO parcel geometry', `https://maps.puco.ohio.gov/arcgis/rest/services/ohio_parcels/MapServer/2/query?${pt}&outFields=PIN,COUNTY,AUD_LINK&outSR=4326&returnGeometry=true&f=json`, { max: 1500 });
  await get('wayback meta query L0..', `https://metadata.maptiles.arcgis.com/arcgis/rest/services/World_Imagery_Metadata_2023_r08/MapServer/identify?geometry=${lon},${lat}&geometryType=esriGeometryPoint&sr=4326&layers=all&tolerance=0&mapExtent=${lon - 0.001},${lat - 0.001},${lon + 0.001},${lat + 0.001}&imageDisplay=400,400,96&returnGeometry=false&f=json`, { max: 2500 });
  await get('wayback meta layer 6', `https://metadata.maptiles.arcgis.com/arcgis/rest/services/World_Imagery_Metadata_2023_r08/MapServer/6/query?${pt}&outFields=*&returnGeometry=false&f=json`, { max: 1500 });
  await get('OSIP services', 'https://geo1.oit.ohio.gov/arcgis/rest/services/OSIP?f=json', { max: 1500 });
  await get('OSIP maps.ohio', 'https://maps.ohio.gov/arcgis/rest/services/OSIP?f=json', { max: 1500 });
  await get('Mason permit page', 'https://www.imaginemason.org/services/engineering-building-planning/building-documents/', { max: 300 });
  await get('census key check', 'https://api.census.gov/data/2023/acs/acs5?get=NAME&for=state:39', { max: 300 });
})();

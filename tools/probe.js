async function get(label, url, opts = {}) {
  try {
    const r = await fetch(url, { ...opts, headers: { Origin: 'https://pratul48.github.io', ...(opts.headers || {}) }, signal: AbortSignal.timeout(25000) });
    const ct = r.headers.get('content-type') || '';
    if (/image/.test(ct)) { const b = await r.arrayBuffer(); console.log(`\n### ${label}\nHTTP ${r.status} CORS=${r.headers.get('access-control-allow-origin')} IMAGE ${ct} ${b.byteLength} bytes`); return null; }
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    let show = t; try { if (opts.pick && j) show = JSON.stringify(opts.pick(j)); } catch (e) { show = 'pick error ' + e.message + ' ' + t.slice(0, 200); }
    console.log(`\n### ${label}\nHTTP ${r.status} CORS=${r.headers.get('access-control-allow-origin')} len=${t.length}\n${show.slice(0, opts.max || 1500)}`);
    return j ?? t;
  } catch (e) { console.log(`\n### ${label}\nERROR ${e.message}`); return null; }
}
const items = j => (j.results || []).map(r => [r.title, r.owner, r.type, r.url, r.modified && new Date(r.modified).toISOString().slice(0, 10)]);
const fieldsOf = j => (j.fields || []).map(f => f.name).join(' | ');
const attrs = j => (j.features || []).map(f => f.attributes);
const lon = -84.31821, lat = 39.36491;
const pt = `geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects`;
const bbox3857 = (() => { const x = lon * 20037508.34 / 180, y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180) * 20037508.34 / 180; return [x - 40, y - 40, x + 40, y + 40].join(','); })();
(async () => {
  await get('NCES 2425 L1 fields', 'https://nces.ed.gov/opengis/rest/services/K12_School_Locations/EDGE_ADMINDATA_PUBLICSCH_2425/MapServer/1?f=json', { pick: fieldsOf, max: 3000 });
  await get('NCES 2425 near', `https://nces.ed.gov/opengis/rest/services/K12_School_Locations/EDGE_ADMINDATA_PUBLICSCH_2425/MapServer/1/query?${pt}&distance=6000&units=esriSRUnit_Meter&outFields=*&returnGeometry=false&resultRecordCount=3&f=json`, { pick: attrs, max: 3000 });
  await get('USGS NAIP info', 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer?f=json', { pick: j => ({ name: j.name, desc: (j.description || '').slice(0, 300), time: j.timeInfo, cell: j.pixelSizeX }), max: 1500 });
  await get('USGS NAIP export', `https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?bbox=${bbox3857}&bboxSR=3857&imageSR=3857&size=256,256&format=jpg&f=image`, {});
  await get('USGS NAIP catalog near', `https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/query?${pt}&outFields=*&returnGeometry=false&f=json`, { pick: attrs, max: 1500 });
  await get('USGS NAIPPlus info', 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer?f=json', { pick: j => ({ name: j.name, time: j.timeInfo, fields: fieldsOf(j) }), max: 1500 });
  await get('USGS NAIPPlus catalog', `https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/query?${pt}&outFields=*&returnGeometry=false&f=json`, { pick: attrs, max: 2000 });
  await get('search warren imagery', 'https://www.arcgis.com/sharing/rest/search?f=json&num=20&bbox=-84.33,39.35,-84.30,39.38&q=' + encodeURIComponent('(imagery OR aerial OR orthophoto OR ortho) (type:"Image Service" OR type:"Map Service" OR type:"WMTS")'), { pick: items, max: 5000 });
  await get('search ohio OSIP', 'https://www.arcgis.com/sharing/rest/search?f=json&num=20&q=' + encodeURIComponent('OSIP Ohio imagery (type:"Image Service" OR type:"Map Service" OR type:"WMTS" OR type:"Tile Layer")'), { pick: items, max: 5000 });
  await get('CAGIS Historic_Aerial', 'https://cagisonline.hamilton-co.org/arcgis/rest/services/Historic_Aerial?f=json', { max: 2500 });
  await get('CAGIS Basemaps', 'https://cagisonline.hamilton-co.org/arcgis/rest/services/Basemaps?f=json', { max: 2500 });
  const PL = 'https://P3ePLMYs2RVChkJx.svcs.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/ACS_Children_by_Parental_Labor_Force_Participation_View_Boundaries/FeatureServer/2';
  const tr = await get('ACS tracts within 3mi', `${PL}/query?${pt}&distance=4828&units=esriSRUnit_Meter&outFields=GEOID,B23008_002E,B23008_004E,B23008_010E,B23008_013E,B23008_015E,B23008_017E,B23008_023E,B23008_026E&outSR=4326&returnGeometry=true&geometryPrecision=5&maxAllowableOffset=0.0005&f=json`, { pick: j => ({ n: (j.features || []).length, a: attrs(j).slice(0, 3) }), max: 1500 });
  if (tr && tr.features) console.log('geometry bytes approx', JSON.stringify(tr).length);
  await get('ACS income tract', `https://P3ePLMYs2RVChkJx.svcs.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/ACS_Median_Household_Income_View_Boundaries/FeatureServer/2/query?${pt}&outFields=GEOID,B19049_001E,B19049_003E&returnGeometry=false&f=json`, { pick: attrs, max: 800 });
  await get('ACS child wellbeing tract', `https://P3ePLMYs2RVChkJx.svcs.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/ACS_Context_for_Child_Well_Being_View_Boundaries/FeatureServer/2/query?${pt}&outFields=GEOID,B01001_001E,B01001_003E,B01001_004E,B01001_005E,B01001_027E,B01001_028E,B01001_029E&returnGeometry=false&f=json`, { pick: attrs, max: 800 });
  await get('ACS tenure/year built search', 'https://www.arcgis.com/sharing/rest/search?f=json&num=10&q=' + encodeURIComponent('owner:esri_demographics title:"Housing Costs" OR title:"Year Structure Built" OR title:"Housing Units"'), { pick: j => (j.results || []).map(r => [r.title, r.url]), max: 2000 });
})();

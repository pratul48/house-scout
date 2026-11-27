async function get(label, url, pick) {
  try { const r = await fetch(url, { headers: { Origin: 'https://pratul48.github.io' }, signal: AbortSignal.timeout(25000) }); const j = await r.json(); console.log(`\n### ${label}\n` + JSON.stringify(pick ? pick(j) : j).slice(0, 2500)); } catch (e) { console.log(`\n### ${label}\nERROR ${e.message}`); }
}
const L = 'https://P3ePLMYs2RVChkJx.svcs.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/ACS_Housing_Costs_View_Boundaries/FeatureServer/2';
const pt = `geometry=-84.31821,39.36491&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&returnGeometry=false&f=json`;
(async () => {
  await get('housing cost fields', L + '?f=json', j => (j.fields || []).filter(f => /B25077|B25075|value|B25035|year/i.test(f.name + f.alias)).map(f => f.name + '=' + f.alias));
  await get('at point', `${L}/query?${pt}&outFields=*`, j => (j.features || []).map(f => Object.fromEntries(Object.entries(f.attributes).filter(([k]) => /B25077|B25035|GEOID|NAME/.test(k)))));
  const Y = 'https://P3ePLMYs2RVChkJx.svcs.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/ACS_Housing_Units_by_Year_Built_View_Boundaries/FeatureServer/2';
  await get('year built at point', `${Y}/query?${pt}&outFields=*`, j => (j.features || []).map(f => Object.fromEntries(Object.entries(f.attributes).filter(([k]) => /B25035|B25034_0\d\dE|GEOID/.test(k)))));
  await get('warren sales-ish fields check hamilton recent', `https://cagisonline.hamilton-co.org/arcgis/rest/services/COUNTYWIDE/Cadastral/MapServer/0/query?geometry=-84.3540,39.2280&geometryType=esriGeometryPoint&inSR=4326&distance=900&units=esriSRUnit_Meter&where=${encodeURIComponent("CLASS=510 AND SALAMT>50000 AND SALDAT >= DATE '2024-11-01'")}&outFields=ADDRNO,ADDRST,ADDRSF,SALDAT,SALAMT,MKT_TOTAL_VAL,VALID,SALTYP,NUMPCL&returnGeometry=false&f=json`, j => j.error || (j.features || []).map(f => f.attributes));
})();

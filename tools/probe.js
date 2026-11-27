async function get(label, url, opts = {}) {
  try {
    const r = await fetch(url, { headers: { Origin: 'https://pratul48.github.io', 'User-Agent': 'Mozilla/5.0 (iPhone) Safari/604.1' }, signal: AbortSignal.timeout(25000) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    let show = t; try { if (opts.pick && j) show = JSON.stringify(opts.pick(j)); } catch (e) { show = 'pick err ' + e.message; }
    console.log(`\n### ${label}\nHTTP ${r.status} CORS=${r.headers.get('access-control-allow-origin')} len=${t.length}\n${show.slice(0, opts.max || 1500)}`);
    return j ?? t;
  } catch (e) { console.log(`\n### ${label}\nERROR ${e.message}`); return null; }
}
const fieldsOf = j => (j.fields || []).map(f => f.name + (f.alias && f.alias !== f.name ? '=' + f.alias : '')).join(' | ');
const attrs = j => (j.features || []).map(f => f.attributes);
const W = [-84.31821, 39.36491], B = [-84.3570, 39.3480], H = [-84.3540, 39.2280];
const pt = ([x, y]) => `geometry=${x},${y}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&returnGeometry=false&f=json`;
(async () => {
  const page = await get('wcgis page', 'https://maps.warrencountyohio.gov/wcgis/webmap/index.html?config=auditor', { max: 200 });
  if (typeof page === 'string') {
    const srcs = [...new Set((page.match(/(src|href)="([^"]+)"/g) || []).map(s => s.split('"')[1]))]; console.log('assets:', srcs.join(' '));
    for (const u of srcs.filter(s => /config|app|main|\.json/i.test(s) && !/css|png|ico/i.test(s)).slice(0, 8)) {
      const full = u.startsWith('http') ? u : 'https://maps.warrencountyohio.gov/wcgis/webmap/' + u.replace(/^\.\//, '');
      const t = await get('asset ' + u, full, { max: 100 });
      if (typeof t === 'string') { const urls = [...new Set(t.match(/https?:\/\/[^"'\s)]+(MapServer|FeatureServer)[^"'\s)]*/gi) || [])]; console.log('  services in ' + u + ':\n  ' + urls.slice(0, 40).join('\n  ')); }
      else if (t) { const s = JSON.stringify(t); const urls = [...new Set(s.match(/https?:\/\/[^"'\s)]+(MapServer|FeatureServer)[^"'\s)]*/gi) || [])]; console.log('  services in ' + u + ':\n  ' + urls.slice(0, 40).join('\n  ')); }
    }
  }
  for (const root of ['https://maps.warrencountyohio.gov/arcgis/rest/services', 'https://maps.warrencountyohio.gov/server/rest/services', 'https://gis.warrencountyohio.gov/arcgis/rest/services', 'https://maps.warrencountyohio.gov/wcgis/rest/services']) await get('root ' + root, root + '?f=json', { max: 1500 });
  // PUCO statewide owner
  await get('PUCO owner Warren', `https://maps.puco.ohio.gov/arcgis/rest/services/ohio_parcels/MapServer/2/query?${pt(W)}&outFields=*`, { pick: attrs, max: 800 });
  // Butler
  await get('Butler search', 'https://www.arcgis.com/sharing/rest/search?f=json&num=20&bbox=-84.38,39.33,-84.33,39.37&q=' + encodeURIComponent('parcel type:"Feature Service" OR type:"Map Service"'), { pick: j => (j.results || []).map(r => [r.title, r.owner, r.url]), max: 3000 });
  for (const root of ['https://gis.bcohio.gov/arcgis/rest/services', 'https://bcgis.bcohio.gov/arcgis/rest/services', 'https://propertysearch.bcohio.gov/arcgis/rest/services', 'https://gis.butlercountyohio.org/arcgis/rest/services']) await get('root ' + root, root + '?f=json', { max: 1200 });
  // Hamilton parcel attributes at point
  await get('Hamilton attrs at point', `https://cagisonline.hamilton-co.org/arcgis/rest/services/COUNTYWIDE/Cadastral/MapServer/0/query?${pt(H)}&outFields=PARCELID,OWNNM1,OWNNM2,SALDAT,SALAMT,SALTYP,VALID,MKTLND,MKTIMP,MKT_TOTAL_VAL,ANNUAL_TAXES,PREVOWN1,CLASS,ADDRNO,ADDRST,ADDRSF,ACREDEED,HMSD_FLAG,FORECL_FLAG,DELQ_TAXES,RENT_REG_FLAG`, { pick: attrs, max: 1500 });
  await get('Hamilton comps (sales last 2y, 400m)', `https://cagisonline.hamilton-co.org/arcgis/rest/services/COUNTYWIDE/Cadastral/MapServer/0/query?geometry=${H[0]},${H[1]}&geometryType=esriGeometryPoint&inSR=4326&distance=800&units=esriSRUnit_Meter&where=${encodeURIComponent("SALAMT > 50000 AND CLASS = '510'")}&outFields=ADDRNO,ADDRST,SALDAT,SALAMT,MKT_TOTAL_VAL&returnGeometry=false&resultRecordCount=10&f=json`, { pick: j => j.error || attrs(j), max: 1500 });
})();

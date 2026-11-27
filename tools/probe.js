const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
async function get(label, url, opts = {}) {
  try {
    const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, Accept: 'text/html,application/json,*/*', 'Accept-Language': 'en-US', ...(opts.headers || {}) }, signal: AbortSignal.timeout(25000) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    let show = t;
    if (opts.grep) { const re = new RegExp(opts.grep, 'gi'); const hits = []; let m; const clean = t.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' '); while ((m = re.exec(clean)) && hits.length < 40) hits.push(clean.slice(Math.max(0, m.index - 60), m.index + 140)); show = hits.join('\n ~ ') || '(no hits) ' + clean.slice(0, 600); }
    try { if (opts.pick && j) show = JSON.stringify(opts.pick(j)); } catch (e) { show = 'pick error ' + e.message; }
    console.log(`\n### ${label}\nHTTP ${r.status} CORS=${r.headers.get('access-control-allow-origin')} final=${r.url} len=${t.length}\n${show.slice(0, opts.max || 1500)}`);
    return j ?? t;
  } catch (e) { console.log(`\n### ${label}\nERROR ${e.message}`); return null; }
}
const fieldsOf = j => (j.fields || []).map(f => f.name + (f.alias && f.alias !== f.name ? '=' + f.alias : '')).join(' | ');
const attrs = j => (j.features || []).map(f => f.attributes);
const lon = -84.31821, lat = 39.36491;
const pt = `geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects`;
(async () => {
  // Warren County auditor property record (CAMA link from statewide parcels)
  const A = 'https://auditor.warrencountyohio.gov/PropertySearch';
  const sum = await get('auditor summary', `${A}/Summary/Index?account_nbr=1129342`, { grep: 'year built|remodel|roof|effective|sale|story|stories|sq|basement|bed|bath|grade|condition|heat|cool|exterior|style', max: 6000 });
  if (typeof sum === 'string') {
    const links = [...new Set((sum.match(/href="([^"]*PropertySearch[^"]*)"/gi) || []).map(s => s.slice(6, -1)))].slice(0, 40);
    console.log('\n### auditor links\n' + links.join('\n'));
    for (const l of links.filter(l => /Building|Residential|Dwelling|Sales|Transfer|Improvement|Permit/i.test(l)).slice(0, 5)) {
      const u = l.startsWith('http') ? l : 'https://auditor.warrencountyohio.gov' + (l.startsWith('/') ? '' : '/') + l.replace(/&amp;/g, '&');
      await get('auditor sub ' + l, u, { grep: 'year built|remodel|roof|effective|sale date|permit|story|grade|condition|exterior', max: 3000 });
    }
  }
  await get('Hamilton parcel attributes fields', 'https://cagisonline.hamilton-co.org/arcgis/rest/services/COUNTYWIDE/Cadastral/MapServer/2?f=json', { pick: fieldsOf, max: 4000 });
  await get('Hamilton parcel poly fields', 'https://cagisonline.hamilton-co.org/arcgis/rest/services/COUNTYWIDE/Cadastral/MapServer/0?f=json', { pick: fieldsOf, max: 2500 });
  await get('CAGIS services root', 'https://cagisonline.hamilton-co.org/arcgis/rest/services?f=json', { max: 2500 });
  await get('Butler propertysearch', 'https://propertysearch.bcohio.gov/search/commonsearch.aspx?mode=address', { max: 300, grep: 'year built|captcha|disclaimer' });
  await get('NCES admin layers', 'https://nces.ed.gov/opengis/rest/services/K12_School_Locations/EDGE_ADMINDATA_PUBLICSCH_2425/MapServer?f=json', { pick: j => (j.layers || []).map(l => l.id + ':' + l.name), max: 800 });
  await get('NCES admin L0 fields', 'https://nces.ed.gov/opengis/rest/services/K12_School_Locations/EDGE_ADMINDATA_PUBLICSCH_2324/MapServer/0?f=json', { pick: fieldsOf, max: 3000 });
  await get('NCES admin near 2324', `https://nces.ed.gov/opengis/rest/services/K12_School_Locations/EDGE_ADMINDATA_PUBLICSCH_2324/MapServer/0/query?where=LSTATE%3D'OH'%20AND%20LCITY%3D'MASON'&outFields=SCH_NAME,GSLO,GSHI,LEVEL,TOTAL,LATCOD,LONCOD,SCHOOL_LEVEL,STITLEI&returnGeometry=false&f=json`, { pick: attrs, max: 2500 });
  await get('ACS income fields', 'https://P3ePLMYs2RVChkJx.svcs.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/ACS_Median_Household_Income_View_Boundaries/FeatureServer/2?f=json', { pick: j => fieldsOf(j).slice(0, 1500), max: 1500 });
  await get('ACS income tract', `https://P3ePLMYs2RVChkJx.svcs.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/ACS_Median_Household_Income_View_Boundaries/FeatureServer/2/query?${pt}&outFields=GEOID,NAME,B19049_001E,B19013_001E&returnGeometry=false&f=json`, { max: 800 });
  await get('ACS child wellbeing tract', `https://P3ePLMYs2RVChkJx.svcs.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/ACS_Context_for_Child_Well_Being_View_Boundaries/FeatureServer/2?f=json`, { pick: j => fieldsOf(j).split(' | ').filter(f => /E=/.test(f)).slice(0, 60).join(' | '), max: 5000 });
  await get('ACS age layer search', 'https://www.arcgis.com/sharing/rest/search?f=json&num=10&q=' + encodeURIComponent('owner:esri_demographics title:"ACS Population Variables" OR title:"Sex by Age"'), { pick: j => (j.results || []).map(r => [r.title, r.url]), max: 2000 });
  await get('daycare view lastEdit', 'https://maps.ohio.gov/arcgis/rest/services/Hosted/Ohio_Daycares_view/FeatureServer/0?f=json', { pick: j => j.editingInfo, max: 300 });
  await get('daycare centers lastEdit', 'https://maps.ohio.gov/arcgis/rest/services/Hosted/Ohio_Day_Care_Centers/FeatureServer/0?f=json', { pick: j => j.editingInfo, max: 300 });
  // Wayback: correct walk ordered by release date
  const cfg = await get('wayback cfg', 'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json', { max: 30 });
  const rel = Object.entries(cfg).map(([id, v]) => ({ id: +id, date: (v.itemTitle.match(/\d{4}-\d{2}-\d{2}/) || [''])[0], meta: v.metadataLayerUrl })).sort((a, b) => b.date.localeCompare(a.date));
  console.log('\n### releases', rel.length, rel[0].date, rel[rel.length - 1].date);
  for (const [plon, plat, nm] of [[lon, lat, 'Patriot Ct'], [-84.2900, 39.3400, 'Mason south'], [-84.3570, 39.3480, 'West Chester']]) {
    const z = 19, n = 2 ** z, x = Math.floor((plon + 180) / 360 * n), y = Math.floor((1 - Math.log(Math.tan(plat * Math.PI / 180) + 1 / Math.cos(plat * Math.PI / 180)) / Math.PI) / 2 * n);
    const out = []; let i = 0, calls = 0;
    while (i < rel.length && calls < 30) {
      calls++;
      const r = await (await fetch(`https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tilemap/${rel[i].id}/${z}/${y}/${x}`)).json().catch(() => null);
      if (!r || !r.data || !r.data[0]) { out.push(rel[i].date + ' no tile'); break; }
      const sel = (r.select && r.select[0]) || rel[i].id;
      const sr = rel.find(q => q.id === sel);
      let src = '';
      if (sr && sr.meta) {
        const m = await (await fetch(`${sr.meta}/identify?geometry=${plon},${plat}&geometryType=esriGeometryPoint&sr=4326&layers=all&tolerance=0&mapExtent=${plon - 0.001},${plat - 0.001},${plon + 0.001},${plat + 0.001}&imageDisplay=400,400,96&returnGeometry=false&f=json`)).json().catch(() => null);
        const a = m && m.results && (m.results.find(q => q.attributes && +q.attributes.MinMapLevel <= 19 && +q.attributes.MaxMapLevel >= 19) || m.results[0]);
        src = a ? `${a.attributes.SRC_DATE2 || a.attributes.SRC_DATE} ${a.attributes.NICE_NAME} ${a.attributes.SRC_RES}m` : 'no-meta';
      }
      out.push(`release ${sr ? sr.date : sel} -> capture ${src}`);
      const idx = rel.findIndex(q => q.id === sel);
      i = (idx >= 0 ? idx : i) + 1;
    }
    console.log(`\n### wayback history ${nm} (${calls} calls)\n` + out.join('\n'));
  }
  await get('OSRM', 'https://router.project-osrm.org/route/v1/driving/-84.31821,39.36491;-84.3,39.33?overview=false', { max: 300 });
  await get('overpass alt', 'https://overpass.private.coffee/api/interpreter', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent('[out:json][timeout:20];nwr["shop"="wholesale"]["name"~"Costco"](around:40000,39.3649,-84.3182);out center;'), max: 800 });
})();

async function get(label, url, opts = {}) {
  try {
    const r = await fetch(url, { headers: { Origin: 'https://pratul48.github.io' }, signal: AbortSignal.timeout(30000) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    let show = t; try { if (opts.pick && j) show = JSON.stringify(opts.pick(j)); } catch (e) { show = 'pick error ' + e.message; }
    console.log(`\n### ${label}\nHTTP ${r.status} len=${t.length}\n${show.slice(0, opts.max || 1500)}`);
    return j;
  } catch (e) { console.log(`\n### ${label}\nERROR ${e.message}`); return null; }
}
const attrs = j => (j.features || []).map(f => f.attributes);
const P = [[-84.31821, 39.36491, 'Mason'], [-84.3570, 39.3480, 'West Chester'], [-84.3540, 39.2280, 'Montgomery'], [-84.2025, 39.4340, 'Lebanon']];
(async () => {
  for (const [lon, lat, nm] of P) {
    const g = `geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&returnGeometry=false&f=json`;
    await get('osip3 footprint ' + nm, `https://maps.ohio.gov/image/rest/services/osip_3_cache/MapServer/2/query?${g}&outFields=*`, { pick: attrs, max: 900 });
    await get('osip3 identify ' + nm, `https://maps.ohio.gov/image/rest/services/osip_3_cache/MapServer/identify?geometry=${lon},${lat}&geometryType=esriGeometryPoint&sr=4326&layers=all&tolerance=1&mapExtent=${lon - 0.001},${lat - 0.001},${lon + 0.001},${lat + 0.001}&imageDisplay=400,400,96&returnGeometry=false&f=json`, { pick: j => (j.results || []).map(r => [r.layerName, r.attributes && (r.attributes.Name || r.attributes.name)]), max: 900 });
    await get('osipcur footprint ' + nm, `https://maps.ohio.gov/image/rest/services/osip_most_current_cache/MapServer/2/query?${g}&outFields=*`, { pick: attrs, max: 900 });
    await get('osipcur catalog ' + nm, `https://maps.ohio.gov/image/rest/services/osip_most_current/ImageServer/query?${g}&where=${encodeURIComponent('Category <> 2')}&outFields=OBJECTID,Name,Category,ZOrder`, { pick: attrs, max: 900 });
    await get('index ' + nm, `https://maps.ohio.gov/arcgis/rest/services/Hosted/OSIP_Index_June_2026/FeatureServer/0/query?${g}&outFields=year,month_flown,resolution,county`, { pick: attrs, max: 400 });
    await get('parcel ' + nm, `https://services2.arcgis.com/MlJ0G8iWUyC7jAmu/arcgis/rest/services/OhioStatewidePacels_full_view/FeatureServer/0/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&distance=40&units=esriSRUnit_Meter&outFields=County,LocalParcelID,SitusAddressAll,CAMADataSite,StateLUC&returnGeometry=false&resultRecordCount=2&f=json`, { pick: attrs, max: 700 });
    await get('structures ' + nm, `https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&distance=60&units=esriSRUnit_Meter&returnCountOnly=true&f=json`, { max: 200 });
  }
  await get('osip3 layer 2 info', 'https://maps.ohio.gov/image/rest/services/osip_3_cache/MapServer/2?f=json', { pick: j => ({ fields: (j.fields || []).map(f => f.name).join(','), caps: j.capabilities }), max: 900 });
  await get('LBRS geocode West Chester', 'https://maps.ohio.gov/arcgis/rest/services/LBRSLocator2023/GeocodeServer/findAddressCandidates?SingleLine=' + encodeURIComponent('7951 Tylersville Rd, West Chester, OH') + '&outFields=Addr_type,Match_addr&maxLocations=2&outSR=4326&f=json', { pick: j => (j.candidates || []).map(c => [c.address, c.score, c.attributes.Addr_type, c.location]), max: 600 });
  await get('LBRS geocode loose', 'https://maps.ohio.gov/arcgis/rest/services/LBRSLocator2023/GeocodeServer/findAddressCandidates?SingleLine=' + encodeURIComponent('5517 patriot ct mason') + '&outFields=Addr_type,Match_addr&maxLocations=3&outSR=4326&f=json', { pick: j => (j.candidates || []).map(c => [c.address, c.score, c.attributes.Addr_type, c.location]), max: 600 });
  await get('LBRS suggest', 'https://maps.ohio.gov/arcgis/rest/services/LBRSLocator2023/GeocodeServer/suggest?text=' + encodeURIComponent('5517 patri') + '&maxSuggestions=5&f=json', { max: 800 });
})();

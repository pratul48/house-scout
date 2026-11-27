(async () => {
  const u = 'https://files.zillowstatic.com/research/public_csvs/zhvi/Zip_zhvi_uc_sfr_tier_0.33_0.67_sm_sa_month.csv';
  try {
    const r = await fetch(u); console.log('### status', r.status, r.headers.get('content-length'), r.headers.get('last-modified'), 'CORS=' + r.headers.get('access-control-allow-origin'));
    const t = await r.text(); const lines = t.split('\n'); const h = lines[0].split(',');
    console.log('### cols', h.length, h.slice(0, 12).join('|'), '...', h.slice(-3).join('|'));
    for (const z of ['45040', '45069', '45242', '45036']) { const l = lines.find(x => x.includes(`"${z}"`) || x.split(',')[2] === z); if (l) { const v = l.split(','); console.log(z, v.slice(0, 9).join('|'), '... 2012-01:', v[h.indexOf('2012-01-31')], 'last:', v[v.length - 1]); } else console.log(z, 'not found'); }
    console.log('### OH zips', lines.filter(l => /,"?OH"?,/.test(l)).length);
  } catch (e) { console.log('ERR', e.message); }
})();

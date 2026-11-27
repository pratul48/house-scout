const zlib = require('zlib');
(async () => {
  for (const f of ['zip_code_market_tracker.tsv000.gz', 'neighborhood_market_tracker.tsv000.gz', 'city_market_tracker.tsv000.gz']) {
    const u = 'https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_market_tracker/' + f;
    try { const r = await fetch(u, { method: 'HEAD' }); console.log('\n### ' + f, r.status, r.headers.get('content-length'), r.headers.get('last-modified')); } catch (e) { console.log(f, 'ERR', e.message); }
  }
  // stream the zip file, print header + first Ohio 45040 rows
  const u = 'https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_market_tracker/zip_code_market_tracker.tsv000.gz';
  const r = await fetch(u);
  const gun = zlib.createGunzip(); let buf = '', header = null, n = 0, hits = [], ohio = 0, t0 = Date.now(), done = false;
  const { Readable } = require('stream');
  Readable.fromWeb(r.body).pipe(gun);
  await new Promise(res => {
    gun.on('data', ch => {
      if (done) return;
      buf += ch.toString(); let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); n++;
        if (!header) { header = line.split('\t').map(s => s.replace(/"/g, '')); console.log('\n### header\n' + header.join(' | ')); continue; }
        if (line.includes('"Zip Code: 45040"')) { if (hits.length < 4) hits.push(line); }
        if (line.includes('\t"OH"\t') || line.includes('"Ohio"')) ohio++;
      }
    });
    gun.on('end', res); gun.on('error', e => { console.log('gz err', e.message); res(); });
  });
  console.log('\n### lines', n, 'ohio', ohio, 'secs', (Date.now() - t0) / 1000);
  console.log('\n### 45040 rows\n' + hits.map(h => h.split('\t').map((v, k) => header[k] + '=' + v).join(' ; ')).join('\n\n'));
})();

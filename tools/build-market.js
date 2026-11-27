// Builds data/zhvi/<zip>.json for every Ohio ZIP from Zillow's free Home Value Index (ZHVI, typical single-family home).
// Run monthly by .github/workflows/market-data.yml. Data © Zillow Research, free to use with attribution.
const fs = require('fs');
const URL = 'https://files.zillowstatic.com/research/public_csvs/zhvi/Zip_zhvi_uc_sfr_tier_0.33_0.67_sm_sa_month.csv';
function parseCSVLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}
(async () => {
  const r = await fetch(URL); if (!r.ok) throw new Error('download failed ' + r.status);
  const lines = (await r.text()).split(/\r?\n/).filter(Boolean);
  const h = parseCSVLine(lines[0]);
  const first = h.findIndex(c => /^\d{4}-\d{2}-\d{2}$/.test(c));
  const months = h.slice(first).map(c => c.slice(0, 7));
  fs.rmSync('data/zhvi', { recursive: true, force: true }); fs.mkdirSync('data/zhvi', { recursive: true });
  const index = {};
  for (const line of lines.slice(1)) {
    const v = parseCSVLine(line), row = Object.fromEntries(h.slice(0, first).map((k, i) => [k, v[i]]));
    if (row.State !== 'OH') continue;
    const zip = row.RegionName.padStart(5, '0');
    const vals = v.slice(first).map(x => x === '' ? null : Math.round(+x / 100) * 100);
    const s = vals.findIndex(x => x != null); if (s < 0) continue;
    fs.writeFileSync(`data/zhvi/${zip}.json`, JSON.stringify({ zip, city: row.City, county: row.CountyName, start: months[s], v: vals.slice(s) }));
    index[zip] = { city: row.City, county: row.CountyName, latest: vals[vals.length - 1] };
  }
  fs.writeFileSync('data/zhvi/index.json', JSON.stringify({ source: 'Zillow Home Value Index (ZHVI), single-family, middle tier, smoothed & seasonally adjusted', url: URL, lastMonth: months[months.length - 1], built: new Date().toISOString(), zips: index }));
  console.log('wrote', Object.keys(index).length, 'Ohio ZIPs through', months[months.length - 1]);
})().catch(e => { console.error(e); process.exit(1); });

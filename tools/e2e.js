const { chromium } = require('playwright');
const ADDRS = (process.env.ADDRS || '').split('|').filter(Boolean).length ? process.env.ADDRS.split('|') : require('./e2e-addrs.json');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
  page.on('requestfailed', r => errors.push(`[reqfail] ${r.url().slice(0, 140)} ${r.failure() && r.failure().errorText}`));
  page.on('response', r => { if (r.status() >= 400) errors.push(`[http ${r.status()}] ${r.url().slice(0, 160)}`); });
  await page.goto('http://localhost:8080/', { waitUntil: 'networkidle' });
  let n = 0;
  for (const a of ADDRS) {
    n++; errors.length = 0;
    const t0 = Date.now();
    const prevTitle = await page.evaluate(() => (document.querySelector('#addr-title') || {}).textContent || '');
    await page.fill('#addr', a);
    await page.click('#search-form button[type=submit]');
    // pick first choice if asked
    try { await page.waitForSelector('#results:not([hidden]), .pick', { timeout: 30000 }); } catch {}
    if (await page.$('.pick')) await page.click('.pick');
    for (let i = 0; i < 40; i++) { const t = await page.evaluate(() => (document.querySelector('#addr-title') || {}).textContent || ''); if (t && t !== prevTitle) break; await page.waitForTimeout(500); }
    const done = async () => page.evaluate(() => ['#verdict', '#nearby', '#nuisances', '#property', '#roof', '#daycare'].every(s => { const e = document.querySelector(s); return e && !e.querySelector('.loading'); }));
    for (let i = 0; i < 220 && !(await done()); i++) await page.waitForTimeout(1000);
    const secs = Math.round((Date.now() - t0) / 1000);
    const txt = await page.evaluate(() => {
      const g = s => (document.querySelector(s) || {}).innerText || '';
      return { title: g('#addr-title'), verdict: g('#verdict'), facing: g('#facing-info'), property: g('#property'), roof: g('#roof'), daycare: g('#daycare'), nuis: g('#nuisances'), nearby: g('#nearby').slice(0, 1500) };
    });
    console.log(`\n==================== ${n}. ${a}  (${secs}s)\n` + Object.entries(txt).map(([k, v]) => `--- ${k}\n${v}`).join('\n'));
    console.log('--- errors\n' + [...new Set(errors)].slice(0, 30).join('\n'));
    // map screenshot (zoomed on the house) and roof strip
    const card = await page.$('#map'); if (card) { await card.scrollIntoViewIfNeeded(); await page.waitForTimeout(2500); await card.screenshot({ path: `tools/out/${n}-map.png` }); await page.evaluate(() => { const m = document.querySelector('.leaflet-control-zoom-out'); m.click(); m.click(); }); await page.waitForTimeout(3000); await card.screenshot({ path: `tools/out/${n}-map-wide.png` }); }
    const rs = await page.$('.roof-strip'); if (rs) { await rs.scrollIntoViewIfNeeded(); await rs.screenshot({ path: `tools/out/${n}-roof.png` }); }
    const top = await page.$('#card-header'); if (top) { await top.scrollIntoViewIfNeeded(); }
    await page.screenshot({ path: `tools/out/${n}-page.png`, fullPage: true });
  }
  await browser.close();
})().catch(e => { console.log('FATAL', e); process.exit(1); });

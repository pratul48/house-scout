const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({ acceptDownloads: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  for (const url of ['https://auditor.warrencountyohio.gov/PropertySearch/PublicDataExport/Index', 'https://auditor.warrencountyohio.gov/PropertySearch/Summary/Index?account_nbr=1129342']) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      for (let i = 0; i < 20; i++) { const t = await page.title(); if (!/just a moment/i.test(t)) break; await page.waitForTimeout(1500); }
      console.log('\n=== ' + url + '\nTITLE: ' + await page.title());
      const txt = await page.evaluate(() => document.body.innerText);
      console.log(txt.slice(0, 6000));
      const links = await page.evaluate(() => [...document.querySelectorAll('a')].map(a => a.textContent.trim().slice(0, 60) + ' -> ' + a.href).filter(s => /export|download|csv|xls|zip|txt|sale|value|appraisal|transfer/i.test(s)));
      console.log('LINKS:\n' + links.join('\n'));
      await page.screenshot({ path: `tools/out/wa-${url.length}.png`, fullPage: false });
    } catch (e) { console.log('ERR ' + url + ' ' + e.message); }
  }
  await browser.close();
})();

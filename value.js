/* Owner, sale history and price check.
 *
 *  Owner (all public record):
 *   - Warren County (Mason): county GIS tax parcels – owner, mailing address, subdivision, deed book/page
 *   - Hamilton County: CAGIS parcels – owner, previous owner, last sale date + price, auditor market value, taxes
 *   - Butler & other Ohio counties: statewide parcel layer (PUCO) – owner name
 *  Sale price / auditor value for Warren & Butler are not published in a form apps can read, so the app links
 *  to the auditor page and lets you type the two numbers in. Everything else is automatic.
 *
 *  Price check:
 *   1. Last sale price brought up to today with the Zillow Home Value Index for the ZIP (data/zhvi, updated monthly)
 *   2. Hamilton only: auditor market value × how much nearby homes actually sold for vs their auditor value
 *   Asking price is compared with these.
 */
(function (root) {
  'use strict';
  const enc = encodeURIComponent;
  const WARREN = 'https://maps.warrencountyohio.gov/server/rest/services/AuditorsMap/TaxParcels/FeatureServer/0';
  const HAMILTON = 'https://cagisonline.hamilton-co.org/arcgis/rest/services/COUNTYWIDE/Cadastral/MapServer/0';
  const PUCO = 'https://maps.puco.ohio.gov/arcgis/rest/services/ohio_parcels/MapServer';
  const get = (u, t) => root.Ohio.getJSON(u, t);
  const at = (p, m) => `geometry=${p.lon},${p.lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects${m ? `&distance=${m}&units=esriSRUnit_Meter` : ''}&returnGeometry=false&f=json`;
  const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  const T = s => root.Ohio.title(s);
  const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  // Warren stores names "LAST, FIRST" or ",LLC; NAME". Make them readable.
  function warrenName(n) {
    n = clean(n); if (!n) return '';
    if (/^,\s*(LLC|INC|TRUST|LTD)/i.test(n)) { const [suffix, rest] = n.slice(1).split(';'); return T(`${clean(rest)} ${clean(suffix)}`); }
    return T(n.split(';').map(s => s.trim()).filter(Boolean).join(' & '));
  }
  const isCompany = n => /\b(LLC|INC|CORP|COMPANY|CO\.?|LP|LTD|PROPERTIES|HOLDINGS|INVEST|REALTY|HOMES|PARTNERS|BANK|ASSOC)\b/i.test(n);
  const isTrust = n => /\bTRUST|TRUSTEE|TR\b/i.test(n);
  const sameAddr = (a, b) => { const k = s => clean(s).toUpperCase().replace(/\b(COURT|CT|DRIVE|DR|ROAD|RD|LANE|LN|STREET|ST|AVENUE|AVE|CIRCLE|CIR|WAY|PLACE|PL|BOULEVARD|BLVD|TRAIL|TRL|TERRACE|TER|TE)\b/g, '').replace(/[^A-Z0-9]/g, ''); return !!a && !!b && k(a) === k(b); };

  function ownerType(name, livesThere) {
    if (isCompany(name)) return { kind: 'company', text: 'Owned by a company (often an investor or landlord, so the home may be a rental).' };
    if (isTrust(name)) return { kind: 'trust', text: 'Owned through a trust (common for estate planning).' };
    if (livesThere === true) return { kind: 'occupant', text: 'The owner\'s tax bills go to this house, so the owner most likely lives here.' };
    if (livesThere === false) return { kind: 'absentee', text: 'Tax bills go to a different address, so the owner probably doesn\'t live here (rental, second home, or they already moved).' };
    return { kind: 'unknown', text: '' };
  }

  async function warren(p) {
    const j = await get(`${WARREN}/query?${at(p)}&outFields=MACCT,SDWLL_NBR,OWNER_NAME,ADDRESS_LINE_1,ADDRESS_LINE_2,USE_CODE_DSC,SCH_DST_DSC,ACREAGE,SUBDV,LOT_NUMBER,BOOK,PAGE,MAIL_NAME,MAIL_ADDRESS_1,MAIL_ADDRESS_3,MAIL_ZIP,MUNICIPALITY_NAME,TOWNSHIP_NAME,NEIGHBORHOOD_ID`);
    const a = j.features && j.features[0] && j.features[0].attributes; if (!a) return null;
    const owner = warrenName(a.OWNER_NAME), lives = sameAddr(a.ADDRESS_LINE_1, a.MAIL_ADDRESS_1);
    return {
      county: 'Warren', owner, mailing: T([a.MAIL_ADDRESS_1, a.MAIL_ADDRESS_3, a.MAIL_ZIP].filter(Boolean).join(', ')), livesThere: lives, type: ownerType(owner, lives),
      site: T(`${a.ADDRESS_LINE_1}, ${a.ADDRESS_LINE_2}`), use: T(a.USE_CODE_DSC), acres: a.ACREAGE, subdivision: T(a.SUBDV), lot: a.LOT_NUMBER,
      deed: a.BOOK ? `Book ${a.BOOK}, page ${a.PAGE}` : null, place: T(clean(a.MUNICIPALITY_NAME) || clean(a.TOWNSHIP_NAME) + ' Township'),
      auditorUrl: a.MACCT ? `https://auditor.warrencountyohio.gov/PropertySearch/Summary/Index?account_nbr=${a.MACCT}` : null,
      recorderUrl: 'https://recorder.warrencountyohio.gov/Info/SearchInfo/Index', needsManual: true
    };
  }

  async function hamilton(p) {
    const f = 'PARCELID,OWNNM1,OWNNM2,OWNAD1,OWNAD2,PREVOWN1,SALDAT,SALAMT,MKTLND,MKTIMP,MKT_TOTAL_VAL,ANNUAL_TAXES,ADDRNO,ADDRST,ADDRSF,ACREDEED,HMSD_FLAG,FORECL_FLAG,DELQ_TAXES,RENT_REG_FLAG,CLASS,NUMPCL';
    const j = await get(`${HAMILTON}/query?${at(p)}&outFields=${f}`);
    const a = j.features && j.features[0] && j.features[0].attributes; if (!a) return null;
    const owner = T([a.OWNNM1, a.OWNNM2].filter(x => clean(x)).join(' & ')), site = `${a.ADDRNO} ${a.ADDRST} ${a.ADDRSF}`;
    const lives = sameAddr(site, a.OWNAD1);
    return {
      county: 'Hamilton', owner, prevOwner: T(a.PREVOWN1), mailing: T([a.OWNAD1, a.OWNAD2].filter(Boolean).join(', ')), livesThere: lives, type: ownerType(owner, lives),
      sale: a.SALAMT > 0 && a.SALDAT ? { price: a.SALAMT, date: new Date(a.SALDAT), multi: a.NUMPCL > 1 } : null,
      auditor: a.MKT_TOTAL_VAL ? { total: a.MKT_TOTAL_VAL, land: a.MKTLND, building: a.MKTIMP } : null,
      taxes: a.ANNUAL_TAXES || null, acres: a.ACREDEED, rental: a.RENT_REG_FLAG === 'Y', foreclosure: a.FORECL_FLAG === 'Y', delinquent: a.DELQ_TAXES > 0 ? a.DELQ_TAXES : 0,
      cls: a.CLASS, auditorUrl: `https://wedge1.hcauditor.org/view/re/${a.PARCELID}`, needsManual: false
    };
  }

  /** Hamilton: recent nearby single-family sales and how they compare with the auditor's value. */
  async function hamiltonComps(p, cls) {
    const since = new Date(Date.now() - 2 * 365.25 * 864e5).toISOString().slice(0, 10);
    const where = `CLASS=${cls || 510} AND SALAMT>50000 AND NUMPCL=1 AND MKT_TOTAL_VAL>0 AND SALDAT >= DATE '${since}'`;
    const j = await get(`${HAMILTON}/query?${at(p, 1200)}&where=${enc(where)}&outFields=ADDRNO,ADDRST,ADDRSF,SALDAT,SALAMT,MKT_TOTAL_VAL&resultRecordCount=300`, 25000);
    const list = (j.features || []).map(f => f.attributes).map(a => ({ addr: T(`${a.ADDRNO} ${a.ADDRST} ${a.ADDRSF}`), date: new Date(a.SALDAT), price: a.SALAMT, value: a.MKT_TOTAL_VAL, ratio: a.SALAMT / a.MKT_TOTAL_VAL }))
      .filter(x => x.ratio > 0.5 && x.ratio < 3);
    if (list.length < 5) return { list, ratio: null };
    return { list: list.sort((a, b) => b.date - a.date), ratio: median(list.map(x => x.ratio)) };
  }

  async function puco(p) {
    // statewide layer split into regions; try all quickly
    for (const id of [2, 3, 1, 4, 5]) {
      try {
        const j = await get(`${PUCO}/${id}/query?${at(p)}&outFields=OWNER1,OWNER2,COUNTY,PIN`, 12000);
        const a = j.features && j.features[0] && j.features[0].attributes;
        if (a) { const owner = T([a.OWNER1, a.OWNER2].filter(x => clean(x)).join(' & ')); return { county: T(a.COUNTY), owner, type: ownerType(owner, null), needsManual: true }; }
      } catch { }
    }
    return null;
  }

  async function owner(p, county) {
    const c = (county || '').toLowerCase();
    try {
      if (c.includes('warren')) { const w = await warren(p); if (w) return w; }
      if (c.includes('hamilton')) { const h = await hamilton(p); if (h) return h; }
    } catch { /* fall through */ }
    return puco(p);
  }

  // ---------- home value index ----------
  const zcache = {};
  async function zhvi(zip) {
    if (!zip) return null;
    if (zcache[zip] !== undefined) return zcache[zip];
    try { const r = await fetch(`data/zhvi/${zip}.json`); zcache[zip] = r.ok ? await r.json() : null; } catch { zcache[zip] = null; }
    return zcache[zip];
  }
  function indexAt(z, date) {
    const [y, m] = z.start.split('-').map(Number);
    const i = (date.getFullYear() - y) * 12 + date.getMonth() - (m - 1);
    if (i < 0) return { value: null, before: true };
    return { value: z.v[Math.min(i, z.v.length - 1)], after: i >= z.v.length };
  }
  const latest = z => z.v[z.v.length - 1];
  const lastMonth = z => { const [y, m] = z.start.split('-').map(Number), t = y * 12 + m - 1 + z.v.length - 1; return new Date(Math.floor(t / 12), t % 12, 15); };

  /** Pure: combine the estimates and compare with the asking price. */
  function priceCheck({ asking, sale, auditor, ratio, z }) {
    const est = [];
    if (sale && sale.price >= 20000 && z && !sale.multi) {
      const then = indexAt(z, sale.date);
      if (then.value) {
        const growth = latest(z) / then.value;
        const years = (lastMonth(z) - sale.date) / 3.15576e10;
        est.push({ key: 'indexed', value: sale.price * growth, low: sale.price * growth * (years > 8 ? 0.85 : 0.9), high: sale.price * growth * (years > 8 ? 1.15 : 1.1),
          text: `Sold for $${Math.round(sale.price).toLocaleString()} in ${sale.date.getFullYear()}. Homes in this ZIP are up ${Math.round((growth - 1) * 100)}% since then (Zillow Home Value Index), which puts it at about $${Math.round(sale.price * growth / 1000)}k today, before any remodeling.` });
      }
    }
    if (auditor && auditor.total && ratio) {
      est.push({ key: 'auditor', value: auditor.total * ratio, low: auditor.total * ratio * 0.9, high: auditor.total * ratio * 1.1,
        text: `The county values it at $${Math.round(auditor.total).toLocaleString()}. Homes nearby sold for ${ratio.toFixed(2)}× their county value over the last 2 years, which gives about $${Math.round(auditor.total * ratio / 1000)}k.` });
    }
    if (!est.length) return { est, verdict: null };
    const value = est.reduce((s, e) => s + e.value, 0) / est.length;
    const low = Math.min(...est.map(e => e.low)), high = Math.max(...est.map(e => e.high));
    if (!asking) return { est, value, low, high, verdict: null };
    const diff = (asking - value) / value;
    let verdict, cls;
    if (asking > high * 1.05) { verdict = `Priced high: ${Math.round(diff * 100)}% above the estimate`; cls = 'bad'; }
    else if (asking > high) { verdict = `A little high: ${Math.round(diff * 100)}% above the estimate`; cls = 'mid'; }
    else if (asking < low) { verdict = `Priced below the estimate (${Math.round(-diff * 100)}% under). Find out why: condition, location, or a quick sale`; cls = 'good'; }
    else { verdict = `Priced about right (${diff >= 0 ? '+' : ''}${Math.round(diff * 100)}% vs the estimate)`; cls = 'good'; }
    return { est, value, low, high, diff, verdict, cls };
  }

  const api = { owner, hamiltonComps, zhvi, indexAt, priceCheck, warrenName, ownerType, sameAddr };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Value = api;
})(typeof window !== 'undefined' ? window : globalThis);

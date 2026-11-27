/* Home daycare check (Ohio Type B family child care home).
 * Uses: Ohio licensed child care programs, Census ACS (via Esri Living Atlas, no key needed), NCES schools,
 * the house's street (LBRS), lot size (statewide parcels) and drive times (OSRM).
 */
(function (root) {
  'use strict';
  const LA = 'https://P3ePLMYs2RVChkJx.svcs.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services';
  const PLFP = `${LA}/ACS_Children_by_Parental_Labor_Force_Participation_View_Boundaries/FeatureServer`;
  const KIDS = `${LA}/ACS_Context_for_Child_Well_Being_View_Boundaries/FeatureServer`;
  const INCOME = `${LA}/ACS_Median_Household_Income_View_Boundaries/FeatureServer/2`;
  const MI = 1609.344, R3 = 3 * MI;
  const enc = encodeURIComponent;
  const get = (u, t) => root.Ohio.getJSON(u, t);
  const near = (p, m) => `geometry=${p.lon},${p.lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects${m ? `&distance=${m}&units=esriSRUnit_Meter` : ''}`;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // Fraction of a tract polygon that lies within `radius` of p (grid sampling).
  function shareWithin(rings, p, radius) {
    const P = Geo.projector(p);
    const polys = rings.map(r => r.map(([x, y]) => P.fwd({ lat: y, lon: x })));
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const poly of polys) for (const q of poly) { minx = Math.min(minx, q.x); maxx = Math.max(maxx, q.x); miny = Math.min(miny, q.y); maxy = Math.max(maxy, q.y); }
    const step = Math.max(40, Math.sqrt((maxx - minx) * (maxy - miny) / 2500));
    let inTract = 0, inBoth = 0;
    for (let x = minx + step / 2; x < maxx; x += step) for (let y = miny + step / 2; y < maxy; y += step) {
      let inside = false; for (const poly of polys) if (Geo.pointInPolygon({ x, y }, poly)) inside = !inside; // even-odd handles holes
      if (!inside) continue;
      inTract++; if (Math.hypot(x, y) <= radius) inBoth++;
    }
    return inTract ? inBoth / inTract : 0;
  }

  const UNDER6_WORKING = a => (a.B23008_004E || 0) + (a.B23008_010E || 0) + (a.B23008_013E || 0);
  const SCHOOLAGE_WORKING = a => (a.B23008_017E || 0) + (a.B23008_023E || 0) + (a.B23008_026E || 0);

  async function demographics(p) {
    const fields = 'GEOID,B23008_002E,B23008_004E,B23008_010E,B23008_013E,B23008_015E,B23008_017E,B23008_023E,B23008_026E';
    const j = await get(`${PLFP}/2/query?${near(p, R3)}&outFields=${fields}&outSR=4326&returnGeometry=true&geometryPrecision=5&maxAllowableOffset=0.0003&f=json`, 25000);
    const tracts = (j.features || []).map(f => ({ a: f.attributes, share: f.geometry ? shareWithin(f.geometry.rings, p, R3) : 0 }));
    if (!tracts.length) throw new Error('no census data');
    const ids = tracts.map(t => `'${t.a.GEOID}'`).join(',');
    const k = await get(`${KIDS}/2/query?where=${enc(`GEOID IN (${ids})`)}&outFields=GEOID,B01001_001E,B01001_003E,B01001_004E,B01001_005E,B01001_027E,B01001_028E,B01001_029E&returnGeometry=false&f=json`, 20000).catch(() => ({ features: [] }));
    const kid = {}; for (const f of k.features || []) kid[f.attributes.GEOID] = f.attributes;
    const sum = { under6: 0, under6Working: 0, school: 0, schoolWorking: 0, pop: 0, age0to4: 0, age5to9: 0, age10to14: 0 };
    for (const t of tracts) {
      const s = t.share, a = t.a, b = kid[a.GEOID] || {};
      sum.under6 += (a.B23008_002E || 0) * s; sum.under6Working += UNDER6_WORKING(a) * s;
      sum.school += (a.B23008_015E || 0) * s; sum.schoolWorking += SCHOOLAGE_WORKING(a) * s;
      sum.pop += (b.B01001_001E || 0) * s;
      sum.age0to4 += ((b.B01001_003E || 0) + (b.B01001_027E || 0)) * s;
      sum.age5to9 += ((b.B01001_004E || 0) + (b.B01001_028E || 0)) * s;
      sum.age10to14 += ((b.B01001_005E || 0) + (b.B01001_029E || 0)) * s;
    }
    Object.keys(sum).forEach(key => sum[key] = Math.round(sum[key]));
    let income = null;
    try { const r = await get(`${INCOME}/query?${near(p)}&outFields=B19049_001E&returnGeometry=false&f=json`); income = r.features && r.features[0] ? r.features[0].attributes.B19049_001E : null; } catch { }
    return { ...sum, income, tracts: tracts.length };
  }

  async function stateBaseline() {
    try { const c = JSON.parse(localStorage.getItem('hs_dcbase') || 'null'); if (c && Date.now() - c.t < 14 * 864e5) return c.v; } catch { }
    const [st, counts] = await Promise.all([
      get(`${PLFP}/0/query?where=${enc("NAME='Ohio'")}&outFields=B23008_004E,B23008_010E,B23008_013E&returnGeometry=false&f=json`),
      root.Ohio.childCareStateCounts()
    ]);
    const a = st.features && st.features[0] && st.features[0].attributes;
    if (!a) throw new Error('no state data');
    const programs = (counts['Child Care Center'] || 0) + (counts['FCC - Type A Home'] || 0) + (counts['FCC - Type B Home'] || 0) + (counts['Pre School'] || 0);
    const v = { under6Working: UNDER6_WORKING(a), programs, kidsPerProgram: UNDER6_WORKING(a) / programs, counts };
    try { localStorage.setItem('hs_dcbase', JSON.stringify({ t: Date.now(), v })); } catch { }
    return v;
  }

  const isHome = t => /Type A|Type B/.test(t);
  const isEarlyCare = t => /Child Care Center|Type A|Type B|Pre School/.test(t);

  /** Score parts, each 0–20. Pure function so it can be tested. */
  function score(input) {
    const { demo, base, providers, street, highwayMin, elemMin, floodHigh } = input;
    const parts = [];
    const within = m => providers.filter(x => x.dist <= m);
    const early3 = within(R3).filter(x => isEarlyCare(x.type));
    // 1. Demand vs supply compared with Ohio as a whole
    if (demo && base) {
      const local = demo.under6Working / Math.max(1, early3.length);
      const ratio = local / base.kidsPerProgram;
      parts.push({ key: 'demand', label: 'Demand vs. existing daycares', score: Math.round(clamp(10 + 8 * Math.log2(ratio), 0, 20)),
        text: `${demo.under6Working.toLocaleString()} kids under 6 with all parents working, and ${early3.length} licensed daycares/preschools within 3 miles: about ${Math.round(local)} kids per daycare, vs ${Math.round(base.kidsPerProgram)} across Ohio (${ratio >= 1 ? (ratio).toFixed(1) + '× the state' : Math.round(ratio * 100) + '% of the state'}).` });
    }
    // 2. Other home daycares very close by
    const homes1 = within(MI).filter(x => isHome(x.type)).length, centers1 = within(MI).filter(x => /Center|Pre School/.test(x.type)).length;
    parts.push({ key: 'competition', label: 'Competition within 1 mile', score: clamp(20 - 5 * homes1 - 2 * centers1, 0, 20),
      text: `${homes1} other home daycare${homes1 === 1 ? '' : 's'} and ${centers1} center${centers1 === 1 ? '' : 's'}/preschool${centers1 === 1 ? '' : 's'} within 1 mile.` });
    // 3. Number of young families nearby
    if (demo) parts.push({ key: 'families', label: 'Young families nearby', score: Math.round(clamp(demo.under6Working / 1500 * 20, 0, 20)),
      text: `${demo.age0to4.toLocaleString()} children age 0–4, ${demo.age5to9.toLocaleString()} age 5–9 and ${demo.age10to14.toLocaleString()} age 10–14 live within 3 miles.` });
    // 4. Access and safety for drop-off
    let acc = 20; const notes = [];
    if (street) {
      if ((street.lanes && street.lanes >= 4) || (street.speed && street.speed >= 45)) { acc -= 10; notes.push(`front street is busy (${street.speed ? street.speed + ' mph' : street.lanes + ' lanes'})`); }
      else if (street.speed && street.speed >= 35) { acc -= 5; notes.push(`front street speed limit ${street.speed} mph`); }
      else if (/^(CT|CIR|PL|LOOP|CV)$/i.test(street.type || '')) notes.push('quiet court/circle street, easy and safe drop-off');
      else notes.push('residential street');
    }
    if (highwayMin != null) { if (highwayMin > 12) { acc -= 4; } notes.push(`${Math.round(highwayMin)} min drive to the nearest highway ramp`); }
    if (elemMin != null) { if (elemMin > 10) acc -= 3; notes.push(`${Math.round(elemMin)} min to the nearest elementary school`); }
    if (floodHigh) { acc -= 5; notes.push('high-risk flood zone'); }
    parts.push({ key: 'access', label: 'Easy, safe drop-off', score: clamp(acc, 0, 20), text: notes.length ? notes.join('; ') + '.' : 'Street details not available.' });
    // 5. What families can afford
    if (demo && demo.income) parts.push({ key: 'income', label: 'Families can afford care', score: Math.round(clamp((demo.income - 50000) / 70000 * 15 + 5, 0, 20)),
      text: `Median household income in this census tract is $${demo.income.toLocaleString()}.` });
    const max = parts.length * 20, total = parts.reduce((s, x) => s + x.score, 0);
    const pct = Math.round(total / max * 100);
    const grade = pct >= 75 ? 'Strong' : pct >= 60 ? 'Good' : pct >= 45 ? 'Fair' : 'Weak';
    return { parts, pct, grade };
  }

  async function analyze(p, ctx) {
    const [demoR, baseR, provR, schoolsR] = await Promise.allSettled([
      demographics(p), stateBaseline(), root.Ohio.childCare(p, 5 * MI), root.Ohio.schools(p, 8000)
    ]);
    const demo = demoR.status === 'fulfilled' ? demoR.value : null;
    const base = baseR.status === 'fulfilled' ? baseR.value : null;
    const providers = provR.status === 'fulfilled' ? provR.value : [];
    const schools = schoolsR.status === 'fulfilled' ? schoolsR.value : [];
    const elem = schools.filter(s => /Elementary|Primary/i.test(s.level || '') || /^(PK|KG|01)$/.test(s.lo || '')).slice(0, 3);
    // drive times: nearest elementary + nearest highway ramp
    let elemMin = null, highwayMin = null, ramp = null;
    try {
      ramp = await ctx.nearestRamp(p);
    } catch { }
    const targets = [...elem, ...(ramp ? [ramp] : [])];
    if (targets.length) {
      try {
        const d = await ctx.driveTimes(p, targets);
        elem.forEach((s, i) => { s.driveMin = d[i] != null ? d[i] / 60 : null; });
        if (ramp) highwayMin = d[elem.length] != null ? d[elem.length] / 60 : null;
        const e = elem.filter(s => s.driveMin != null).sort((a, b) => a.driveMin - b.driveMin)[0];
        elemMin = e ? e.driveMin : null;
      } catch { }
    }
    const result = score({ demo, base, providers, street: ctx.street, highwayMin, elemMin, floodHigh: ctx.floodHigh });
    return { ...result, demo, base, providers, elem, ramp, highwayMin, errors: { demo: demoR.reason && demoR.reason.message, providers: provR.reason && provR.reason.message } };
  }

  const api = { analyze, score, shareWithin, isHome };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Daycare = api;
})(typeof window !== 'undefined' ? window : globalThis);

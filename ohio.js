/* Ohio-specific data sources. All are public ArcGIS REST services that allow browser (CORS) requests.
 *  - LBRS locator + address points (Ohio Location Based Response System): exact, field-verified house points
 *  - Ohio statewide parcels (OGRIP): the lot outline + link to the county auditor record
 *  - LBRS street centerlines: official street names, speed, lanes
 *  - FEMA / ORNL USA Structures: building outlines (falls back to OpenStreetMap elsewhere)
 *  - Ohio child care programs, school districts, schools (maps.ohio.gov)
 */
(function (root) {
  'use strict';
  const OH = 'https://maps.ohio.gov/arcgis/rest/services';
  const LOCATOR = `${OH}/LBRSLocator2023/GeocodeServer`;
  const ADDR_PTS = `${OH}/Hosted/Ohio_Statewide_LBRS_Address_Points/FeatureServer/0`;
  const CENTERLINES = `${OH}/Hosted/Ohio_Statewide_LBRS_Centerlines/FeatureServer/0`;
  const PARCELS = 'https://services2.arcgis.com/MlJ0G8iWUyC7jAmu/arcgis/rest/services/OhioStatewidePacels_full_view/FeatureServer/0';
  const STRUCTURES = 'https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0';
  const DAYCARES = `${OH}/Hosted/Ohio_Daycares_view/FeatureServer/0`;
  const DISTRICTS = `${OH}/Hosted/Ohio_School_Districts_2025/FeatureServer/0`;
  const SCHOOLS = `${OH}/Hosted/schools2526_Geocoded/FeatureServer/0`;
  const NCES = 'https://nces.ed.gov/opengis/rest/services/K12_School_Locations/EDGE_ADMINDATA_PUBLICSCH_2425/MapServer/1';

  const enc = encodeURIComponent;
  async function getJSON(url, timeout = 20000) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j && j.error) throw new Error(j.error.message || 'service error');
      return j;
    } catch (e) { if (e.name === 'AbortError') throw new Error('timed out'); throw e; }
    finally { clearTimeout(t); }
  }
  const near = (p, meters) => `geometry=${p.lon},${p.lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects${meters ? `&distance=${meters}&units=esriSRUnit_Meter` : ''}`;
  const ring2ll = ring => ring.map(([x, y]) => ({ lat: y, lon: x }));
  const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  const title = s => clean(s).toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/\b(Oh|Us|Sr|Nw|Ne|Sw|Se|Ii|Iii|Iv|Llc|Lp|Csd)\b/g, w => w.toUpperCase());

  // Rough Ohio bounding box (plus a little margin).
  const inOhio = p => p.lat > 38.35 && p.lat < 42.05 && p.lon > -84.9 && p.lon < -80.45;

  /** Geocode with the state LBRS locator. Returns [] if nothing good. */
  async function geocode(q, magicKey) {
    const j = await getJSON(`${LOCATOR}/findAddressCandidates?SingleLine=${enc(q)}${magicKey ? `&magicKey=${enc(magicKey)}` : ''}&outFields=Addr_type,Match_addr,AddNum,StPreDir,StName,StType,StDir,City,Subregion,Postal&outSR=4326&maxLocations=6&f=json`, 15000);
    return (j.candidates || [])
      .filter(c => c.score >= 85 && /PointAddress|Subaddress|StreetAddress/.test(c.attributes.Addr_type))
      .map(c => {
        const a = c.attributes;
        const street = clean([a.StPreDir, a.StName, a.StType, a.StDir].filter(Boolean).join(' '));
        return {
          lat: c.location.y, lon: c.location.x, num: clean(a.AddNum), street: title(street), streetRaw: street,
          city: title(a.City), county: a.Subregion ? `${title(a.Subregion)} County` : '', st: 'Ohio', zip: a.Postal || '', country: 'us',
          label: `${clean(a.AddNum)} ${title(street)}, ${title(a.City)}, OH ${a.Postal || ''}`.trim(),
          exact: a.Addr_type === 'PointAddress' || a.Addr_type === 'Subaddress', score: c.score, source: 'Ohio LBRS'
        };
      });
  }

  /** The LBRS address point(s) for this house number + street, near p. Gives subdivision name and a field-verified point. */
  async function addressPoint(p) {
    if (!p.num) return null;
    const j = await getJSON(`${ADDR_PTS}/query?${near(p, 120)}&where=${enc(`addr_num=${parseInt(p.num, 10) || -1}`)}&outFields=addr_num,str_pre,str_name,str_type,sub_name,city,zip,struc_type,county&outSR=4326&returnGeometry=true&f=json`);
    const core = Geo.streetCore(p.street);
    const f = (j.features || []).find(f => Geo.streetCore([f.attributes.str_pre, f.attributes.str_name, f.attributes.str_type].join(' ')) === core) || (j.features || [])[0];
    if (!f) return null;
    return { lat: f.geometry.y, lon: f.geometry.x, subdivision: title(f.attributes.sub_name), strucType: f.attributes.struc_type };
  }

  /** The lot the point sits on. */
  // Ohio address points are often placed at the end of the driveway, sometimes in the road right-of-way,
  // so "the lot under the point" can miss. Look within 40 m and prefer: matching house number, then the closest lot.
  async function parcel(p, houseNum) {
    const j = await getJSON(`${PARCELS}/query?${near(p, 40)}&outFields=County,LocalParcelID,StateLUC,SitusAddressAll,CAMADataSite,CurrentTo&outSR=4326&returnGeometry=true&resultRecordCount=30&f=json`);
    const P = Geo.projector(p);
    const cands = (j.features || []).filter(f => f.geometry && f.geometry.rings).map(f => {
      const ring = f.geometry.rings.slice().sort((a, b) => b.length - a.length)[0];
      const poly = ring.map(([x, y]) => P.fwd({ lat: y, lon: x }));
      const inside = Geo.pointInPolygon({ x: 0, y: 0 }, poly);
      let d = 0;
      if (!inside) { d = Infinity; for (let i = 1; i < poly.length; i++) { const a = poly[i - 1], b = poly[i], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy; const t = L2 ? Math.max(0, Math.min(1, (-a.x * dx - a.y * dy) / L2)) : 0; d = Math.min(d, Math.hypot(a.x + t * dx, a.y + t * dy)); } }
      const num = (String(f.attributes.SitusAddressAll || '').match(/^\s*(\d+)/) || [])[1];
      return { f, d, numMatch: !!houseNum && num === String(parseInt(houseNum, 10)), numOther: !!num && !!houseNum && num !== String(parseInt(houseNum, 10)) };
    }).filter(c => !c.numOther || c.d === 0);
    cands.sort((a, b) => (b.numMatch - a.numMatch) || (a.d - b.d));
    const f = cands[0] && (cands[0].numMatch || cands[0].d < 25) ? cands[0].f : null;
    if (!f) return null;
    const ring = f.geometry.rings.slice().sort((a, b) => b.length - a.length)[0];
    const geometry = ring2ll(ring);
    const a = f.attributes;
    return {
      geometry, id: a.LocalParcelID, county: a.County, use: clean(a.StateLUC), situs: clean(a.SitusAddressAll),
      auditorUrl: /^https:\/\/[^/]*(auditor|\.oh\.us|ohio\.gov)/i.test(a.CAMADataSite || '') ? a.CAMADataSite : null,
      areaM2: Geo.areaM2(geometry), asOf: a.CurrentTo ? new Date(a.CurrentTo) : null
    };
  }

  /** Building outlines near p, from FEMA USA Structures. Returned in the same shape as OSM ways. */
  async function buildings(p, meters = 70) {
    const j = await getJSON(`${STRUCTURES}/query?${near(p, meters)}&outFields=BUILD_ID,OCC_CLS,PRIM_OCC,OUTBLDG,SQFEET,HEIGHT,IMAGE_DATE,PROP_ADDR&outSR=4326&returnGeometry=true&resultRecordCount=200&f=json`);
    return (j.features || []).filter(f => f.geometry && f.geometry.rings).map(f => ({
      id: 'usa-' + f.attributes.BUILD_ID, source: 'FEMA USA Structures',
      tags: { building: 'yes', OUTBLDG: f.attributes.OUTBLDG, occ: f.attributes.PRIM_OCC || f.attributes.OCC_CLS, sqft: f.attributes.SQFEET, height: f.attributes.HEIGHT, imageDate: f.attributes.IMAGE_DATE },
      geometry: ring2ll(f.geometry.rings.slice().sort((a, b) => b.length - a.length)[0])
    }));
  }

  /** Official street centerlines near p, as road objects for Geo.estimateFacing. */
  async function streets(p, meters = 260) {
    const j = await getJSON(`${CENTERLINES}/query?${near(p, meters)}&outFields=str_pre,str_name,str_type,str_suffix,speed,lanes&outSR=4326&returnGeometry=true&resultRecordCount=300&f=json`);
    const roads = [];
    for (const f of j.features || []) {
      const a = f.attributes, name = title([a.str_pre, a.str_name, a.str_type, a.str_suffix].filter(x => clean(x)).join(' '));
      for (const path of (f.geometry && f.geometry.paths) || []) roads.push({ id: 'lbrs', tags: { name, speed: a.speed || null, lanes: a.lanes || null, type: clean(a.str_type) }, geometry: ring2ll(path) });
    }
    return roads;
  }

  /** Licensed child care programs within `meters`. */
  async function childCare(p, meters) {
    const j = await getJSON(`${DAYCARES}/query?${near(p, meters)}&where=${enc("program_status='Open'")}&outFields=program_name,program_type,street_address,city,sutq_rating,link,phone_number,geocode__latitude_,geocode__longitude_,y,x&returnGeometry=false&resultRecordCount=2000&f=json`, 25000);
    return (j.features || []).map(f => {
      const a = f.attributes, lat = a.y || a.geocode__latitude_, lon = a.x || a.geocode__longitude_;
      return { name: title(a.program_name), type: a.program_type, address: title(`${a.street_address}, ${a.city}`), stars: a.sutq_rating, link: a.link, phone: a.phone_number, lat, lon, dist: lat ? Geo.haversine(p, { lat, lon }) : null };
    }).filter(x => x.dist != null).sort((a, b) => a.dist - b.dist);
  }

  /** Ohio-wide count of open programs by type (for comparing local demand to the state average). */
  async function childCareStateCounts() {
    const stats = enc(JSON.stringify([{ statisticType: 'count', onStatisticField: 'objectid', outStatisticFieldName: 'n' }]));
    const j = await getJSON(`${DAYCARES}/query?where=${enc("program_status='Open'")}&outStatistics=${stats}&groupByFieldsForStatistics=program_type&f=json`);
    const out = {}; for (const f of j.features || []) out[f.attributes.program_type] = f.attributes.n; return out;
  }

  async function schoolDistrict(p) {
    const j = await getJSON(`${DISTRICTS}/query?${near(p)}&outFields=irn,name&returnGeometry=false&f=json`);
    const a = j.features && j.features[0] && j.features[0].attributes;
    return a ? { irn: a.irn, name: title(a.name) } : null;
  }

  /** Public schools within `meters` with grade spans (NCES 2024-25). */
  async function schools(p, meters) {
    try {
      const j = await getJSON(`${NCES}/query?${near(p, meters)}&outFields=SCH_NAME,GSLO,GSHI,SCHOOL_LEVEL,TOTAL,LATCOD,LONCOD,LEA_NAME,SY_STATUS_TEXT&returnGeometry=false&resultRecordCount=200&f=json`);
      const list = (j.features || []).map(f => f.attributes).filter(a => a.LATCOD).map(a => ({
        name: title(a.SCH_NAME), lo: a.GSLO, hi: a.GSHI, level: a.SCHOOL_LEVEL, students: a.TOTAL > 0 ? a.TOTAL : null, district: title(a.LEA_NAME),
        lat: a.LATCOD, lon: a.LONCOD, dist: Geo.haversine(p, { lat: a.LATCOD, lon: a.LONCOD })
      }));
      if (list.length) return list.sort((a, b) => a.dist - b.dist);
    } catch { /* fall back to the state list below */ }
    const j = await getJSON(`${SCHOOLS}/query?${near(p, meters)}&outFields=user_school_name,user_org_type,school_district_name,user_org_geo_lat_num,user_org_geo_long_num&returnGeometry=false&f=json`);
    return (j.features || []).map(f => f.attributes).map(a => ({ name: a.user_school_name, level: a.user_org_type, district: a.school_district_name, lat: +a.user_org_geo_lat_num, lon: +a.user_org_geo_long_num }))
      .filter(a => a.lat).map(a => ({ ...a, dist: Geo.haversine(p, a) })).sort((a, b) => a.dist - b.dist);
  }

  root.Ohio = { inOhio, geocode, addressPoint, parcel, buildings, streets, childCare, childCareStateCounts, schoolDistrict, schools, getJSON, title };
})(typeof window !== 'undefined' ? window : globalThis);

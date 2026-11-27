/* Pure geometry + direction logic. No DOM, no network, so it can be tested in Node. */
(function (root) {
  const R = 6371008.8; // Earth radius (m)
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const norm360 = d => ((d % 360) + 360) % 360;

  function haversine(a, b) {
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Local flat projection (meters) around an origin. Accurate to centimetres over a few hundred meters.
  function projector(origin) {
    const kx = Math.cos(toRad(origin.lat)) * 111320, ky = 110540;
    return {
      fwd: p => ({ x: (p.lon - origin.lon) * kx, y: (p.lat - origin.lat) * ky }),
      inv: q => ({ lon: origin.lon + q.x / kx, lat: origin.lat + q.y / ky })
    };
  }

  // Bearing of a local vector (x = east, y = north), 0 = north, clockwise.
  const vecBearing = (x, y) => norm360(toDeg(Math.atan2(x, y)));

  function angleDiff(a, b) { const d = Math.abs(norm360(a) - norm360(b)); return d > 180 ? 360 - d : d; }

  const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const DIR_NAMES = { N: 'North', NE: 'North-East', E: 'East', SE: 'South-East', S: 'South', SW: 'South-West', W: 'West', NW: 'North-West' };
  const DIR_CENTER = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
  const AVOID = new Set(['S', 'SE', 'SW']);
  // Avoid range is 112.5° .. 247.5° (everything that rounds to SE, S or SW).
  const AVOID_START = 112.5, AVOID_END = 247.5;

  function classify(bearing) {
    const b = norm360(bearing);
    const dir = DIRS[Math.round(b / 45) % 8];
    const avoid = AVOID.has(dir);
    const edgeDist = Math.min(angleDiff(b, AVOID_START), angleDiff(b, AVOID_END));
    return { bearing: b, dir, name: DIR_NAMES[dir], avoid, nearBoundary: edgeDist < 10, edgeDist };
  }

  function pointInPolygon(pt, poly) { // poly: [{x,y}] in local coords
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  function polygonArea(poly) {
    let a = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
    return Math.abs(a / 2);
  }

  function polygonCentroid(poly) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const f = poly[j].x * poly[i].y - poly[i].x * poly[j].y;
      a += f; cx += (poly[j].x + poly[i].x) * f; cy += (poly[j].y + poly[i].y) * f;
    }
    if (Math.abs(a) < 1e-9) {
      const n = poly.length; return { x: poly.reduce((s, p) => s + p.x, 0) / n, y: poly.reduce((s, p) => s + p.y, 0) / n };
    }
    a *= 0.5; return { x: cx / (6 * a), y: cy / (6 * a) };
  }

  function nearestOnSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    return { pt: q, dist: Math.hypot(p.x - q.x, p.y - q.y) };
  }

  function nearestOnLine(p, line) {
    let best = { pt: line[0], dist: Infinity };
    for (let i = 1; i < line.length; i++) {
      const r = nearestOnSegment(p, line[i - 1], line[i]);
      if (r.dist < best.dist) best = r;
    }
    return best;
  }

  // Distance from a point to a polygon's boundary (0 if inside).
  function distToPolygon(p, poly) {
    if (pointInPolygon(p, poly)) return 0;
    const ring = poly[0].x === poly[poly.length - 1].x && poly[0].y === poly[poly.length - 1].y ? poly : [...poly, poly[0]];
    return nearestOnLine(p, ring).dist;
  }

  // Normalise street names so "Oak St" matches "Oak Street" and "Mason-Montgomery Rd" matches "Mason Montgomery Road".
  const ABBR = {
    st: 'street', str: 'street', rd: 'road', ave: 'avenue', av: 'avenue', dr: 'drive', ln: 'lane', ct: 'court', crt: 'court', cir: 'circle',
    blvd: 'boulevard', pl: 'place', ter: 'terrace', trl: 'trail', tr: 'trail', pkwy: 'parkway', pky: 'parkway', hwy: 'highway', cv: 'cove',
    n: 'north', s: 'south', e: 'east', w: 'west', ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest',
    sq: 'square', xing: 'crossing', lp: 'loop', pt: 'point', hts: 'heights', mt: 'mount', rdg: 'ridge', run: 'run', pass: 'pass',
    cres: 'crescent', grn: 'green', gln: 'glen', hl: 'hill', holw: 'hollow', lndg: 'landing', mdw: 'meadow', mdws: 'meadows', pk: 'park',
    vw: 'view', vly: 'valley', wds: 'woods', way: 'way', wy: 'way', bnd: 'bend', brk: 'brook', ck: 'creek', crk: 'creek', est: 'estate', ests: 'estates', frst: 'forest', spg: 'spring', spgs: 'springs', sta: 'station', twp: 'township', tpke: 'turnpike'
  };
  function normStreet(s) {
    return (s || '').toLowerCase().replace(/[.,#'\-]/g, ' ').split(/\s+/).filter(Boolean)
      .map(w => ABBR[w] || w).join(' ');
  }
  // Same street ignoring the type word ("Patriot Court" vs "Patriot") – used only as a weaker match.
  const TYPE_WORDS = new Set(Object.values(ABBR).filter(w => !/^(north|south|east|west|northeast|northwest|southeast|southwest)$/.test(w)));
  function streetCore(s) { return normStreet(s).split(' ').filter(w => !TYPE_WORDS.has(w) && !/^(north|south|east|west)$/.test(w)).join(' '); }

  const DRIVABLE = /^(residential|living_street|unclassified|tertiary|secondary|primary|trunk|tertiary_link|secondary_link|primary_link|road)$/;

  // Pick the wall of the building that faces the street, and return its outward direction.
  function facingWall(poly, origin, roadBearing, maxDiff) {
    let best = null;
    const ring = poly[0].x === poly[poly.length - 1].x && poly[0].y === poly[poly.length - 1].y ? poly : [...poly, poly[0]];
    // Merge nearly-collinear consecutive edges so a wall made of several short segments counts as one wall.
    const walls = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i], b = ring[i + 1], len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.3) continue;
      const brg = vecBearing(b.x - a.x, b.y - a.y);
      const last = walls[walls.length - 1];
      if (last && angleDiff(last.brg, brg) < 8) { last.b = b; last.len += len; }
      else walls.push({ a, b, len, brg });
    }
    for (const w of walls) {
      const { a, b } = w, len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 2.5) continue;
      let nx = (b.y - a.y) / len, ny = -(b.x - a.x) / len;
      const mx = (a.x + b.x) / 2 - origin.x, my = (a.y + b.y) / 2 - origin.y;
      if (nx * mx + ny * my < 0) { nx = -nx; ny = -ny; }
      const nb = vecBearing(nx, ny), diff = angleDiff(nb, roadBearing);
      if (diff <= maxDiff) {
        const score = w.len * Math.cos(toRad(diff));
        if (!best || score > best.score) best = { bearing: nb, diff, len: w.len, score };
      }
    }
    return best;
  }

  /**
   * Estimate which way the house faces (the direction you face stepping out the front door).
   * Works with either county-grade data (Ohio: LBRS address point, parcel, FEMA/ORNL footprints, LBRS centerlines)
   * or OpenStreetMap data elsewhere.
   * @param house      {lat, lon}  address point (or a point the user tapped)
   * @param buildings  [{id, tags, geometry:[{lat,lon}]}]
   * @param roads      [{id, tags:{name, highway}, geometry:[{lat,lon}]}]
   * @param streetName street from the address (e.g. "Patriot Ct"), optional
   * @param parcel     optional {geometry:[{lat,lon}]} – the lot the address sits on
   */
  function estimateFacing(house, buildings, roads, streetName, parcel) {
    const P = projector(house);
    const hp = { x: 0, y: 0 };
    const notes = [];
    const parcelPoly = parcel && parcel.geometry && parcel.geometry.length > 3 ? parcel.geometry.map(P.fwd) : null;

    // 1. Pick the house.
    //    With a parcel: the biggest building whose centre is on the lot (garages/sheds are smaller).
    //    Without: the building containing the point, else the nearest within 40 m.
    let building = null;
    const polys = (buildings || []).filter(b => b.geometry && b.geometry.length >= 4).map(b => {
      const poly = b.geometry.map(P.fwd);
      return { ...b, poly, area: polygonArea(poly), c: polygonCentroid(poly) };
    }).filter(b => b.area >= 35);
    if (parcelPoly) {
      const onLot = polys.filter(b => pointInPolygon(b.c, parcelPoly) && !(b.tags && /^(y|yes|true|1)$/i.test(String(b.tags.OUTBLDG || ''))));
      if (onLot.length) building = onLot.sort((a, b) => b.area - a.area)[0];
    }
    if (!building) {
      let bestD = Infinity;
      for (const b of polys) {
        if (pointInPolygon(hp, b.poly)) { building = b; break; }
        const d = distToPolygon(hp, b.poly);
        if (d < bestD && d < 40) { bestD = d; building = b; }
      }
      if (building && parcelPoly) notes.push('The house outline found on the map is not fully inside the lot boundary. Check that the highlighted building is the right house.');
    }
    const origin = building ? building.c : hp;
    if (!building) notes.push('No building outline found here, so the estimate uses the address point.');

    // 2. Pick the street the address is on.
    const target = normStreet(streetName), targetCore = streetCore(streetName);
    const cand = (roads || []).filter(r => r.geometry && r.geometry.length > 1 && r.tags && (!r.tags.highway || DRIVABLE.test(r.tags.highway)))
      .map(r => {
        const line = r.geometry.map(P.fwd), n = nearestOnLine(origin, line);
        const nm = normStreet(r.tags.name);
        const match = !!target && nm === target ? 2 : (!!targetCore && streetCore(r.tags.name) === targetCore ? 1 : 0);
        return { road: r, line, near: n, name: r.tags.name || '(unnamed road)', match };
      })
      .sort((a, b) => a.near.dist - b.near.dist);
    if (!cand.length) return { ok: false, reason: 'No streets found near this address.' };

    const best = Math.max(...cand.map(c => c.match));
    let chosen = best > 0 ? cand.find(c => c.match === best) : null;
    const matched = !!chosen;
    if (!chosen) {
      chosen = cand.find(c => c.road.tags.name) || cand[0];
      if (target) notes.push(`Couldn't find "${streetName}" on the street map nearby; used the closest street (${chosen.name}).`);
    } else if (chosen.near.dist > 120) {
      notes.push(`The matched street (${chosen.name}) is ${Math.round(chosen.near.dist * 3.28)} ft away, which is unusual. Check the house on the map.`);
    }

    // Direction from the house toward its street. Using the lot frontage when we have the parcel:
    // the nearest point on the street to the house can sit off to the side on curves/cul-de-sacs,
    // so look at where the street runs along the lot boundary instead.
    let toRoad = { x: chosen.near.pt.x - origin.x, y: chosen.near.pt.y - origin.y };
    let frontage = null;
    if (parcelPoly) {
      const ring = [...parcelPoly]; if (ring[0].x !== ring[ring.length - 1].x || ring[0].y !== ring[ring.length - 1].y) ring.push(ring[0]);
      // sample the lot boundary; boundary points within 30 m of the street are the frontage
      const pts = [];
      for (let i = 0; i < ring.length - 1; i++) {
        const a = ring[i], b = ring[i + 1], len = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(len / 1.5));
        for (let k = 0; k < n; k++) pts.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
      }
      const front = pts.filter(q => nearestOnLine(q, chosen.line).dist < 30);
      if (front.length >= 3) {
        const fx = front.reduce((s, q) => s + q.x, 0) / front.length, fy = front.reduce((s, q) => s + q.y, 0) / front.length;
        frontage = { x: fx, y: fy, len: front.length * 1.5 };
        toRoad = { x: fx - origin.x, y: fy - origin.y };
      }
    }
    const roadBearing = vecBearing(toRoad.x, toRoad.y);

    // 3. Refine with the wall that faces the street (houses are built square to their street).
    const wall = building ? facingWall(building.poly, origin, roadBearing, 40) : null;
    const wallBearing = wall ? wall.bearing : null;
    const bearing = wallBearing != null ? wallBearing : roadBearing;

    // 4. Other streets next to this lot: corner lot (side street) or a street behind.
    let corner = null;
    const lotEdgeDist = c => parcelPoly ? Math.min(...parcelPoly.map(q => nearestOnLine(q, c.line).dist)) : c.near.dist;
    for (const c of cand) {
      if (c === chosen || !c.road.tags.name || normStreet(c.name) === normStreet(chosen.name)) continue;
      const near = parcelPoly ? lotEdgeDist(c) < 20 : (c.near.dist < 45 && c.near.dist < chosen.near.dist * 1.8);
      if (!near) continue;
      const b2 = vecBearing(c.near.pt.x - origin.x, c.near.pt.y - origin.y);
      const diff = angleDiff(b2, roadBearing);
      if ((diff > 50 && diff < 130) || (diff >= 130 && !matched)) { corner = { name: c.name, bearing: b2, dist: c.near.dist, behind: diff >= 130 }; break; }
    }
    if (corner) notes.push(corner.behind
      ? `There's also a street behind the house (${corner.name}, on the ${classify(corner.bearing).name} side). Make sure the front door isn't on that side.`
      : `Corner lot: ${corner.name} also runs along this lot (on the ${classify(corner.bearing).name} side). The front door could face either street. Check Street View.`);

    // 5. Confidence.
    let confidence = 'low';
    const squareToStreet = wall && wall.diff <= 25;
    if (building && matched === true && !corner && squareToStreet) confidence = 'high';
    else if (building && (matched || !target) && wall) confidence = 'medium';
    if (confidence === 'high' && wall.diff > 15) notes.push(`The house sits at an angle to the street (${Math.round(wall.diff)}°). Double-check with Street View.`);

    return {
      ok: true, bearing, roadBearing, wallBearing, wallDiff: wall ? wall.diff : null, confidence, notes, corner,
      street: chosen.name, streetTags: chosen.road.tags, streetDist: chosen.near.dist, matched,
      building: building ? { id: building.id, tags: building.tags, geometry: building.geometry, areaM2: building.area } : null,
      usedParcel: !!parcelPoly, frontage: frontage ? P.inv(frontage) : null,
      origin: P.inv(origin), roadPoint: P.inv(frontage || chosen.near.pt)
    };
  }

  // Distance from a point to an OSM way geometry, meters.
  function distToGeometry(p, geom) {
    if (!geom || !geom.length) return Infinity;
    const P = projector(p);
    const line = geom.map(P.fwd);
    if (line.length === 1) return Math.hypot(line[0].x, line[0].y);
    return nearestOnLine({ x: 0, y: 0 }, line).dist;
  }

  // Area of a lat/lon ring in square metres.
  function areaM2(geom) { if (!geom || geom.length < 3) return 0; const P = projector(geom[0]); return polygonArea(geom.map(P.fwd)); }

  // Circular mean of headings (degrees).
  function circularMean(list) {
    let s = 0, c = 0;
    for (const d of list) { s += Math.sin(toRad(d)); c += Math.cos(toRad(d)); }
    return norm360(toDeg(Math.atan2(s, c)));
  }

  const api = { haversine, classify, estimateFacing, distToGeometry, areaM2, circularMean, normStreet, streetCore, angleDiff, norm360, projector, pointInPolygon, polygonCentroid, DIRS, DIR_NAMES, DIR_CENTER, AVOID_START, AVOID_END };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Geo = api;
})(typeof window !== 'undefined' ? window : globalThis);

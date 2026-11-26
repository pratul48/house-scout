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

  // Local flat projection (meters) around an origin. Accurate enough for a few hundred meters.
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

  // Normalise street names so "Oak St" matches "Oak Street".
  const ABBR = {
    st: 'street', rd: 'road', ave: 'avenue', av: 'avenue', dr: 'drive', ln: 'lane', ct: 'court', cir: 'circle',
    blvd: 'boulevard', pl: 'place', ter: 'terrace', trl: 'trail', pkwy: 'parkway', hwy: 'highway', cv: 'cove',
    n: 'north', s: 'south', e: 'east', w: 'west', ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest',
    sq: 'square', way: 'way', xing: 'crossing', lp: 'loop', pt: 'point', hts: 'heights', mt: 'mount'
  };
  function normStreet(s) {
    return (s || '').toLowerCase().replace(/[.,#]/g, ' ').split(/\s+/).filter(Boolean)
      .map(w => ABBR[w] || w).join(' ');
  }

  const DRIVABLE = /^(residential|living_street|unclassified|tertiary|secondary|primary|trunk|tertiary_link|secondary_link|primary_link|road)$/;

  /**
   * Estimate which way the house faces.
   * @param house {lat, lon}            geocoded point (or a point the user tapped)
   * @param buildings [{id, tags, geometry:[{lat,lon}]}]
   * @param roads     [{id, tags, geometry:[{lat,lon}]}]
   * @param streetName street from the address (e.g. "Oak Street"), optional
   */
  function estimateFacing(house, buildings, roads, streetName) {
    const P = projector(house);
    const hp = { x: 0, y: 0 };
    const notes = [];

    // 1. Pick the building: one containing the point, else nearest within 40 m.
    let building = null, bestD = Infinity;
    for (const b of buildings || []) {
      if (!b.geometry || b.geometry.length < 4) continue;
      const poly = b.geometry.map(P.fwd);
      if (pointInPolygon(hp, poly)) { building = { ...b, poly }; bestD = 0; break; }
      const c = polygonCentroid(poly), d = Math.hypot(c.x, c.y);
      if (d < bestD && d < 40) { bestD = d; building = { ...b, poly }; }
    }
    const origin = building ? polygonCentroid(building.poly) : hp;
    if (!building) notes.push('No building outline found on the map here, so the estimate uses the address point.');

    // 2. Pick the street the address is on.
    const target = normStreet(streetName);
    const cand = (roads || []).filter(r => r.geometry && r.geometry.length > 1 && r.tags && DRIVABLE.test(r.tags.highway || ''))
      .map(r => {
        const line = r.geometry.map(P.fwd), n = nearestOnLine(origin, line);
        const nm = normStreet(r.tags.name);
        return { road: r, near: n, name: r.tags.name || '(unnamed road)', match: !!target && nm === target };
      })
      .sort((a, b) => a.near.dist - b.near.dist);
    if (!cand.length) return { ok: false, reason: 'No streets found near this address on OpenStreetMap.' };

    let chosen = cand.find(c => c.match);
    let matched = !!chosen;
    if (!chosen) {
      chosen = cand.find(c => c.road.tags.name) || cand[0];
      if (target) notes.push(`Couldn't find "${streetName}" on the map nearby; used the closest street (${chosen.name}).`);
    }

    const toRoad = { x: chosen.near.pt.x - origin.x, y: chosen.near.pt.y - origin.y };
    const roadBearing = vecBearing(toRoad.x, toRoad.y);

    // 3. Refine with the building wall that faces that street (houses are usually square to the street).
    let wallBearing = null;
    if (building) {
      let bestLen = 0;
      const poly = building.poly;
      for (let i = 0; i < poly.length - 1; i++) {
        const a = poly[i], b = poly[i + 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 3) continue;
        let nx = (b.y - a.y) / len, ny = -(b.x - a.x) / len;
        const mx = (a.x + b.x) / 2 - origin.x, my = (a.y + b.y) / 2 - origin.y;
        if (nx * mx + ny * my < 0) { nx = -nx; ny = -ny; } // make it point outward
        const nb = vecBearing(nx, ny);
        const diff = angleDiff(nb, roadBearing);
        if (diff <= 35) {
          const score = len * Math.cos(toRad(diff));
          if (score > bestLen) { bestLen = score; wallBearing = nb; }
        }
      }
    }
    const bearing = wallBearing != null ? wallBearing : roadBearing;

    // 4. Corner lot? Another named street almost as close, in a clearly different direction.
    let corner = null;
    for (const c of cand) {
      if (c === chosen || !c.road.tags.name || normStreet(c.name) === normStreet(chosen.name)) continue;
      if (c.near.dist < 45 && c.near.dist < chosen.near.dist * 1.8) {
        const b2 = vecBearing(c.near.pt.x - origin.x, c.near.pt.y - origin.y);
        const diff = angleDiff(b2, roadBearing);
        // ~90° apart = corner lot. A street directly behind (~180°) only matters if we couldn't match the address street.
        if ((diff > 50 && diff < 130) || (diff >= 130 && !matched)) { corner = { name: c.name, bearing: b2, dist: c.near.dist, behind: diff >= 130 }; break; }
      }
    }
    if (corner) notes.push(corner.behind
      ? `There's also a street behind the house (${corner.name}, on the ${classify(corner.bearing).name} side). Make sure the front door isn't on that side.`
      : `Possible corner lot: ${corner.name} is also close (on the ${classify(corner.bearing).name} side). The front door could face either street.`);

    let confidence = 'low';
    if (building && matched && !corner) confidence = wallBearing != null ? 'high' : 'medium';
    else if (building && (matched || !target)) confidence = 'medium';

    return {
      ok: true, bearing, roadBearing, wallBearing, confidence, notes, corner,
      street: chosen.name, streetDist: chosen.near.dist, matched,
      building: building ? { id: building.id, tags: building.tags, geometry: building.geometry } : null,
      origin: P.inv(origin), roadPoint: P.inv(chosen.near.pt)
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

  // Circular mean of headings (degrees).
  function circularMean(list) {
    let s = 0, c = 0;
    for (const d of list) { s += Math.sin(toRad(d)); c += Math.cos(toRad(d)); }
    return norm360(toDeg(Math.atan2(s, c)));
  }

  const api = { haversine, classify, estimateFacing, distToGeometry, circularMean, normStreet, angleDiff, norm360, DIRS, DIR_NAMES, DIR_CENTER, AVOID_START, AVOID_END };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Geo = api;
})(typeof window !== 'undefined' ? window : globalThis);

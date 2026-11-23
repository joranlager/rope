// The name of the road someone is on. Pure, so it is unit tested.
//
// Asked of OpenStreetMap's data through the Overpass API: every named road within RADIUS_M of the
// point, with its shape. The nearest one wins. If no road is that close the answer is "unknown"
// (null) and nothing is shown, rather than a guess at a road across a field.

export const OVERPASS = 'https://overpass-api.de/api/interpreter';
export const RADIUS_M = 25;      // a GPS fix is good to about this much on a road
export const MIN_MOVE_M = 25;    // ask again only after moving this far
export const MIN_GAP_MS = 6000;  // ... and not more often than this (the service is shared by everyone)
export const MAX_ACCURACY_M = 60; // a rougher fix could name the wrong road

// Kinds of way that are roads you can be "on". Not buildings, borders, rivers or railways.
const ROADS = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|track|road|footway|path|cycleway|steps|bridleway|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

export function roadQuery(lat, lon, radius = RADIUS_M) {
  const q = `[out:json][timeout:8];way(around:${radius},${lat.toFixed(6)},${lon.toFixed(6)})[highway~"^(${ROADS})$"];out tags geom;`;
  return `${OVERPASS}?data=${encodeURIComponent(q)}`;
}

/** Metres from a point to a segment, on a flat map around the point (fine at these distances). */
export function distToSegmentM(lat, lon, a, b) {
  const k = Math.cos((lat * Math.PI) / 180);
  const m = 111320;
  const px = 0;
  const py = 0;
  const ax = (a.lon - lon) * k * m, ay = (a.lat - lat) * m;
  const bx = (b.lon - lon) * k * m, by = (b.lat - lat) * m;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

const nameOf = (tags = {}) => {
  const n = (tags.name || tags.ref || '').trim();
  return n || null;
};

/** The name of the nearest named road in an Overpass answer, or null. */
export function parseRoad(json, lat, lon, radius = RADIUS_M) {
  let best = null;
  for (const way of json?.elements ?? []) {
    const name = nameOf(way.tags);
    const g = way.geometry;
    if (!name || !Array.isArray(g) || g.length === 0) continue;
    let d = g.length === 1 ? distToSegmentM(lat, lon, g[0], g[0]) : Infinity;
    for (let i = 0; i + 1 < g.length; i++) d = Math.min(d, distToSegmentM(lat, lon, g[i], g[i + 1]));
    if (d <= radius && (!best || d < best.d)) best = { name, d };
  }
  return best ? best.name : null;
}

/** Is it time to ask again? last = { lat, lon, at, id } of the previous question, or null. */
export function shouldLookup(last, now, p, haversine) {
  if (!p || (p.acc != null && p.acc > MAX_ACCURACY_M)) return false;
  if (!last) return true;
  if (last.id !== p.id) return now - last.at >= 1000; // a different person: do not wait long
  if (now - last.at < MIN_GAP_MS) return false;
  return haversine(last.lat, last.lon, p.lat, p.lon) >= MIN_MOVE_M;
}

// Direct (great-circle) distance from me to each person, for the map. Pure, so it is unit tested.

import { haversineM } from './geo.js';

/**
 * A short label for a distance.
 *   under 1 000 m   whole metres:      "850 m"
 *   1 000 m and up  kilometres:        "1.25 km", "12.3 km", "152 km", "1 520 km" (thin-space grouping)
 * Precision falls as the number grows, so labels stay short. Rounding happens first, so
 * 999.6 m reads "1 km" and never "1000 m".
 */
export function formatDistance(meters) {
  const m = Math.max(0, meters);
  if (Math.round(m) < 1000) return `${Math.round(m)} m`;
  const km = m / 1000;
  const digits = km < 10 ? 2 : km < 100 ? 1 : 0;
  // Built by hand, not with toLocaleString, so every browser prints exactly the same thing.
  const [whole, fraction] = km.toFixed(digits).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f'); // thin no-break space
  const trimmed = fraction ? fraction.replace(/0+$/, '') : '';
  return `${grouped}${trimmed ? `.${trimmed}` : ''} km`;
}

// Web Mercator, so a label sits at the visual middle of the straight line the map draws.
const toMercator = ([lon, lat]) => ({
  x: (lon + 180) / 360,
  y: (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2,
});
const fromMercator = ({ x, y }) => [
  x * 360 - 180,
  (360 / Math.PI) * Math.atan(Math.exp(Math.PI * (1 - 2 * y))) - 90,
];

/** The point halfway along the line between two [lon, lat] points, as drawn on the map. */
export function mapMidpoint(a, b) {
  const p = toMercator(a);
  const q = toMercator(b);
  return fromMercator({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
}

/**
 * For me and a list of people ({ id, lat, lon, color }): one item each, nearest first, with the
 * distance, its label, the line to draw and where to put the label.
 */
export function buildDistanceItems(me, people) {
  return people
    .map((p) => {
      const meters = haversineM(me.lat, me.lon, p.lat, p.lon);
      return {
        id: p.id,
        color: p.color,
        meters,
        text: formatDistance(meters),
        line: [[me.lon, me.lat], [p.lon, p.lat]],
        mid: mapMidpoint([me.lon, me.lat], [p.lon, p.lat]),
      };
    })
    .sort((a, b) => a.meters - b.meters);
}

/**
 * The part of the segment p->q (screen pixels) that lies inside `rect` ({ left, top, right, bottom }),
 * or null if none of it does. Liang-Barsky clipping.
 */
export function clipSegment(p, q, rect) {
  let t0 = 0;
  let t1 = 1;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const edges = [
    [-dx, p.x - rect.left],
    [dx, rect.right - p.x],
    [-dy, p.y - rect.top],
    [dy, rect.bottom - p.y],
  ];
  for (const [pn, qn] of edges) {
    if (pn === 0) {
      if (qn < 0) return null; // parallel to this edge and outside it
      continue;
    }
    const r = qn / pn;
    if (pn < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return { a: { x: p.x + t0 * dx, y: p.y + t0 * dy }, b: { x: p.x + t1 * dx, y: p.y + t1 * dy } };
}

/** Where to put a label so it is on screen: the middle of the visible part of the line, or null. */
export function visibleMidpoint(p, q, rect) {
  const seg = clipSegment(p, q, rect);
  return seg ? { x: (seg.a.x + seg.b.x) / 2, y: (seg.a.y + seg.b.y) / 2 } : null;
}

/** The point on the opposite side of `center` from `p`, as the map draws it. */
export function mirrorAround(center, p) {
  const c = toMercator(center);
  const q = toMercator(p);
  return fromMercator({ x: 2 * c.x - q.x, y: 2 * c.y - q.y });
}

/**
 * Bounds that contain every point and are centred exactly on `center` (as the map draws it).
 * Fitting the map to these keeps me in the middle while everyone else is in view.
 * Returns [[west, south], [east, north]].
 */
export function symmetricBounds(center, points) {
  const all = [center, ...points, ...points.map((p) => mirrorAround(center, p))];
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [lon, lat] of all) {
    west = Math.min(west, lon); east = Math.max(east, lon);
    south = Math.min(south, lat); north = Math.max(north, lat);
  }
  return [[west, south], [east, north]];
}

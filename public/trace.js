// Trails: the last stretch of path someone has travelled. Pure, so it is unit tested.
//
// A trail is an array of { lat, lon, ts }, oldest first. It is kept to the most recent
// `meters` of path. The map draws it with a gradient so the oldest part fades away.

import { haversineM } from './geo.js';

export const TRACE_OPTIONS = [250, 500, 1000, 2000, 5000]; // metres
export const DEFAULT_TRACE_METERS = 1000;
export const MIN_STEP_M = 5;            // ignore GPS jitter smaller than this
export const MAX_GAP_MS = 5 * 60 * 1000; // don't draw a line across a long silence

// Trail colours: Apple's system colours. 'auto' uses the person's own colour (blue for me).
export const TRACE_COLORS = [
  { id: 'blue', name: 'Blue', hex: '#007aff' },
  { id: 'green', name: 'Green', hex: '#34c759' },
  { id: 'orange', name: 'Orange', hex: '#ff9500' },
  { id: 'red', name: 'Red', hex: '#ff3b30' },
  { id: 'pink', name: 'Pink', hex: '#ff2d55' },
  { id: 'purple', name: 'Purple', hex: '#af52de' },
  { id: 'indigo', name: 'Indigo', hex: '#5856d6' },
  { id: 'teal', name: 'Teal', hex: '#30b0c7' },
];
export const AUTO_COLOR = 'auto';

/** The hex for a palette id, or null for 'auto' and anything unknown. */
export const colorHex = (id) => TRACE_COLORS.find((c) => c.id === id)?.hex ?? null;

/** '#rrggbb' to 'rgba(r, g, b, a)'. */
export function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Normalises stored settings. Tracing is off unless explicitly switched on. */
export function traceSettings(t) {
  return {
    on: t?.on === true,
    meters: TRACE_OPTIONS.includes(t?.meters) ? t.meters : DEFAULT_TRACE_METERS,
    color: colorHex(t?.color) ? t.color : AUTO_COLOR,
  };
}

export function trailLength(trail) {
  let total = 0;
  for (let i = 1; i < trail.length; i++) {
    total += haversineM(trail[i - 1].lat, trail[i - 1].lon, trail[i].lat, trail[i].lon);
  }
  return total;
}

/** Keeps only the most recent `meters` of path, cutting the oldest segment exactly. */
export function trimToDistance(trail, meters) {
  if (trail.length < 2) return trail;
  let remaining = meters;
  for (let i = trail.length - 1; i > 0; i--) {
    const a = trail[i - 1];
    const b = trail[i];
    const d = haversineM(a.lat, a.lon, b.lat, b.lon);
    if (d >= remaining) {
      const t = d === 0 ? 0 : (d - remaining) / d; // how far along a->b the cut lies
      const cut = {
        lat: a.lat + (b.lat - a.lat) * t,
        lon: a.lon + (b.lon - a.lon) * t,
        ts: a.ts + (b.ts - a.ts) * t,
      };
      return [cut, ...trail.slice(i)];
    }
    remaining -= d;
  }
  return trail;
}

/** Adds a point and returns the new trail. Never mutates the one passed in. */
export function addPoint(trail, pt, meters) {
  const last = trail[trail.length - 1];
  if (last) {
    if (pt.ts < last.ts) return trail; // out of order
    if (pt.ts - last.ts > MAX_GAP_MS) return [pt]; // start again after a gap
    if (haversineM(last.lat, last.lon, pt.lat, pt.lon) < MIN_STEP_M) return trail; // jitter
  }
  return trimToDistance([...trail, pt], meters);
}

/** GeoJSON line, [lon, lat] order, oldest point first (so line-progress 0 is the faded end). */
export function toFeature(trail) {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: trail.map((p) => [p.lon, p.lat]) },
  };
}

export const labelForMeters = (m) => (m >= 1000 ? `${m / 1000} km` : `${m} m`);

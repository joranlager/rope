// Trails: the last stretch of path someone has travelled. Pure, so it is unit tested.
//
// A trail is an array of { lat, lon, ts }, oldest first. It is kept to the most recent
// `meters` of path. The map draws it with a gradient so the oldest part fades away.

import { haversineM } from './geo.js';

// ---- The trail length is chosen with two wheels: a number and a unit ----
// The unit wheel is Metres, Kilometres, Miles. A length is stored as { unit, value } exactly as the
// wheels show it, so "3 mi" stays 3 mi (and is 4 828.032 m only when the map needs metres).
//   Metres      50, 100, ... 950   (steps of 50)
//   Kilometres  1, 2, ... 100
//   Miles       1, 2, ... 60
export const UNITS = ['m', 'km', 'mi'];
export const UNIT_NAMES = { m: 'Metres', km: 'Kilometres', mi: 'Miles' };
export const METERS_PER = { m: 1, km: 1000, mi: 1609.344 };
export const DEFAULT_LENGTH = { unit: 'km', value: 1 };
export const MIN_TRACE_M = 50;
export const MAX_TRACE_M = 100_000;

const RANGES = { m: [50, 950, 50], km: [1, 100, 1], mi: [1, 60, 1] }; // [first, last, step]
const range = (from, to, step = 1) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The numbers on the number wheel for a unit. */
export const wheelValues = (unit) => range(...RANGES[unit]);

/** A length in metres, as the map and the trail need it. */
export const metersOfLength = ({ unit, value }) => value * METERS_PER[unit];

/** The closest length, in this unit, to a number of metres. */
export function lengthForMeters(meters, unit) {
  const [first, last, step] = RANGES[unit];
  return { unit, value: clamp(Math.round(meters / METERS_PER[unit] / step) * step, first, last) };
}

/** A length that shows a number of metres well: kilometres from 1 km up, metres below. */
export const lengthFromMeters = (meters) => lengthForMeters(meters, meters >= 1000 ? 'km' : 'm');

/**
 * The unit wheel was turned: keep the length as close as the new unit allows.
 * 12 km -> Metres is 950 m (the most the wheel offers); 300 m -> Kilometres is 1 km (the least).
 */
export const changeUnit = (length, unit) => lengthForMeters(metersOfLength(length), unit);

export const isValidLength = (l) => Boolean(l) && UNITS.includes(l.unit) && wheelValues(l.unit).includes(l.value);

/** "300 m", "5 km", "3 mi" */
export const labelForLength = ({ unit, value }) => `${value} ${unit}`;

/**
 * Settings from storage made valid. A stored { unit, value } is used if it is on a wheel; an older
 * stored length in metres is converted; anything else is the default, 1 km.
 */
export function normalizeLength(t) {
  if (isValidLength(t?.length)) return { unit: t.length.unit, value: t.length.value };
  if (typeof t?.meters === 'number' && Number.isFinite(t.meters)) {
    return lengthFromMeters(clamp(t.meters, MIN_TRACE_M, MAX_TRACE_M));
  }
  return { ...DEFAULT_LENGTH };
}
export const MIN_STEP_M = 5;            // ignore GPS jitter smaller than this (more for long trails)
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
  const length = normalizeLength(t);
  return {
    on: t?.on === true,
    length,                          // what the wheels show: { unit, value }
    meters: metersOfLength(length),  // the same length in metres
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
    // Jitter is ignored, and a long trail needs fewer points: a 50 km trail does not need a point every 5 m.
    const minStep = Math.max(MIN_STEP_M, meters / 1500);
    if (haversineM(last.lat, last.lon, pt.lat, pt.lon) < minStep) return trail;
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

/** Kept for callers that only have metres. */
export const labelForMeters = (m) => labelForLength(lengthFromMeters(m));

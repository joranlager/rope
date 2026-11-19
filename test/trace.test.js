import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRACE_OPTIONS, TRACE_COLORS, traceSettings, trailLength, trimToDistance, addPoint, toFeature,
  labelForMeters, hexToRgba, colorHex, MAX_GAP_MS,
} from '../public/trace.js';

// One degree of latitude is about 111.2 km, so 0.001 degrees is about 111 m.
const walkNorth = (n, step = 0.001, t0 = 0) =>
  Array.from({ length: n }, (_, i) => ({ lat: 59 + i * step, lon: 10, ts: t0 + i * 10_000 }));

test('tracing is off by default, with a 1 km trail and an automatic colour', () => {
  assert.deepEqual(traceSettings(undefined), { on: false, meters: 1000, color: 'auto' });
  assert.deepEqual(traceSettings({}), { on: false, meters: 1000, color: 'auto' });
  assert.equal(traceSettings({ on: true }).on, true);
});

test('only the offered trail lengths are accepted', () => {
  assert.deepEqual(TRACE_OPTIONS, [250, 500, 1000, 2000, 5000]);
  assert.equal(traceSettings({ on: true, meters: 2000 }).meters, 2000);
  assert.equal(traceSettings({ on: true, meters: 123 }).meters, 1000);
  assert.equal(traceSettings({ on: true, meters: '500' }).meters, 1000);
});

test('a trail is cut to exactly the requested distance', () => {
  const trail = walkNorth(30); // about 3.2 km
  const cut = trimToDistance(trail, 1000);
  assert.ok(Math.abs(trailLength(cut) - 1000) < 1, `length ${trailLength(cut)}`);
  assert.deepEqual(cut.at(-1), trail.at(-1)); // the newest point is kept
});

test('a trail shorter than the limit is left alone', () => {
  const trail = walkNorth(4);
  assert.equal(trimToDistance(trail, 1000), trail);
  assert.equal(trimToDistance([], 1000).length, 0);
});

test('adding points keeps the trail within the limit and never mutates the input', () => {
  let trail = [];
  const frozen = [];
  for (const p of walkNorth(40)) {
    frozen.push(trail);
    trail = addPoint(trail, p, 500);
  }
  assert.ok(trailLength(trail) <= 500.5, `length ${trailLength(trail)}`);
  assert.ok(trailLength(trail) > 495);
  assert.equal(frozen[1].length, 1); // an earlier snapshot is untouched
});

test('GPS jitter below a few metres is ignored', () => {
  const first = { lat: 59, lon: 10, ts: 0 };
  const jitter = { lat: 59.00001, lon: 10, ts: 1000 }; // ~1 m
  const trail = addPoint(addPoint([], first, 1000), jitter, 1000);
  assert.equal(trail.length, 1);
});

test('a long silence starts a new trail instead of joining the gap', () => {
  const a = { lat: 59, lon: 10, ts: 0 };
  const far = { lat: 60, lon: 11, ts: MAX_GAP_MS + 1 };
  const trail = addPoint(addPoint([], a, 1000), far, 1000);
  assert.deepEqual(trail, [far]);
});

test('out-of-order points are ignored', () => {
  const t = addPoint(addPoint([], { lat: 59, lon: 10, ts: 100 }, 1000), { lat: 59.001, lon: 10, ts: 50 }, 1000);
  assert.equal(t.length, 1);
});

test('the map line is [lon, lat], oldest first', () => {
  const f = toFeature([{ lat: 59, lon: 10, ts: 0 }, { lat: 59.1, lon: 10.2, ts: 1 }]);
  assert.equal(f.geometry.type, 'LineString');
  assert.deepEqual(f.geometry.coordinates, [[10, 59], [10.2, 59.1]]);
});

test('trail lengths are labelled in metres or kilometres', () => {
  assert.equal(labelForMeters(250), '250 m');
  assert.equal(labelForMeters(1000), '1 km');
  assert.equal(labelForMeters(2000), '2 km');
});

test('each person can pick a trail colour from the palette; anything else is automatic', () => {
  assert.equal(traceSettings({ color: 'orange' }).color, 'orange');
  assert.equal(traceSettings({ color: 'auto' }).color, 'auto');
  assert.equal(traceSettings({ color: 'hotpink' }).color, 'auto');
  assert.equal(traceSettings({ color: '#ff0000' }).color, 'auto');
  assert.equal(traceSettings({ color: 42 }).color, 'auto');
});

test('the palette has unique ids and valid hex colours', () => {
  const ids = TRACE_COLORS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!ids.includes('auto'));
  for (const c of TRACE_COLORS) assert.match(c.hex, /^#[0-9a-f]{6}$/);
  assert.equal(colorHex('green'), '#34c759');
  assert.equal(colorHex('auto'), null);
});

test('hex colours convert to rgba for the map gradient', () => {
  assert.equal(hexToRgba('#007aff', 0.5), 'rgba(0, 122, 255, 0.5)');
  assert.equal(hexToRgba('#ff3b30', 0), 'rgba(255, 59, 48, 0)');
});

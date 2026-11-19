import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRACE_COLORS, traceSettings, wheelValues, wheelForMeters, wheelFromMeters, metersFromWheel, changeUnit, normalizeMeters, UNITS, trailLength, trimToDistance, addPoint, toFeature,
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

test('the trail length is a number wheel and a unit wheel', () => {
  assert.deepEqual(UNITS, ['m', 'km']);
  assert.deepEqual(wheelValues('m').slice(0, 3), [50, 100, 150]);
  assert.equal(wheelValues('m').at(-1), 950);
  assert.equal(wheelValues('m').length, 19);
  assert.deepEqual(wheelValues('km').slice(0, 3), [1, 2, 3]);
  assert.equal(wheelValues('km').at(-1), 100);
  assert.equal(wheelValues('km').length, 100);
});

test('a length maps to wheel positions and back', () => {
  assert.deepEqual(wheelFromMeters(250), { unit: 'm', value: 250 });
  assert.deepEqual(wheelFromMeters(950), { unit: 'm', value: 950 });
  assert.deepEqual(wheelFromMeters(1000), { unit: 'km', value: 1 });
  assert.deepEqual(wheelFromMeters(5000), { unit: 'km', value: 5 });
  assert.equal(metersFromWheel({ unit: 'km', value: 12 }), 12000);
  assert.equal(metersFromWheel({ unit: 'm', value: 300 }), 300);
  // every position on either wheel round-trips
  for (const v of wheelValues('m')) assert.equal(metersFromWheel(wheelFromMeters(v)), v);
  for (const v of wheelValues('km')) assert.equal(metersFromWheel(wheelFromMeters(v * 1000)), v * 1000);
});

test('turning the unit wheel keeps the length as close as the new unit allows', () => {
  assert.deepEqual(changeUnit({ unit: 'm', value: 500 }, 'km'), { unit: 'km', value: 1 }); // at least 1 km
  assert.deepEqual(changeUnit({ unit: 'm', value: 950 }, 'km'), { unit: 'km', value: 1 });
  assert.deepEqual(changeUnit({ unit: 'km', value: 5 }, 'm'), { unit: 'm', value: 950 }); // at most 950 m
  assert.deepEqual(changeUnit({ unit: 'km', value: 1 }, 'm'), { unit: 'm', value: 950 });
  assert.deepEqual(changeUnit({ unit: 'km', value: 7 }, 'km'), { unit: 'km', value: 7 });
});

test('a stored length is made valid: on the grid, within 50 m to 100 km, else 1 km', () => {
  assert.equal(normalizeMeters(250), 250);
  assert.equal(normalizeMeters(2000), 2000);
  assert.equal(normalizeMeters(100_000), 100_000);
  assert.equal(normalizeMeters(10), 50);          // too small: the least
  assert.equal(normalizeMeters(5_000_000), 100_000); // too large: the most
  assert.equal(normalizeMeters(123), 100);        // snapped to the grid
  assert.equal(normalizeMeters(1499), 1000);
  assert.equal(normalizeMeters('500'), 1000);     // not a number: the default
  assert.equal(normalizeMeters(NaN), 1000);
  assert.equal(normalizeMeters(undefined), 1000);
  assert.equal(traceSettings({ on: true, meters: 7000 }).meters, 7000);
  assert.equal(traceSettings({ on: true, meters: wheelForMeters(0, 'm').value }).meters, 50);
});

test('long trails keep fewer points', () => {
  // 20 m steps: kept for a 1 km trail (min step 5 m), ignored for a 50 km trail (min step ~33 m)
  const a = { lat: 59, lon: 10, ts: 0 };
  const b = { lat: 59.00018, lon: 10, ts: 1000 }; // ~20 m north
  assert.equal(addPoint(addPoint([], a, 1000), b, 1000).length, 2);
  assert.equal(addPoint(addPoint([], a, 50_000), b, 50_000).length, 1);
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

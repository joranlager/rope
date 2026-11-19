import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRACE_COLORS, traceSettings, wheelValues, lengthForMeters, lengthFromMeters, metersOfLength, changeUnit, normalizeLength,
  isValidLength, labelForLength, UNITS, UNIT_NAMES, METERS_PER, trailLength, trimToDistance, addPoint, toFeature,
  labelForMeters, hexToRgba, colorHex, MAX_GAP_MS,
} from '../public/trace.js';

// One degree of latitude is about 111.2 km, so 0.001 degrees is about 111 m.
const walkNorth = (n, step = 0.001, t0 = 0) =>
  Array.from({ length: n }, (_, i) => ({ lat: 59 + i * step, lon: 10, ts: t0 + i * 10_000 }));

test('tracing is off by default, with a 1 km trail and an automatic colour', () => {
  assert.deepEqual(traceSettings(undefined), { on: false, length: { unit: 'km', value: 1 }, meters: 1000, color: 'auto' });
  assert.deepEqual(traceSettings({}), { on: false, length: { unit: 'km', value: 1 }, meters: 1000, color: 'auto' });
  assert.equal(traceSettings({ on: true }).on, true);
});

test('the unit wheel is Metres, Kilometres, Miles', () => {
  assert.deepEqual(UNITS, ['m', 'km', 'mi']);
  assert.deepEqual(UNITS.map((u) => UNIT_NAMES[u]), ['Metres', 'Kilometres', 'Miles']);
  assert.equal(METERS_PER.mi, 1609.344);
});

test('each unit has its own number wheel', () => {
  assert.deepEqual(wheelValues('m').slice(0, 3), [50, 100, 150]);
  assert.equal(wheelValues('m').at(-1), 950);
  assert.equal(wheelValues('m').length, 19);
  assert.deepEqual(wheelValues('km').slice(0, 3), [1, 2, 3]);
  assert.equal(wheelValues('km').at(-1), 100);
  assert.deepEqual(wheelValues('mi').slice(0, 3), [1, 2, 3]);
  assert.equal(wheelValues('mi').at(-1), 60);
  assert.equal(wheelValues('mi').length, 60);
});

test('a length is stored as unit and value, and converts to metres only when needed', () => {
  assert.equal(metersOfLength({ unit: 'm', value: 300 }), 300);
  assert.equal(metersOfLength({ unit: 'km', value: 12 }), 12000);
  assert.equal(metersOfLength({ unit: 'mi', value: 3 }), 4828.032);
  assert.equal(labelForLength({ unit: 'mi', value: 3 }), '3 mi');
  assert.equal(labelForLength({ unit: 'm', value: 300 }), '300 m');
  assert.equal(labelForLength({ unit: 'km', value: 5 }), '5 km');
  // 3 miles stays 3 miles through settings; it is not turned into a rounded number of km
  assert.deepEqual(traceSettings({ length: { unit: 'mi', value: 3 } }).length, { unit: 'mi', value: 3 });
  assert.equal(traceSettings({ length: { unit: 'mi', value: 3 } }).meters, 4828.032);
});

test('metres map to the nearest position on a wheel', () => {
  assert.deepEqual(lengthFromMeters(250), { unit: 'm', value: 250 });
  assert.deepEqual(lengthFromMeters(1000), { unit: 'km', value: 1 });
  assert.deepEqual(lengthFromMeters(5000), { unit: 'km', value: 5 });
  assert.deepEqual(lengthForMeters(4828, 'mi'), { unit: 'mi', value: 3 });
  assert.deepEqual(lengthForMeters(10_000, 'mi'), { unit: 'mi', value: 6 });
  for (const v of wheelValues('m')) assert.equal(metersOfLength(lengthFromMeters(v)), v);
  for (const v of wheelValues('km')) assert.equal(metersOfLength(lengthFromMeters(v * 1000)), v * 1000);
});

test('turning the unit wheel keeps the length as close as the new unit allows', () => {
  assert.deepEqual(changeUnit({ unit: 'km', value: 12 }, 'm'), { unit: 'm', value: 950 });   // at most 950 m
  assert.deepEqual(changeUnit({ unit: 'm', value: 300 }, 'km'), { unit: 'km', value: 1 });   // at least 1 km
  assert.deepEqual(changeUnit({ unit: 'km', value: 5 }, 'mi'), { unit: 'mi', value: 3 });    // 5 km ~ 3.1 mi
  assert.deepEqual(changeUnit({ unit: 'mi', value: 10 }, 'km'), { unit: 'km', value: 16 });  // 16.09 km
  assert.deepEqual(changeUnit({ unit: 'mi', value: 3 }, 'm'), { unit: 'm', value: 950 });
  assert.deepEqual(changeUnit({ unit: 'm', value: 500 }, 'mi'), { unit: 'mi', value: 1 });
  assert.deepEqual(changeUnit({ unit: 'km', value: 7 }, 'km'), { unit: 'km', value: 7 });
  assert.deepEqual(changeUnit({ unit: 'km', value: 100 }, 'mi'), { unit: 'mi', value: 60 }); // at most 60 mi
});

test('stored settings are made valid: a valid length is kept, an old metres value is converted, else 1 km', () => {
  assert.ok(isValidLength({ unit: 'mi', value: 60 }));
  assert.ok(!isValidLength({ unit: 'mi', value: 61 }));
  assert.ok(!isValidLength({ unit: 'm', value: 120 }));   // not on the wheel
  assert.ok(!isValidLength({ unit: 'yd', value: 5 }));
  assert.ok(!isValidLength(null));
  assert.deepEqual(normalizeLength({ length: { unit: 'km', value: 7 } }), { unit: 'km', value: 7 });
  assert.deepEqual(normalizeLength({ meters: 250 }), { unit: 'm', value: 250 });      // from before miles existed
  assert.deepEqual(normalizeLength({ meters: 2000 }), { unit: 'km', value: 2 });
  assert.deepEqual(normalizeLength({ meters: 10 }), { unit: 'm', value: 50 });
  assert.deepEqual(normalizeLength({ meters: 5_000_000 }), { unit: 'km', value: 100 });
  assert.deepEqual(normalizeLength({ meters: '500' }), { unit: 'km', value: 1 });
  assert.deepEqual(normalizeLength({ length: { unit: 'mi', value: 99 } }), { unit: 'km', value: 1 });
  assert.deepEqual(normalizeLength(undefined), { unit: 'km', value: 1 });
  assert.equal(traceSettings({ on: true, meters: 7000 }).meters, 7000);
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

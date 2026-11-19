import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineM, formatMetres, elevationGainLoss } from '../public/geo.js';

test('haversine is zero for identical points', () => {
  assert.equal(haversineM(59.9, 10.7, 59.9, 10.7), 0);
});

test('Oslo to Bergen straight-line is about 305 km', () => {
  const d = haversineM(59.9139, 10.7522, 60.3913, 5.3221);
  assert.ok(Math.abs(d - 305_000) < 3_000, `got ${d}`);
});

test('one degree of latitude is about 111.2 km', () => {
  const d = haversineM(60, 10, 61, 10);
  assert.ok(Math.abs(d - 111_195) < 100, `got ${d}`);
});

test('distance is always shown in metres', () => {
  assert.equal(formatMetres(12345.6).endsWith(' m'), true);
  assert.equal(formatMetres(0.4), '0 m');
});

test('ascent and descent ignore gaps', () => {
  assert.deepEqual(elevationGainLoss([100, 120, null, 110, 150]), { up: 60, down: 10 });
  assert.deepEqual(elevationGainLoss([]), { up: 0, down: 0 });
});

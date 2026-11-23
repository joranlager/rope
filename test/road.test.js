import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roadQuery, parseRoad, distToSegmentM, shouldLookup, MIN_GAP_MS, MIN_MOVE_M } from '../public/road.js';
import { haversineM } from '../public/geo.js';

// A road running east-west at lat 60, from lon 10.000 to 10.002.
const way = (name, lat, tags = {}) => ({ type: 'way', tags: { highway: 'residential', ...(name ? { name } : {}), ...tags }, geometry: [{ lat, lon: 10.0 }, { lat, lon: 10.002 }] });
const north = (m) => 60 + m / 111320;

test('the query asks for roads around the point', () => {
  const u = decodeURIComponent(roadQuery(60.1234567, 10.5));
  assert.match(u, /around:35,60\.1235,10\.5000/);
  assert.match(u, /highway/);
});

test('distance to a segment: beside it, and past its end', () => {
  const a = { lat: 60, lon: 10 }, b = { lat: 60, lon: 10.002 };
  assert.ok(Math.abs(distToSegmentM(north(10), 10.001, a, b) - 10) < 0.2);
  const k = Math.cos((60 * Math.PI) / 180) * 111320;
  assert.ok(Math.abs(distToSegmentM(60, 10.002 + 30 / k, a, b) - 30) < 0.3);
});

test('the nearest named road within range wins', () => {
  const json = { elements: [way('Far Street', north(20)), way('Near Street', north(5))] };
  assert.equal(parseRoad(json, 60, 10.001), 'Near Street');
});

test('no road close enough, or none with a name: unknown (null)', () => {
  assert.equal(parseRoad({ elements: [way('Away Road', north(60))] }, 60, 10.001), null);
  assert.equal(parseRoad({ elements: [way(null, north(2))] }, 60, 10.001), null);
  assert.equal(parseRoad({ elements: [] }, 60, 10.001), null);
  assert.equal(parseRoad({}, 60, 10.001), null);
  assert.equal(parseRoad(null, 60, 10.001), null);
});

test('a road with only a reference (E6) is named by it; a name beats it', () => {
  assert.equal(parseRoad({ elements: [way(null, north(2), { ref: 'E6' })] }, 60, 10.001), 'E6');
  assert.equal(parseRoad({ elements: [way('Storgata', north(2), { ref: 'E6' })] }, 60, 10.001), 'Storgata');
});

test('broken geometry is ignored', () => {
  assert.equal(parseRoad({ elements: [{ tags: { name: 'X' } }, { tags: { name: 'Y' }, geometry: [] }] }, 60, 10.001), null);
});

test('when to ask again', () => {
  const p = (lat, id = 'me', acc = 10) => ({ lat, lon: 10, acc, id });
  const last = { lat: 60, lon: 10, at: 0, id: 'me' };
  assert.equal(shouldLookup(null, 0, p(60), haversineM), true);
  assert.equal(shouldLookup(last, MIN_GAP_MS - 1, p(north(500)), haversineM), false, 'too soon');
  assert.equal(shouldLookup(last, MIN_GAP_MS, p(north(MIN_MOVE_M - 5)), haversineM), false, 'not moved enough');
  assert.equal(shouldLookup(last, MIN_GAP_MS, p(north(MIN_MOVE_M + 5)), haversineM), true);
  assert.equal(shouldLookup(last, 1500, p(60, 'anna'), haversineM), true, 'another person');
  assert.equal(shouldLookup(null, 0, p(60, 'me', 200), haversineM), false, 'rough fix');
  assert.equal(shouldLookup(null, 0, null, haversineM), false);
});

import { describeRoad, tapRadiusM } from '../public/road.js';

test('a tapped road is described: title, facts and its shape', () => {
  const json = { elements: [way('Storgata', north(4), { maxspeed: '50', lanes: '2', surface: 'asphalt', oneway: 'yes', lit: 'yes', ref: 'Fv12' })] };
  const r = describeRoad(json, 60, 10.001);
  assert.equal(r.title, 'Storgata');
  const rows = Object.fromEntries(r.rows);
  assert.equal(rows.Type, 'Residential street');
  assert.equal(rows['Speed limit'], '50 km/h');
  assert.equal(rows.Surface, 'Asphalt');
  assert.equal(rows.Direction, 'One-way');
  assert.equal(rows['Road number'], 'Fv12');
  assert.match(rows['Mapped length'], /^\d+ m$/);
  assert.deepEqual(r.line[0], [10, north(4)]);
});

test('an unnamed road is still described, and nothing is returned far from any road', () => {
  const r = describeRoad({ elements: [way(null, north(3), { highway: 'track' })] }, 60, 10.001);
  assert.equal(r.title, 'Unnamed track');
  assert.equal(r.name, null);
  assert.equal(describeRoad({ elements: [way('X', north(80))] }, 60, 10.001), null);
  assert.equal(describeRoad(null, 60, 10.001), null);
});

test('a named street beats an unnamed path that is only slightly nearer', () => {
  const json = { elements: [way('Main St', north(6)), way(null, north(4), { highway: 'footway' })] };
  assert.equal(describeRoad(json, 60, 10.001).title, 'Main St');
  const far = { elements: [way('Main St', north(20)), way(null, north(3), { highway: 'footway' })] };
  assert.equal(describeRoad(far, 60, 10.001).title, 'Unnamed footway');
});

test('a tap spans more ground when zoomed out', () => {
  assert.equal(tapRadiusM(18, 60), 25);
  assert.ok(tapRadiusM(12, 60) > 100);
});

import { fetchRoads, OVERPASS_SERVERS } from '../public/road.js';

test('a busy server (502) is skipped: the next one answers, and is tried first next time', async () => {
  const asked = [];
  const impl = async (url) => {
    asked.push(new URL(url).origin);
    return asked.length === 1 ? new Response('bad', { status: 502 }) : new Response(JSON.stringify({ elements: [] }), { status: 200 });
  };
  const json = await fetchRoads(60, 10, 25, { fetchImpl: impl });
  assert.deepEqual(json, { elements: [] });
  assert.equal(asked.length, 2);
  assert.notEqual(asked[0], asked[1]);
  asked.length = 0;
  await fetchRoads(60, 10, 25, { fetchImpl: async (u) => { asked.push(new URL(u).origin); return new Response('{"elements":[]}'); } });
  assert.equal(asked[0], new URL(OVERPASS_SERVERS[1]).origin);
});

test('when every server fails, the problem is reported; odd answers count as failures', async () => {
  await assert.rejects(fetchRoads(60, 10, 25, { fetchImpl: async () => new Response('x', { status: 504 }) }), /504/);
  await assert.rejects(fetchRoads(60, 10, 25, { fetchImpl: async () => { throw new TypeError('offline'); } }), /offline/);
  await assert.rejects(fetchRoads(60, 10, 25, { fetchImpl: async () => new Response('{"remark":"busy"}') }), /unexpected/);
});

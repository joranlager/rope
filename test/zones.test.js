import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeZone, toWire, fromWire, zonesPayload, appliesTo, zonesFor, sameZones, standing, warnings, warningText,
  circleRing, zoneFeatures, visibilityOf, DEFAULT_VIS, parseKartverket, parseNominatim, findPlaces, kartverketUrl, WARN_M, MAX_ZONES,
} from '../public/zones.js';

const Z = (o = {}) => ({ id: 'a', kind: 'no', name: 'Airport', lat: 60, lon: 10, r: 500, ...o });
const east = (m, lat = 60, lon = 10) => ({ lat, lon: lon + m / (111320 * Math.cos((lat * Math.PI) / 180)) });

test('a zone is normalised; unusable ones are refused', () => {
  assert.deepEqual(normalizeZone({ ...Z(), lat: '60.1234567', r: '500.4', name: '  Hi\n there ' }), { id: 'a', kind: 'no', name: 'Hi  there', lat: 60.123457, lon: 10, r: 500 });
  for (const bad of [null, {}, Z({ kind: 'x' }), Z({ r: 5 }), Z({ r: 1e9 }), Z({ lat: 99 }), Z({ id: '' }), Z({ lon: NaN })]) assert.equal(normalizeZone(bad), null);
});

test('the wire form round-trips and is what gets signed', () => {
  const zs = [Z(), Z({ id: 'b', kind: 'green', name: 'Home', r: 300 })];
  assert.deepEqual(fromWire(toWire(zs)), zs);
  assert.deepEqual(zonesPayload(5, zs), { t: 'zones', ts: 5, zones: toWire(zs) });
  assert.equal(JSON.stringify(zonesPayload(5, zs)), JSON.stringify(zonesPayload(5, fromWire(toWire(zs)))));
});

test('a bad or oversized wire list is refused as a whole', () => {
  assert.equal(fromWire('x'), null);
  assert.equal(fromWire([['a', 'no', 'n', 60, 10]]), null);
  assert.equal(fromWire([['a', 'no', 'n', 60, 10, 1]]), null);
  assert.equal(fromWire(Array(MAX_ZONES + 1).fill(toWire([Z()])[0])), null);
  assert.deepEqual(fromWire([]), []);
});

test('zones go to the people they are assigned to, and only those I am admin over', () => {
  const all = { ...Z({ id: 'g' }), scope: 'all', who: [] };
  const some = { ...Z({ id: 's' }), scope: 'some', who: ['anna'] };
  const anna = { id: 'anna', youAdminThem: true }, bob = { id: 'bob', youAdminThem: true }, eve = { id: 'eve', youAdminThem: false };
  assert.deepEqual(zonesFor([all, some], anna).map((z) => z.id), ['g', 's']);
  assert.deepEqual(zonesFor([all, some], bob).map((z) => z.id), ['g']);
  assert.deepEqual(zonesFor([all, some], eve), [], 'no rights, no zones');
  assert.equal(appliesTo({ ...some, scope: 'some', who: [] }, anna), false);
  assert.equal(sameZones(zonesFor([all], anna), zonesFor([all], bob)), true);
  assert.equal(sameZones(zonesFor([all, some], anna), zonesFor([all], anna)), false);
});

test('a no fly zone: clear, then rising as you approach, then inside', () => {
  const z = Z();
  assert.equal(standing(z, east(500 + WARN_M + 50)).state, 'clear');
  assert.equal(standing(z, east(500 + WARN_M + 50)).strength, 0);
  const far = standing(z, east(500 + 140)), close = standing(z, east(500 + 20));
  assert.equal(far.state, 'near');
  assert.ok(close.strength > far.strength);
  assert.ok(close.strength < 1);
  const inside = standing(z, east(100));
  assert.equal(inside.state, 'inside');
  assert.equal(inside.strength, 1);
  assert.ok(Math.abs(inside.edge - 400) < 2);
});

test('a green field zone: calm inside, stronger near the edge, strongest outside', () => {
  const z = Z({ kind: 'green', r: 1000 });
  assert.equal(standing(z, east(100)).state, 'in');
  assert.equal(standing(z, east(100)).strength, 0);
  assert.equal(standing(z, east(920)).state, 'edge');
  assert.equal(standing(z, east(1200)).state, 'outside');
  assert.ok(standing(z, east(1200)).strength > standing(z, east(920)).strength);
});

test('warnings: danger inside a no fly zone, warn when near, nothing when clear', () => {
  const zs = [Z()];
  assert.deepEqual(warnings(zs, east(2000)), []);
  const near = warnings(zs, east(560));
  assert.equal(near.length, 1);
  assert.equal(near[0].level, 'warn');
  const inside = warnings(zs, east(100));
  assert.equal(inside[0].level, 'danger');
});

test('green warnings only exist when there is a green zone: outside all of them, or at the edge of the one I am in', () => {
  assert.deepEqual(warnings([], east(5000)), []);
  const g1 = Z({ id: 'g1', kind: 'green', r: 1000 }), g2 = Z({ id: 'g2', kind: 'green', lat: 61, r: 500 });
  const out = warnings([g1, g2], east(3000));
  assert.equal(out.length, 1);
  assert.equal(out[0].state, 'outside');
  assert.equal(out[0].zone.id, 'g1', 'names the nearest');
  assert.equal(warnings([g1], east(100)).length, 0);
  const edge = warnings([g1], east(950));
  assert.equal(edge[0].level, 'note');
  assert.equal(warnings([g1, g2], east(950)).length, 1);
});

test('the worst warning comes first', () => {
  const zs = [Z({ id: 'n', r: 300 }), Z({ id: 'g', kind: 'green', lat: 61, r: 100 })];
  const w = warnings(zs, east(100));
  assert.equal(w[0].level, 'danger');
  assert.equal(w[1].level, 'warn');
});

test('the sentences name the zone and the person', () => {
  const near = warnings([Z()], east(560))[0];
  assert.match(warningText(near), /^You are approaching the no fly zone “Airport”: \d+ m away$/);
  assert.match(warningText(near, 'Anna'), /^Anna is approaching/);
  const inside = warnings([Z({ name: '' })], east(100))[0];
  assert.match(warningText(inside), /inside the no fly zone no fly zone$/);
  const out = warnings([Z({ kind: 'green', r: 100 })], east(3000))[0];
  assert.match(warningText(out), /outside the green field zone “Airport”: 2\.\d km from it/);
});

test('a circle is a closed ring of the right size', () => {
  const ring = circleRing(60, 10, 1000, 72);
  assert.equal(ring.length, 73);
  assert.deepEqual(ring[0], ring[72]);
  const north = Math.max(...ring.map((p) => p[1]));
  assert.ok(Math.abs((north - 60) * 111320 - 1000) < 5);
  const fc = zoneFeatures([{ zone: Z(), strength: 0.5 }]);
  assert.equal(fc.features[0].properties.kind, 'no');
  assert.equal(fc.features[0].properties.s, 0.5);
});

test('addresses: Kartverket, then OpenStreetMap', () => {
  const kv = { adresser: [{ adressetekst: 'Karl Johans gate 1', postnummer: '0154', poststed: 'OSLO', representasjonspunkt: { lat: 59.9, lon: 10.7 } }, { adressetekst: 'x', representasjonspunkt: null }] };
  assert.deepEqual(parseKartverket(kv), [{ label: 'Karl Johans gate 1, 0154 OSLO', lat: 59.9, lon: 10.7 }]);
  assert.deepEqual(parseNominatim([{ display_name: '10 Downing Street, Westminster, London, UK, Extra', lat: '51.5', lon: '-0.12' }]), [{ label: '10 Downing Street, Westminster, London, UK', lat: 51.5, lon: -0.12 }]);
  assert.deepEqual(parseNominatim(null), []);
  assert.match(kartverketUrl('Storgata 1'), /sok=Storgata%201/);
});

test('findPlaces uses Kartverket first, falls back to OSM, and says when the search is down', async () => {
  const asked = [];
  const mk = (map) => async (url) => { asked.push(new URL(url).hostname); const hit = Object.entries(map).find(([k]) => url.includes(k)); return hit ? new Response(JSON.stringify(hit[1]), { status: 200 }) : new Response('x', { status: 500 }); };
  const kv = { adresser: [{ adressetekst: 'A 1', representasjonspunkt: { lat: 60, lon: 10 } }] };
  assert.equal((await findPlaces('A 1', { fetchImpl: mk({ 'ws.geonorge.no': kv }) }))[0].label, 'A 1');
  asked.length = 0;
  const osm = await findPlaces('London', { fetchImpl: mk({ 'ws.geonorge.no': { adresser: [] }, 'nominatim': [{ display_name: 'London', lat: '51.5', lon: '-0.1' }] }) });
  assert.equal(osm[0].label, 'London');
  assert.deepEqual(asked, ['ws.geonorge.no', 'nominatim.openstreetmap.org']);
  assert.deepEqual(await findPlaces('ab', { fetchImpl: mk({}) }), []);
  await assert.rejects(findPlaces('nowhere at all', { fetchImpl: mk({}) }), /500/);
});

test('visibility is per kind, clamped, and defaults to the middle', () => {
  assert.equal(DEFAULT_VIS, 0.5);
  assert.equal(visibilityOf(undefined, 'no'), 0.5);
  assert.equal(visibilityOf({ no: 0.2 }, 'no'), 0.2);
  assert.equal(visibilityOf({ no: 0.2 }, 'green'), 0.5);
  assert.equal(visibilityOf({ no: 5, green: -1 }, 'no'), 1);
  assert.equal(visibilityOf({ green: -1 }, 'green'), 0);
  assert.equal(visibilityOf({ no: 'x' }, 'no'), 0.5);
  const f = zoneFeatures([{ zone: Z(), strength: 0, visibility: 0.8 }, { zone: Z({ id: 'b' }), strength: 0 }]).features;
  assert.equal(f[0].properties.v, 0.8);
  assert.equal(f[1].properties.v, 0.5);
});

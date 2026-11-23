import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  positionUrl, segmentsUrl, speedUrl, parseWktPoint, parseWktLine, parsePositions, segmentAt, roadNumber, roadLabel,
  parseSpeed, describeSegment, lookupRoad, shouldLookup, tapRadiusM, MIN_GAP_MS, MIN_MOVE_M, CLIENT,
} from '../public/road.js';
import { haversineM } from '../public/geo.js';

const seg = (o = {}) => ({
  startposisjon: 0, sluttposisjon: 0.5, typeVeg: 'Enkel bilveg', typeVeg_sosi: 'enkelBilveg', lengde: 100,
  feltoversikt: ['1', '2'], adresse: { id: 7, navn: 'Grensefaret', adressekode: 1624 },
  vegsystemreferanse: { vegsystem: { vegkategori: 'K', nummer: 1624 }, kortform: 'KV1624 S1D1 m0-54' },
  geometri: { wkt: 'LINESTRING Z (59.8815 10.4924 64.6,59.8814 10.4925 64.6)' }, ...o,
});
const position = (id, pos, avstand, vs = {}) => ({ vegsystemreferanse: vs, veglenkesekvens: { veglenkesekvensid: id, relativPosisjon: pos }, geometri: { wkt: 'POINT Z (59.88 10.49 65.7)' }, avstand });

test('the addresses carry the rounded point, a search radius with slack, and degrees', () => {
  const u = positionUrl(60.1234567, 10.5);
  assert.match(u, /^https:\/\/nvdbapiles\.atlas\.vegvesen\.no\/vegnett\/api\/v4\/posisjon\?lat=60\.1235&lon=10\.5000&maks_avstand=35&/);
  assert.match(u, /srid=4326/);
  assert.match(segmentsUrl(405580), /segmentert\/405580\?srid=4326$/);
  assert.match(decodeURIComponent(speedUrl(405580, 0.15)), /vegobjekter\/105\?veglenkesekvens=0\.15@405580/);
});

test('WKT is read with latitude first and written for the map as [lon, lat]', () => {
  assert.deepEqual(parseWktPoint('POINT Z (59.88 10.49 65.7)'), { lat: 59.88, lon: 10.49, z: 65.7 });
  assert.deepEqual(parseWktPoint('POINT (59.88 10.49)'), { lat: 59.88, lon: 10.49, z: null });
  assert.equal(parseWktPoint('nonsense'), null);
  assert.deepEqual(parseWktLine('LINESTRING Z (59.88 10.49 1,59.89 10.5 2)'), [[10.49, 59.88], [10.5, 59.89]]);
  assert.deepEqual(parseWktLine('x'), []);
});

test('positions: nearest first, one per road, broken entries skipped', () => {
  const out = parsePositions([position(2, 0.3, 9), position(1, 0.1, 1), position(1, 0.2, 2), { veglenkesekvens: {} }, null]);
  assert.deepEqual(out.map((p) => [p.id, p.distance]), [[1, 1], [2, 9]]);
  assert.equal(out[0].height, 65.7);
  assert.deepEqual(parsePositions({}), []);
});

test('the segment holding a position, or the closest one', () => {
  const a = seg({ startposisjon: 0, sluttposisjon: 0.3 }), b = seg({ startposisjon: 0.3, sluttposisjon: 0.8 });
  assert.equal(segmentAt([a, b], 0.5), b);
  assert.equal(segmentAt([a, b], 0.1), a);
  assert.equal(segmentAt([a, b], 0.95), b);
  assert.equal(segmentAt([], 0.5), null);
  assert.equal(segmentAt(null, 0.5), null);
});

test('a road is named by its street, else by its number (E, Rv, Fv); municipal numbers are not a name', () => {
  assert.equal(roadLabel(seg()), 'Grensefaret');
  const e6 = seg({ adresse: undefined, vegsystemreferanse: { vegsystem: { vegkategori: 'E', nummer: 6 } } });
  assert.equal(roadLabel(e6), 'E6');
  assert.equal(roadNumber(seg({ vegsystemreferanse: { vegsystem: { vegkategori: 'R', nummer: 4 } } })), 'Rv 4');
  assert.equal(roadNumber(seg({ vegsystemreferanse: { vegsystem: { vegkategori: 'F', nummer: 12 } } })), 'Fv 12');
  assert.equal(roadLabel(seg({ adresse: undefined })), null); // KV1624 only
  assert.equal(roadLabel(seg({ adresse: { navn: '  ' }, vegsystemreferanse: {} })), null);
});

test('the speed limit is read from the road-object answer', () => {
  assert.equal(parseSpeed({ objekter: [{ egenskaper: [{ navn: 'Gyldig fra dato', verdi: 'x' }, { navn: 'Fartsgrense', verdi: 30 }] }] }), 30);
  assert.equal(parseSpeed({ objekter: [] }), null);
  assert.equal(parseSpeed(null), null);
});

test('describing a segment: facts, and the whole street drawn', () => {
  const a = seg(), b = seg({ lengde: 290, geometri: { wkt: 'LINESTRING (59.88 10.49,59.87 10.48)' } }), other = seg({ adresse: { id: 99, navn: 'Annet' } });
  const d = describeSegment(a, { distance: 3, height: 65.7, speed: 50, siblings: [a, b, other] });
  const rows = Object.fromEntries(d.rows);
  assert.equal(d.title, 'Grensefaret');
  assert.equal(rows.Type, 'Road');
  assert.equal(rows['Road reference'], 'KV1624 S1D1');
  assert.equal(rows['Speed limit'], '50 km/h');
  assert.equal(rows.Lanes, '2');
  assert.equal(rows.Height, '66 m');
  assert.equal(rows['Street length here'], '390 m');
  assert.equal(d.lines.length, 2);
  assert.deepEqual(d.lines[0][0], [10.4924, 59.8815]);
});

test('an unlabelled segment is titled by its type; a numbered road lists its number', () => {
  const u = describeSegment(seg({ adresse: undefined, typeVeg_sosi: 'gangveg', typeVeg: 'Gangveg', vegsystemreferanse: {} }));
  assert.equal(u.title, 'Unnamed footpath');
  assert.equal(u.label, null);
  const f = describeSegment(seg({ vegsystemreferanse: { vegsystem: { vegkategori: 'F', nummer: 12 }, kortform: 'FV12 S1D1 m5' } }));
  assert.equal(Object.fromEntries(f.rows)['Road number'], 'Fv 12');
});

/** A fake service: answers by address. */
function service(map) {
  const asked = [];
  const fetchImpl = async (url, opts) => {
    asked.push({ url, headers: opts.headers });
    for (const [needle, body] of Object.entries(map)) {
      if (url.includes(needle)) return typeof body === 'number' ? new Response('x', { status: body }) : new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('?', { status: 404 });
  };
  return { fetchImpl, asked };
}

test('a lookup asks for the position, then the road, and names it; the client header is sent', async () => {
  const sv = service({ '/posisjon': [position(405580, 0.2, 2)], '/segmentert/405580': [seg()], '/vegobjekter/105': { objekter: [{ egenskaper: [{ navn: 'Fartsgrense', verdi: 30 }] }] } });
  const r = await lookupRoad(60, 10, 25, { info: true, fetchImpl: sv.fetchImpl });
  assert.equal(r.title, 'Grensefaret');
  assert.equal(Object.fromEntries(r.rows)['Speed limit'], '30 km/h');
  assert.equal(sv.asked.length, 3);
  assert.ok(sv.asked.every((a) => a.headers['X-Client'] === CLIENT));
  const small = service({ '/posisjon': [position(405580, 0.2, 2)], '/segmentert/405580': [seg()] });
  await lookupRoad(60, 10, 25, { fetchImpl: small.fetchImpl });
  assert.equal(small.asked.length, 2, 'the pill does not ask for the speed limit');
});

test('no road near: null. With needLabel, roads without a name or number are skipped', async () => {
  assert.equal(await lookupRoad(60, 10, 25, { fetchImpl: service({ '/posisjon': [] }).fetchImpl }), null);
  const sv = service({
    '/posisjon': [position(1, 0.2, 1), position(2, 0.2, 5)],
    '/segmentert/1': [seg({ adresse: undefined, vegsystemreferanse: {} })],
    '/segmentert/2': [seg({ adresse: { id: 5, navn: 'Storgata' } })],
  });
  assert.equal((await lookupRoad(60, 10, 25, { needLabel: true, fetchImpl: sv.fetchImpl })).label, 'Storgata');
  assert.equal((await lookupRoad(60, 10, 25, { fetchImpl: sv.fetchImpl })).title, 'Unnamed road');
});

test('a server error is retried once, then reported; a 4xx is not retried', async () => {
  let n = 0;
  const flaky = async () => (++n === 1 ? new Response('x', { status: 502 }) : new Response('[]', { status: 200 }));
  assert.equal(await lookupRoad(60, 10, 25, { fetchImpl: flaky }), null);
  assert.equal(n, 2);
  let m = 0;
  await assert.rejects(lookupRoad(60, 10, 25, { fetchImpl: async () => { m++; return new Response('x', { status: 400 }); } }), /400/);
  assert.equal(m, 1);
  await assert.rejects(lookupRoad(60, 10, 25, { fetchImpl: async () => { throw new TypeError('offline'); } }), /offline/);
});

test('when to ask again', () => {
  const north = (m) => 60 + m / 111320;
  const p = (lat, id = 'me', acc = 10) => ({ lat, lon: 10, acc, id });
  const last = { lat: 60, lon: 10, at: 0, id: 'me' };
  assert.equal(shouldLookup(null, 0, p(60), haversineM), true);
  assert.equal(shouldLookup(last, MIN_GAP_MS - 1, p(north(500)), haversineM), false);
  assert.equal(shouldLookup(last, MIN_GAP_MS, p(north(MIN_MOVE_M - 5)), haversineM), false);
  assert.equal(shouldLookup(last, MIN_GAP_MS, p(north(MIN_MOVE_M + 5)), haversineM), true);
  assert.equal(shouldLookup(last, 1500, p(60, 'anna'), haversineM), true);
  assert.equal(shouldLookup(null, 0, p(60, 'me', 200), haversineM), false);
  assert.equal(shouldLookup(null, 0, null, haversineM), false);
});

test('a tap spans more ground when zoomed out', () => {
  assert.equal(tapRadiusM(18, 60), 25);
  assert.ok(tapRadiusM(12, 60) > 100);
});

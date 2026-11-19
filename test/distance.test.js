import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDistance, mapMidpoint, buildDistanceItems } from '../public/distance.js';

const sp = (s) => s.replace(/ | /g, ' '); // locale grouping uses a non-breaking space

test('under a kilometre the distance is whole metres', () => {
  assert.equal(formatDistance(0), '0 m');
  assert.equal(formatDistance(0.4), '0 m');
  assert.equal(formatDistance(7), '7 m');
  assert.equal(formatDistance(850.4), '850 m');
  assert.equal(formatDistance(999.4), '999 m');
});

test('rounding happens first, so there is never "1000 m"', () => {
  assert.equal(formatDistance(999.6), '1 km');
  assert.equal(formatDistance(1000), '1 km');
});

test('from a kilometre it is kilometres, with less precision as it grows', () => {
  assert.equal(sp(formatDistance(1250)), '1.25 km');
  assert.equal(sp(formatDistance(1500)), '1.5 km');
  assert.equal(sp(formatDistance(2000)), '2 km');
  assert.equal(sp(formatDistance(9994)), '9.99 km');
  assert.equal(sp(formatDistance(12_340)), '12.3 km');
  assert.equal(sp(formatDistance(99_960)), '100 km');
  assert.equal(sp(formatDistance(152_300)), '152 km');
  assert.equal(sp(formatDistance(1_520_000)), '1 520 km');
});

test('a negative or tiny number never breaks the label', () => {
  assert.equal(formatDistance(-5), '0 m');
});

test('the label sits halfway along the line', () => {
  const [lon, lat] = mapMidpoint([10, 59], [10, 61]);
  assert.ok(Math.abs(lon - 10) < 1e-9);
  assert.ok(lat > 59 && lat < 61);
  const [lon2, lat2] = mapMidpoint([10, 60], [12, 60]);
  assert.ok(Math.abs(lat2 - 60) < 1e-9);
  assert.ok(Math.abs(lon2 - 11) < 1e-9);
  const same = mapMidpoint([10.75, 59.91], [10.75, 59.91]);
  assert.ok(Math.abs(same[0] - 10.75) < 1e-9 && Math.abs(same[1] - 59.91) < 1e-9);
});

test('items are direct distances, nearest first, with a line and a label spot', () => {
  const me = { lat: 59.91, lon: 10.75 };
  const items = buildDistanceItems(me, [
    { id: 'far', lat: 60.0, lon: 10.75, color: '#ff0000' }, // ~10 km north
    { id: 'near', lat: 59.911, lon: 10.75, color: '#00ff00' }, // ~111 m north
  ]);
  assert.deepEqual(items.map((i) => i.id), ['near', 'far']);
  assert.equal(items[0].text, '111 m');
  assert.equal(sp(items[1].text), '10 km');
  assert.deepEqual(items[0].line, [[10.75, 59.91], [10.75, 59.911]]);
  assert.equal(items[0].color, '#00ff00');
  assert.ok(items[0].mid[1] > 59.91 && items[0].mid[1] < 59.911);
  assert.deepEqual(buildDistanceItems(me, []), []);
});

import { clipSegment, visibleMidpoint } from '../public/distance.js';

const rect = { left: 0, top: 0, right: 100, bottom: 100 };

test('a segment fully inside the screen is left as it is', () => {
  const seg = clipSegment({ x: 10, y: 10 }, { x: 90, y: 50 }, rect);
  assert.deepEqual(seg, { a: { x: 10, y: 10 }, b: { x: 90, y: 50 } });
  assert.deepEqual(visibleMidpoint({ x: 10, y: 10 }, { x: 90, y: 50 }, rect), { x: 50, y: 30 });
});

test('a long line is cut where it enters and leaves the screen', () => {
  // from inside to far outside, to the right
  const seg = clipSegment({ x: 50, y: 50 }, { x: 1050, y: 50 }, rect);
  assert.deepEqual(seg, { a: { x: 50, y: 50 }, b: { x: 100, y: 50 } });
  assert.deepEqual(visibleMidpoint({ x: 50, y: 50 }, { x: 1050, y: 50 }, rect), { x: 75, y: 50 });
  // straight through, both ends outside
  const through = clipSegment({ x: -100, y: 50 }, { x: 200, y: 50 }, rect);
  assert.deepEqual(through, { a: { x: 0, y: 50 }, b: { x: 100, y: 50 } });
});

test('a line that never touches the screen has no label position', () => {
  assert.equal(clipSegment({ x: 200, y: 200 }, { x: 300, y: 250 }, rect), null);
  assert.equal(clipSegment({ x: -50, y: 150 }, { x: 150, y: 150 }, rect), null); // passes below
  assert.equal(clipSegment({ x: 120, y: 0 }, { x: 120, y: 100 }, rect), null);   // parallel, outside
  assert.equal(visibleMidpoint({ x: 200, y: 200 }, { x: 300, y: 250 }, rect), null);
});

test('a label for a line that runs off the screen stays on the screen', () => {
  const m = visibleMidpoint({ x: 50, y: 50 }, { x: 5000, y: 3000 }, rect);
  assert.ok(m.x >= 0 && m.x <= 100 && m.y >= 0 && m.y <= 100, JSON.stringify(m));
});

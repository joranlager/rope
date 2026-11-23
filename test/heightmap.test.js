import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVICE, LAYER, COVERAGE, MIN_ZOOM, MAX_SIDE_PX, MARGIN, ZOOM_STEP, OPACITY,
  lonToX, latToY, xToLon, yToLat, mercatorBox, withMargin, requestSize, getMapUrl, corners,
  intersectsCoverage, covers, needsReload,
} from '../public/heightmap.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const view = { west: 8.0, south: 61.4, east: 8.6, north: 61.8 }; // Jotunheimen

test('it asks the service that was checked: hoyde-dtm, the coloured-height layer, Web Mercator', () => {
  assert.equal(SERVICE, 'https://wms.geonorge.no/skwms1/wms.hoyde-dtm');
  assert.equal(LAYER, 'DTM:dynamisk_farget_hoyde');
  assert.deepEqual(COVERAGE, { west: -20, south: 56.6, east: 50, north: 81.2 });
});

test('it is a see-through overlay, off the zoom levels where one image would be a continent', () => {
  assert.ok(OPACITY > 0.3 && OPACITY < 0.9);
  assert.ok(MIN_ZOOM >= 4);
});

test('Web Mercator conversions round-trip and match known values', () => {
  assert.ok(close(lonToX(180), 20037508.342789244, 1e-3));
  assert.ok(close(latToY(0), 0, 1e-6));
  assert.ok(close(latToY(60), 8399737.889818355, 1e-2));
  for (const [lon, lat] of [[10.75, 59.91], [-5, 70], [33, 62], [0, 0]]) {
    assert.ok(close(xToLon(lonToX(lon)), lon, 1e-9), `lon ${lon}`);
    assert.ok(close(yToLat(latToY(lat)), lat, 1e-9), `lat ${lat}`);
  }
});

test('the margin grows the box on every side, evenly as the map draws it', () => {
  const grown = withMargin(view, 0.3);
  assert.ok(grown.west < view.west && grown.east > view.east && grown.south < view.south && grown.north > view.north);
  const a = mercatorBox(view), b = mercatorBox(grown);
  const w = a.maxX - a.minX, h = a.maxY - a.minY;
  assert.ok(close((b.maxX - b.minX) / w, 1.6, 1e-9));
  assert.ok(close((b.maxY - b.minY) / h, 1.6, 1e-9));
  assert.ok(close(a.minX - b.minX, 0.3 * w, 1e-6) && close(b.maxY - a.maxY, 0.3 * h, 1e-6));
  assert.deepEqual(withMargin(view, 0), view);
});

test('the image is the screen plus margins, never more than the longest side allows', () => {
  assert.deepEqual(requestSize(390, 844, 0), { width: 390, height: 844 });
  const phone = requestSize(390, 844);                     // 1.6 x the screen = 624 x 1350 -> scaled down to 1024
  assert.equal(Math.max(phone.width, phone.height), MAX_SIDE_PX);
  assert.ok(close(phone.width / phone.height, 390 / 844, 0.01)); // same shape
  assert.deepEqual(requestSize(200, 100, 0.3), { width: 320, height: 160 }); // small: not scaled
  const wide = requestSize(1920, 1080);
  assert.equal(wide.width, MAX_SIDE_PX);
  assert.ok(wide.height >= 1 && wide.height < wide.width);
});

test('the GetMap URL carries exactly what the service expects', () => {
  const b = withMargin(view);
  const size = requestSize(800, 600);
  const u = new URL(getMapUrl(b, size));
  assert.equal(`${u.origin}${u.pathname}`, SERVICE);
  const p = u.searchParams;
  assert.equal(p.get('SERVICE'), 'WMS');
  assert.equal(p.get('VERSION'), '1.3.0');
  assert.equal(p.get('REQUEST'), 'GetMap');
  assert.equal(p.get('LAYERS'), 'DTM:dynamisk_farget_hoyde');
  assert.equal(p.get('CRS'), 'EPSG:3857');
  assert.equal(p.get('FORMAT'), 'image/png');
  assert.equal(p.get('TRANSPARENT'), 'TRUE');
  assert.equal(p.get('WIDTH'), String(size.width));
  assert.equal(p.get('HEIGHT'), String(size.height));
  // one layer only (the service refuses a list of two), and the box is x,y in metres
  assert.ok(!p.get('LAYERS').includes(','));
  const [x0, y0, x1, y1] = p.get('BBOX').split(',').map(Number);
  assert.ok(x0 < x1 && y0 < y1);
  const m = mercatorBox(b);
  assert.ok(close(x0, m.minX, 0.01) && close(y1, m.maxY, 0.01));
  assert.ok(x0 > 800000 && x0 < 1000000 && y0 > 8000000); // plausible for ~8 E, ~61 N
});

test('the image is placed by its four corners, clockwise from the top left', () => {
  assert.deepEqual(corners({ west: 1, south: 2, east: 3, north: 4 }), [[1, 4], [3, 4], [3, 2], [1, 2]]);
});

test('the service covers Norway and its surroundings, not the rest of the world', () => {
  assert.ok(intersectsCoverage(view));
  assert.ok(intersectsCoverage({ west: 10, south: 59, east: 11, north: 60 }));   // Oslo
  assert.ok(intersectsCoverage({ west: 15, south: 78, east: 16, north: 79 }));   // Svalbard
  assert.ok(!intersectsCoverage({ west: -100, south: 30, east: -90, north: 40 })); // North America
  assert.ok(!intersectsCoverage({ west: 100, south: 10, east: 110, north: 20 }));  // Asia
  assert.ok(!intersectsCoverage({ west: 5, south: 30, east: 6, north: 40 }));      // Mediterranean, south of the area
  assert.ok(intersectsCoverage({ west: -30, south: 60, east: -15, north: 62 }));   // overlapping the western edge
});

test('covers: an image has to contain the whole screen', () => {
  const img = withMargin(view);
  assert.ok(covers(img, view));
  assert.ok(covers(view, view));
  assert.ok(!covers(view, img));
  assert.ok(!covers(img, { ...view, east: img.east + 0.001 }));
});

test('a new image is needed only when it has to be', () => {
  const loaded = { bounds: withMargin(view), zoom: 11 };
  assert.equal(needsReload(null, view, 11), true);                         // nothing loaded yet
  assert.equal(needsReload(loaded, view, 11), false);                      // same screen
  const nudged = { west: view.west + 0.05, east: view.east + 0.05, south: view.south + 0.02, north: view.north + 0.02 };
  assert.equal(needsReload(loaded, nudged, 11), false);                    // a small pan stays inside the margin
  const far = { west: view.west + 1, east: view.east + 1, south: view.south, north: view.north };
  assert.equal(needsReload(loaded, far, 11), true);                        // panned out of the image
  assert.equal(needsReload(loaded, view, 11 + ZOOM_STEP - 0.01), false);   // a little zoom: keep it
  assert.equal(needsReload(loaded, view, 11 + ZOOM_STEP), true);           // zoomed in a good way
  assert.equal(needsReload(loaded, view, 11 - ZOOM_STEP), true);           // zoomed out a good way
  assert.ok(MARGIN > 0 && MARGIN < 1);
});

// The height map: Kartverket's terrain model (hoydedata.no) as a colour overlay on the map.
// Pure, so it is unit tested. The on-screen part is in app.js.
//
// Service (checked against its capabilities document): WMS 1.3.0 at
//   https://wms.geonorge.no/skwms1/wms.hoyde-dtm
// layer "DTM:dynamisk_farget_hoyde" (coloured height of the terrain model), EPSG:3857, PNG with
// transparency (outside Norway the image is fully transparent). The service answers with CORS
// headers, so the browser may load it directly.
//
// "Dynamic" means the colour scale is fitted to each request. Requested as map tiles, neighbouring
// tiles got different colours (about 12 levels apart on average along their shared edge), so it is
// requested as ONE image for the visible map area instead, and only again when that image no longer
// covers the screen or the zoom has changed noticeably.

export const SERVICE = 'https://wms.geonorge.no/skwms1/wms.hoyde-dtm';
export const LAYER = 'DTM:dynamisk_farget_hoyde';
export const COVERAGE = { west: -20, south: 56.6, east: 50, north: 81.2 }; // from the capabilities document
export const MIN_ZOOM = 5;      // zoomed out further than this, one image would cover a continent
export const MAX_SIDE_PX = 1024; // the longest side of the image, to keep the download small
export const MARGIN = 0.3;      // the image reaches this fraction of the screen beyond each edge
export const ZOOM_STEP = 0.75;  // ask again after zooming this far
export const OPACITY = 0.6;     // see-through, so roads and names still show
export const MIN_GAP_MS = 1500; // never ask more often than this

const R = 6378137; // Web Mercator radius
const MAX_LAT = 85.0511287798;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const lonToX = (lon) => (lon * Math.PI * R) / 180;
export const latToY = (lat) => Math.log(Math.tan(Math.PI / 4 + (clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI) / 360)) * R;
export const xToLon = (x) => (x / R) * (180 / Math.PI);
export const yToLat = (y) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);

/** Bounds are { west, south, east, north } in degrees. This is the same box in Web Mercator metres. */
export const mercatorBox = (b) => ({ minX: lonToX(b.west), minY: latToY(b.south), maxX: lonToX(b.east), maxY: latToY(b.north) });

/** The bounds grown by `fraction` of the width/height on every side (measured as the map draws them). */
export function withMargin(b, fraction = MARGIN) {
  const m = mercatorBox(b);
  const dx = (m.maxX - m.minX) * fraction;
  const dy = (m.maxY - m.minY) * fraction;
  return {
    west: xToLon(m.minX - dx),
    east: xToLon(m.maxX + dx),
    south: yToLat(m.minY - dy),
    north: yToLat(m.maxY + dy),
  };
}

/** Pixel size of the image to ask for: the screen plus the margins, longest side at most `maxSide`. */
export function requestSize(viewWidth, viewHeight, fraction = MARGIN, maxSide = MAX_SIDE_PX) {
  const w = viewWidth * (1 + 2 * fraction);
  const h = viewHeight * (1 + 2 * fraction);
  const scale = Math.min(1, maxSide / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** The GetMap request for these bounds (degrees) and size. For WMS 1.3.0 with EPSG:3857 the box is x,y order. */
export function getMapUrl(b, { width, height }) {
  const m = mercatorBox(b);
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetMap',
    LAYERS: LAYER,
    STYLES: '',
    CRS: 'EPSG:3857',
    BBOX: [m.minX, m.minY, m.maxX, m.maxY].map((v) => v.toFixed(2)).join(','),
    WIDTH: String(width),
    HEIGHT: String(height),
    FORMAT: 'image/png',
    TRANSPARENT: 'TRUE',
  });
  return `${SERVICE}?${params}`;
}

/** The four corners the map needs to place the image: top-left, top-right, bottom-right, bottom-left. */
export const corners = (b) => [[b.west, b.north], [b.east, b.north], [b.east, b.south], [b.west, b.south]];

/** Whether any part of the bounds is inside the area the service covers. */
export function intersectsCoverage(b, coverage = COVERAGE) {
  return b.west < coverage.east && b.east > coverage.west && b.south < coverage.north && b.north > coverage.south;
}

/** Whether `outer` completely contains `inner`. */
export const covers = (outer, inner) =>
  outer.west <= inner.west && outer.east >= inner.east && outer.south <= inner.south && outer.north >= inner.north;

/**
 * Is a new image needed? loaded = { bounds, zoom } of the image on the map, or null. Yes if there is
 * none, the screen is no longer inside it, or the zoom has moved a good way (the colours are fitted
 * to what was asked for, and the detail to the zoom).
 */
export function needsReload(loaded, view, zoom) {
  if (!loaded) return true;
  if (!covers(loaded.bounds, view)) return true;
  return Math.abs(zoom - loaded.zoom) >= ZOOM_STEP;
}

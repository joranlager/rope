// Pure geo helpers, shared by the browser and the tests.

const EARTH_RADIUS_M = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in metres between two WGS84 points. */
export function haversineM(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Always metres, e.g. "12 345 m". Uses a space as thousands separator (nb-NO). */
export function formatMetres(m) {
  return `${Math.round(m).toLocaleString('nb-NO')} m`;
}

/** Total ascent and descent over a sequence of heights. Missing (null) values are skipped. */
export function elevationGainLoss(heights) {
  let up = 0;
  let down = 0;
  let prev = null;
  for (const h of heights) {
    if (h == null) continue;
    if (prev != null) {
      const d = h - prev;
      if (d > 0) up += d;
      else down -= d;
    }
    prev = h;
  }
  return { up: Math.round(up), down: Math.round(down) };
}

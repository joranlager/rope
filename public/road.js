// The road a position is on, from NVDB (Nasjonal vegdatabank, Statens vegvesen): the official road
// database of Norway. Pure parsing plus a small lookup, so it is unit tested.
//
// Service: https://nvdbapiles.atlas.vegvesen.no (NVDB API Les v4), open, CORS open, no key, but every
// request must carry an X-Client header naming the application. Checked with real requests:
//   1. GET /vegnett/api/v4/posisjon?lat&lon&maks_avstand&maks_antall&srid=4326
//        the road-network points nearest a position, nearest first, each with its road-link sequence
//        and the position along it (relativPosisjon 0..1)
//   2. GET /vegnett/api/v4/veglenkesekvenser/segmentert/{id}?srid=4326
//        that sequence cut into segments, each with its street name (adresse.navn), road system
//        reference (E6, Fv12, KV1624 ...), type of road, lanes, length and shape
//   3. GET /vegobjekter/api/v4/vegobjekter/105?veglenkesekvens={pos}@{id}&inkluder=egenskaper
//        the speed limit (road object type 105) at that position
// Coordinates come back as WKT in EPSG:4326 with latitude FIRST. Only Norway is covered.

export const NVDB = 'https://nvdbapiles.atlas.vegvesen.no';
export const CLIENT = 'rope-web-app';
export const RADIUS_M = 25;       // a GPS fix is good to about this much on a road
export const MIN_MOVE_M = 25;     // ask again only after moving this far
export const MIN_GAP_MS = 6000;   // ... and not more often than this
export const MAX_ACCURACY_M = 60; // a rougher fix could name the wrong road
export const ROUND_SLACK_M = 10;  // the position is rounded to ~11 m so nearby questions share one saved answer

// ---------- addresses ----------

const q4 = (v) => v.toFixed(4);
export const positionUrl = (lat, lon, radius = RADIUS_M) =>
  `${NVDB}/vegnett/api/v4/posisjon?lat=${q4(lat)}&lon=${q4(lon)}&maks_avstand=${Math.round(radius) + ROUND_SLACK_M}&maks_antall=4&srid=4326`;
export const segmentsUrl = (id) => `${NVDB}/vegnett/api/v4/veglenkesekvenser/segmentert/${encodeURIComponent(id)}?srid=4326`;
export const speedUrl = (id, pos) =>
  `${NVDB}/vegobjekter/api/v4/vegobjekter/105?veglenkesekvens=${encodeURIComponent(`${pos}@${id}`)}&inkluder=egenskaper&antall=5`;

// ---------- WKT ----------

const nums = (s) => s.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
/** 'POINT Z (59.88 10.49 65.7)' -> { lat, lon, z }. Latitude is written first. Null if it is not one. */
export function parseWktPoint(wkt) {
  const m = /^\s*POINT\s*(?:Z\s*)?\(([^)]*)\)/i.exec(String(wkt));
  const [a, b, z] = m ? nums(m[1]) : [];
  if (a == null || b == null) return null;
  // Norway: latitude 57..72 is always larger than longitude 4..32, so the larger one is the latitude
  return a >= b ? { lat: a, lon: b, z: z ?? null } : { lat: b, lon: a, z: z ?? null };
}
/** 'LINESTRING Z (lat lon z, ...)' -> [[lon, lat], ...] ready for the map. */
export function parseWktLine(wkt) {
  const m = /^\s*LINESTRING\s*(?:Z\s*)?\(([^)]*)\)/i.exec(String(wkt));
  if (!m) return [];
  return m[1].split(',').map((p) => nums(p)).filter((n) => n.length >= 2).map(([a, b]) => (a >= b ? [b, a] : [a, b]));
}

// ---------- reading the answers ----------

/** The nearest road-network points: [{ id, pos, distance, height }], nearest first, one per road-link sequence. */
export function parsePositions(json) {
  if (!Array.isArray(json)) return [];
  const seen = new Set();
  const out = [];
  for (const p of json) {
    const id = p?.veglenkesekvens?.veglenkesekvensid;
    const pos = p?.veglenkesekvens?.relativPosisjon;
    if (id == null || pos == null || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, pos, distance: Number(p.avstand) || 0, height: parseWktPoint(p.geometri?.wkt)?.z ?? null });
  }
  return out.sort((a, b) => a.distance - b.distance);
}

/** The segment of a sequence that holds position pos (0..1), or the closest one. */
export function segmentAt(segments, pos) {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  let best = null;
  let bestGap = Infinity;
  for (const s of segments) {
    const gap = pos < s.startposisjon ? s.startposisjon - pos : pos > s.sluttposisjon ? pos - s.sluttposisjon : 0;
    if (gap < bestGap) { best = s; bestGap = gap; }
  }
  return best;
}

const CATEGORY = { E: 'E', R: 'Rv ', F: 'Fv ' }; // European, national and county roads carry a number; municipal and private roads' numbers mean little to a driver
/** 'E6', 'Rv 4', 'Fv 12', or null (municipal roads, and anything with no road system). */
export function roadNumber(segment) {
  const v = segment?.vegsystemreferanse?.vegsystem;
  return v && CATEGORY[v.vegkategori] && v.nummer != null ? `${CATEGORY[v.vegkategori]}${v.nummer}` : null;
}
/** The street name if it has one, otherwise the road number, otherwise null. */
export function roadLabel(segment) {
  const name = String(segment?.adresse?.navn ?? '').trim();
  return name || roadNumber(segment);
}

const TYPES = {
  enkelBilveg: 'Road', kanalisertVeg: 'Road with islands', rampe: 'Ramp', rundkjøring: 'Roundabout', gangOgSykkelveg: 'Foot and cycle path',
  sykkelveg: 'Cycle path', gangveg: 'Footpath', gågate: 'Pedestrian street', fortau: 'Pavement', trapp: 'Steps', gangfelt: 'Pedestrian crossing',
  bilferje: 'Car ferry', passasjerferje: 'Passenger ferry', traktorveg: 'Tractor road', sti: 'Trail', 'gatetun': 'Shared street',
};
const metres = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

/** The fartsgrense (km/h) from a road-object answer, or null. */
export function parseSpeed(json) {
  for (const o of json?.objekter ?? []) {
    const e = (o.egenskaper ?? []).find((x) => x.navn === 'Fartsgrense');
    if (e && Number.isFinite(Number(e.verdi))) return Number(e.verdi);
  }
  return null;
}

/**
 * Everything worth showing about one segment, as { label, title, rows, lines, distance }.
 * `siblings` are the other segments of the same sequence; those with the same street are drawn too.
 */
export function describeSegment(segment, { distance = 0, height = null, speed = null, siblings = [] } = {}) {
  const label = roadLabel(segment);
  const num = roadNumber(segment);
  const type = TYPES[segment.typeVeg_sosi] ?? segment.typeVeg ?? 'Road';
  const rows = [['Type', type]];
  if (num && label !== num) rows.push(['Road number', num]);
  if (segment.vegsystemreferanse?.kortform) rows.push(['Road reference', segment.vegsystemreferanse.kortform.replace(/\s+m\d.*$/, '')]);
  if (speed != null) rows.push(['Speed limit', `${speed} km/h`]);
  const lanes = (segment.feltoversikt ?? []).filter((f) => /^\d+$/.test(String(f))).length;
  if (lanes > 0 && /Bilveg|Veg|rampe|rundk/i.test(`${segment.typeVeg_sosi ?? ''} ${segment.typeVeg ?? ''}`)) rows.push(['Lanes', String(lanes)]);
  if (height != null) rows.push(['Height', `${Math.round(height)} m`]);
  const sameStreet = [segment, ...siblings.filter((s) => s !== segment && segment.adresse?.id != null && s.adresse?.id === segment.adresse.id)];
  const length = sameStreet.reduce((n, s) => n + (Number(s.lengde) || 0), 0);
  if (length > 0) rows.push([sameStreet.length > 1 ? 'Street length here' : 'Segment length', metres(length)]);
  const line = sameStreet.map((s) => parseWktLine(s.geometri?.wkt)).filter((l) => l.length > 1);
  return {
    label,
    title: label ?? `Unnamed ${type.toLowerCase()}`,
    rows,
    lines: line, // one [lon, lat] list per segment, drawn as a MultiLineString
    distance,
  };
}

// ---------- looking it up ----------

async function getJson(url, fetchImpl, timeoutMs) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 600));
    try {
      const res = await fetchImpl(url, { headers: { 'X-Client': CLIENT, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return await res.json();
      last = new Error(`the road service answered ${res.status}`);
      if (res.status < 500) break; // asking again will not help
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

/**
 * The road at a position, or null when there is none close enough.
 *   info: also fetch the speed limit (for the full card)
 *   needLabel: skip roads with neither a street name nor a number (for the name pill)
 * Throws when the service cannot be reached.
 */
export async function lookupRoad(lat, lon, radius = RADIUS_M, { info = false, needLabel = false, fetchImpl = (...a) => fetch(...a), timeoutMs = 9000 } = {}) {
  const positions = parsePositions(await getJson(positionUrl(lat, lon, radius), fetchImpl, timeoutMs));
  for (const p of positions.slice(0, needLabel ? 3 : 1)) {
    const segments = await getJson(segmentsUrl(p.id), fetchImpl, timeoutMs);
    const segment = segmentAt(segments, p.pos);
    if (!segment) continue;
    if (needLabel && !roadLabel(segment)) continue;
    let speed = null;
    if (info) {
      try { speed = parseSpeed(await getJson(speedUrl(p.id, p.pos), fetchImpl, timeoutMs)); } catch { /* the card simply has no speed limit */ }
    }
    return describeSegment(segment, { distance: p.distance, height: p.height, speed, siblings: segments });
  }
  return null;
}

// ---------- from what is already saved ----------

/** Metres from a point to a segment, on a flat map around the point (fine at these distances). */
export function distToSegmentM(lat, lon, a, b) {
  const k = Math.cos((lat * Math.PI) / 180);
  const m = 111320;
  const ax = (a[0] - lon) * k * m, ay = (a[1] - lat) * m;
  const bx = (b[0] - lon) * k * m, by = (b[1] - lat) * m;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (-ax * dx - ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/**
 * The road nearest a point among sequences already saved on the device: [{ id, segments }], each as the
 * service sent it. It works with no network, and for any point on a road that was looked up before, not
 * only the exact spot. Returns the same shape as lookupRoad, or null. (Height and speed limit are not
 * kept with the road, so those rows are missing.)
 */
export function nearestSaved(sequences, lat, lon, radius = RADIUS_M, { needLabel = false } = {}) {
  let best = null;
  for (const seq of sequences) {
    for (const segment of seq.segments ?? []) {
      if (needLabel && !roadLabel(segment)) continue;
      const line = parseWktLine(segment.geometri?.wkt);
      let d = Infinity;
      for (let i = 0; i + 1 < line.length; i++) d = Math.min(d, distToSegmentM(lat, lon, line[i], line[i + 1]));
      if (d <= radius && (!best || d < best.d)) best = { d, segment, siblings: seq.segments };
    }
  }
  return best ? describeSegment(best.segment, { distance: best.d, siblings: best.siblings }) : null;
}

// ---------- when to ask ----------

/** Is it time to ask again? last = { lat, lon, at, id } of the previous question, or null. */
export function shouldLookup(last, now, p, haversine) {
  if (!p || (p.acc != null && p.acc > MAX_ACCURACY_M)) return false;
  if (!last) return true;
  if (last.id !== p.id) return now - last.at >= 1000; // a different person: do not wait long
  if (now - last.at < MIN_GAP_MS) return false;
  return haversine(last.lat, last.lon, p.lat, p.lon) >= MIN_MOVE_M;
}

/** How many metres a tap of `px` pixels spans at this zoom and latitude (MapLibre's 512 px world). */
export const tapRadiusM = (zoom, lat, px = 16) => Math.max(RADIUS_M, px * ((78271.517 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom));

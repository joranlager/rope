// Zones: "no fly" areas (to keep out of) and "green field" areas (to stay in). Pure, so it is unit tested.
//
// A zone is a circle: { id, kind: 'no' | 'green', name, lat, lon, r }, r in metres. An admin defines
// zones for the people they hold admin rights over: for everyone ("all"), or for chosen people.
//   mine:   { ...zone, scope: 'all' | 'some', who: [contactId, ...] }   (kept by the admin)
//   sent:   the zones that apply to one person, signed by the admin and sent to that person's phone,
//           where they are kept as long as that admin holds the rights (the person cannot change them)

export const WARN_M = 150;       // a zone starts to react this far outside its edge
export const MIN_R = 20;
export const MAX_R = 50_000;
export const MAX_ZONES = 40;     // per message: keeps it small enough for the relay
export const KINDS = { no: 'No fly zone', green: 'Green field zone' };

const R_EARTH = 6371000;
const rad = (d) => (d * Math.PI) / 180;
function metresBetween(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const validCoord = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/** A zone in its one canonical form, or null if it is not a usable zone. */
export function normalizeZone(z) {
  if (!z || typeof z !== 'object') return null;
  const lat = Number(z.lat), lon = Number(z.lon), r = Math.round(Number(z.r));
  if (!validCoord(lat, lon) || !Number.isFinite(r) || r < MIN_R || r > MAX_R) return null;
  if (z.kind !== 'no' && z.kind !== 'green') return null;
  const id = clean(z.id, 40);
  if (!id) return null;
  return { id, kind: z.kind, name: clean(z.name, 60), lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, r };
}

/** The signed form on the wire: plain arrays, so the bytes that were signed are the bytes that are checked. */
export const toWire = (zones) => zones.map((z) => [z.id, z.kind, z.name, z.lat, z.lon, z.r]);
export function fromWire(wire) {
  if (!Array.isArray(wire) || wire.length > MAX_ZONES) return null;
  const out = [];
  for (const w of wire) {
    if (!Array.isArray(w) || w.length !== 6) return null;
    const z = normalizeZone({ id: w[0], kind: w[1], name: w[2], lat: w[3], lon: w[4], r: w[5] });
    if (!z) return null;
    out.push(z);
  }
  return out;
}
/** What the admin signs for a set of zones at time ts. */
export const zonesPayload = (ts, zones) => ({ t: 'zones', ts, zones: toWire(zones) });

/** A new id that is not in use. */
export const newZoneId = (taken = []) => {
  let id;
  do id = `z${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`; while (taken.includes(id));
  return id;
};

/** Does a zone I defined apply to this person? */
export const appliesTo = (zone, contact) =>
  Boolean(contact?.youAdminThem) && (zone.scope === 'all' || (Array.isArray(zone.who) && zone.who.includes(contact.id)));

/** The zones (plain form) that go to one person. */
export function zonesFor(mine, contact) {
  return mine.filter((z) => appliesTo(z, contact)).map(normalizeZone).filter(Boolean);
}

export const sameZones = (a, b) => JSON.stringify(toWire(a ?? [])) === JSON.stringify(toWire(b ?? []));

// ---------- where a position stands ----------

/**
 * For one position and one zone: how far the position is from the zone's edge, as `edge` in metres
 * (negative = outside the circle, for a no fly zone that is the good side), and the state:
 *   no fly:  'inside' (in it), 'near' (within WARN_M of it), 'clear'
 *   green:   'outside' (not in it), 'edge' (in it, within WARN_M of leaving), 'in'
 * `strength` (0..1) is how strongly the zone should show: a no fly zone grows from 0 to 1 as you come
 * from WARN_M away to its edge; a green zone shows more when you are near its edge or outside it.
 */
export function standing(zone, pos, warn = WARN_M) {
  const d = metresBetween(pos.lat, pos.lon, zone.lat, zone.lon);
  const inside = zone.r - d; // metres inside the edge; negative = outside it
  if (zone.kind === 'no') {
    if (inside >= 0) return { zone, d, edge: inside, state: 'inside', strength: 1 };
    const away = -inside;
    return away <= warn
      ? { zone, d, edge: inside, state: 'near', strength: Math.max(0.15, 1 - away / warn) }
      : { zone, d, edge: inside, state: 'clear', strength: 0 };
  }
  if (inside < 0) return { zone, d, edge: inside, state: 'outside', strength: Math.min(1, 0.5 + -inside / (warn * 4)) };
  return inside <= warn
    ? { zone, d, edge: inside, state: 'edge', strength: Math.max(0.15, 1 - inside / warn) }
    : { zone, d, edge: inside, state: 'in', strength: 0 };
}

/**
 * The warnings for one position against a set of zones, worst first. Green zones only warn when there
 * is at least one: being outside every green zone is one warning (naming the nearest), and leaving
 * the edge of the one you are in is another.
 *   level: 'danger' (inside a no fly zone), 'warn' (near one, or outside all green zones), 'note' (near a green edge)
 */
export function warnings(zones, pos, warn = WARN_M) {
  const out = [];
  const stands = zones.map((z) => standing(z, pos, warn));
  for (const s of stands.filter((x) => x.zone.kind === 'no' && x.state !== 'clear')) {
    out.push({ level: s.state === 'inside' ? 'danger' : 'warn', zone: s.zone, state: s.state, metres: Math.round(Math.abs(s.edge)) });
  }
  const greens = stands.filter((x) => x.zone.kind === 'green');
  if (greens.length) {
    const inGreen = greens.filter((g) => g.state !== 'outside');
    if (inGreen.length === 0) {
      const nearest = greens.reduce((a, b) => (a.edge > b.edge ? a : b)); // the least far outside
      out.push({ level: 'warn', zone: nearest.zone, state: 'outside', metres: Math.round(-nearest.edge) });
    } else if (inGreen.every((g) => g.state === 'edge')) {
      const best = inGreen.reduce((a, b) => (a.edge > b.edge ? a : b));
      out.push({ level: 'note', zone: best.zone, state: 'edge', metres: Math.round(best.edge) });
    }
  }
  const rank = { danger: 0, warn: 1, note: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || a.metres - b.metres);
}

const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${m} m`);

/** The sentence for a warning; `who` names the person when it is someone else's. */
export function warningText(w, who = null) {
  const zone = w.zone.name ? `“${w.zone.name}”` : KINDS[w.zone.kind].toLowerCase();
  const subj = who ? `${who} is` : 'You are';
  if (w.zone.kind === 'no') {
    return w.state === 'inside'
      ? `${subj} inside the no fly zone ${zone}`
      : `${subj} approaching the no fly zone ${zone}: ${km(w.metres)} away`;
  }
  return w.state === 'outside'
    ? `${subj} outside the green field zone ${zone}: ${km(w.metres)} from it`
    : `${subj} near the edge of the green field zone ${zone}: ${km(w.metres)} left`;
}

// ---------- drawing ----------

/** A circle as a closed ring of [lon, lat] points. */
export function circleRing(lat, lon, r, steps = 72) {
  const ring = [];
  const dLat = (r / R_EARTH) * (180 / Math.PI);
  const dLon = dLat / Math.max(0.01, Math.cos(rad(lat)));
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([Math.round((lon + dLon * Math.cos(a)) * 1e6) / 1e6, Math.round((lat + dLat * Math.sin(a)) * 1e6) / 1e6]);
  }
  ring.push(ring[0]);
  return ring;
}

/** GeoJSON for the map: each zone a polygon with its kind and strength (0..1). */
export function zoneFeatures(items) {
  return {
    type: 'FeatureCollection',
    features: items.map(({ zone, strength = 0 }) => ({
      type: 'Feature',
      properties: { id: zone.id, kind: zone.kind, s: Math.round(strength * 100) / 100 },
      geometry: { type: 'Polygon', coordinates: [circleRing(zone.lat, zone.lon, zone.r)] },
    })),
  };
}

// ---------- addresses ----------

export const kartverketUrl = (text) => `https://ws.geonorge.no/adresser/v1/sok?sok=${encodeURIComponent(text)}&treffPerSide=6&asciiKompatibel=true&fuzzy=true`;
export const nominatimUrl = (text) => `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(text)}&format=jsonv2&limit=6`;

/** Places from Kartverket's address search: [{ label, lat, lon }]. */
export function parseKartverket(json) {
  const out = [];
  for (const a of json?.adresser ?? []) {
    const p = a.representasjonspunkt;
    if (!p || !validCoord(Number(p.lat), Number(p.lon))) continue;
    out.push({ label: [a.adressetekst, [a.postnummer, a.poststed].filter(Boolean).join(' ')].filter(Boolean).join(', '), lat: Number(p.lat), lon: Number(p.lon) });
  }
  return out;
}
/** Places from OpenStreetMap's search (outside Norway): [{ label, lat, lon }]. */
export function parseNominatim(json) {
  if (!Array.isArray(json)) return [];
  return json
    .map((p) => ({ label: String(p.display_name ?? '').split(',').slice(0, 4).join(',').trim(), lat: Number(p.lat), lon: Number(p.lon) }))
    .filter((p) => p.label && validCoord(p.lat, p.lon));
}

/** Finds places for an address: Norwegian addresses first (exact), then the rest of the world. */
export async function findPlaces(text, { fetchImpl = (...a) => fetch(...a), timeoutMs = 8000 } = {}) {
  const query = clean(text, 120);
  if (query.length < 3) return [];
  const get = async (url) => {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`the address search answered ${res.status}`);
    return res.json();
  };
  let first = [];
  let failure = null;
  try { first = parseKartverket(await get(kartverketUrl(query))); } catch (err) { failure = err; }
  if (first.length) return first;
  try { return parseNominatim(await get(nominatimUrl(query))); } catch (err) { if (failure) throw err; return []; }
}

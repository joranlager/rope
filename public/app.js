import { haversineM, formatMetres, elevationGainLoss } from './geo.js';
import {
  newIdentity, loadKeys, cardOf, encodeCard, decodeCard, fingerprint, inboxTopic,
  deriveSecret, channelFromSecret, seal, open, signObj, verifyObj,
} from './crypto.js';
import { Relay, DEFAULT_RELAY } from './net.js';
import {
  initialFollow, followMe, followPerson, followAll, dragged, pressPersonArrow, contactRemoved,
  meArrowState, personArrowState, allState,
} from './follow.js';
import { personHex, contrastText } from './colors.js';
import { buildDistanceItems, visibleMidpoint } from './distance.js';
import {
  TRACE_OPTIONS, TRACE_COLORS, traceSettings, addPoint, trimToDistance, toFeature, labelForMeters,
  colorHex, hexToRgba,
} from './trace.js';
import {
  shouldSendPosition, theyCanSeeMe, seeingThem, canRemoveContact,
  applyPairMessage, adminPayload, isStale,
} from './social.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STORE_KEY = 'rope.v1';
const ELEVATION_URL = 'https://ws.geonorge.no/hoydedata/v1/punkt';
const ROUTING = { car: 'https://router.project-osrm.org/route/v1/driving' };
const SEND_EVERY_MS = 10_000; // public relays rate-limit; this keeps a few contacts well inside it

// ---------- local state ----------
// state = { identity, visible, relay, contacts: { [id]: contact } }
// contact = { id, name, e, s, status: 'pending'|'request'|'active', nick, secret,
//             theirVisible, youAdminThem, adminOverMe, adminTs, adminTouched, pos }
let state = null;
let keys = null;                 // imported private keys
let relay = null;
const channels = new Map();      // contact id -> { aes, topic }
let myPos = null;
let lastSent = 0;
let map = null, myMarker = null, destMarker = null, routeMode = false, destination = null;
const markers = new Map();
let terrainFor = null, terrainAt = 0;

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    return s?.identity ? s : null;
  } catch { return null; }
}
function saveState() {
  try {
    const copy = { ...state, contacts: Object.fromEntries(Object.entries(state.contacts).map(([id, c]) => [id, { ...c, pos: undefined }])) };
    localStorage.setItem(STORE_KEY, JSON.stringify(copy));
  } catch { /* storage unavailable; the session still works */ }
}
const setStatus = (t) => { $('#status').textContent = t; };
const me = () => ({ visible: state.visible });
const activeContacts = () => Object.values(state.contacts).filter((c) => c.status === 'active');

// ---------- map ----------

function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256, maxzoom: 19,
          attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        },
      },
      layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
    },
    center: [10.75, 59.91], zoom: 11,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
  // A small scale line that adapts as you zoom in and out.
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');

  // Put the first map error on screen with the build id, so a blank map can be diagnosed from a phone.
  let mapErrorShown = false;
  map.on('error', (e) => {
    if (mapErrorShown) return;
    mapErrorShown = true;
    const detail = String(e?.error?.message || e?.error || 'unknown error').slice(0, 120);
    $('#map-msg').textContent = `Map problem: ${detail} (build ${$('#build').textContent})`;
    $('#map-banner').hidden = false;
  });
  map.on('idle', () => { if (!mapErrorShown) $('#map-banner').hidden = true; });
  map.on('load', () => {
    mapReady = true;
    hideSplash(); // the map is ready: reveal the app (after the splash's minimum time)
    map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'route-line', type: 'line', source: 'route',
      paint: { 'line-color': '#2563eb', 'line-width': 5, 'line-opacity': 0.85 },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    });
    // Dashed lines from me to each person, for the measure-tape view. Empty unless it is switched on.
    map.addSource('distance-lines', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'distance-lines', type: 'line', source: 'distance-lines',
      layout: { 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': 0.85, 'line-dasharray': [2, 2] },
    }, 'route-line');
    renderTraces();
    renderDistances();
  });
  map.on('click', (e) => {
    if (routeMode) setDestination({ lat: e.lngLat.lat, lon: e.lngLat.lng });
  });

  // Dragging the map by hand stops following. The map's own animated moves don't fire dragstart.
  map.on('dragstart', () => setFollow(dragged(follow)));
  map.on('moveend', () => { programmaticMove = false; });
  map.on('move', placeDistanceLabels);
}

function makeEl(cls, text, color) {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  if (color) el.style.background = color;
  return el;
}
const initials = (n) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
const label = (c) => c.nick || c.name;

// ---------- trails ----------
// Each person (me included) can have a trail: the last stretch of path, drawn so the oldest
// part fades out. It is off by default, set per person, and kept on this device only. A trail
// starts recording when it is switched on and is dropped when it is switched off.

let mapReady = false;
const trails = new Map(); // 'me' or contact id -> [{ lat, lon, ts }]

const traceOf = (id) => traceSettings(id === 'me' ? state?.myTrace : state?.contacts[id]?.trace);
const appliedColor = new Map(); // id -> colour setting currently on the map layer

// One colour per person: the one they were given, or their automatic colour (blue for me).
// It is used for their marker, avatar, arrow and trail.
const colorOf = (id) => personHex(id, traceOf(id).color);
const traceColor = (id, a) => hexToRgba(colorOf(id), a);

// line-progress runs from the oldest end (0) to the newest (1): transparent to solid.
const traceGradient = (id) => ['interpolate', ['linear'], ['line-progress'],
  0, traceColor(id, 0), 0.6, traceColor(id, 0.45), 1, traceColor(id, 0.95)];

function removeTraceLayer(id) {
  const sid = `trace-${id}`;
  appliedColor.delete(id);
  if (!map || !mapReady) return;
  if (map.getLayer(sid)) map.removeLayer(sid);
  if (map.getSource(sid)) map.removeSource(sid);
}

/** Round colour swatches: Auto, then the palette. `current` is the selected colour id. */
function swatchesHtml(id, current) {
  const auto = `<button class="swatch auto${current === 'auto' ? ' selected' : ''}" data-act="color" data-id="${id}" data-color="auto" aria-label="Automatic colour" aria-pressed="${current === 'auto'}"></button>`;
  return auto + TRACE_COLORS.map((c) =>
    `<button class="swatch${current === c.id ? ' selected' : ''}" style="--c:${c.hex}" data-act="color" data-id="${id}" data-color="${c.id}" aria-label="${c.name}" aria-pressed="${current === c.id}"></button>`).join('');
}

function renderTrace(id) {
  if (!map || !mapReady) return;
  const trail = trails.get(id) ?? [];
  const c = id === 'me' ? null : state.contacts[id];
  // A trail is only shown while I may see that person and their position is fresh.
  const visible = id === 'me' || (c && c.status === 'active' && seeingThem(c) && c.pos && !isStale(c.pos));
  if (!traceOf(id).on || trail.length < 2 || !visible) return removeTraceLayer(id);

  const sid = `trace-${id}`;
  if (!map.getSource(sid)) {
    map.addSource(sid, { type: 'geojson', lineMetrics: true, data: toFeature(trail) });
    map.addLayer({
      id: sid, type: 'line', source: sid,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-width': 5, 'line-gradient': traceGradient(id) },
    }, map.getLayer('route-line') ? 'route-line' : undefined);
    appliedColor.set(id, traceOf(id).color);
  } else {
    map.getSource(sid).setData(toFeature(trail));
    if (appliedColor.get(id) !== traceOf(id).color) { // the colour was changed
      map.setPaintProperty(sid, 'line-gradient', traceGradient(id));
      appliedColor.set(id, traceOf(id).color);
    }
  }
}

function renderTraces() {
  if (!state) return;
  for (const id of ['me', ...Object.keys(state.contacts)]) renderTrace(id);
}

function recordTrail(id, pt) {
  const t = traceOf(id);
  if (!t.on) return;
  trails.set(id, addPoint(trails.get(id) ?? [], pt, t.meters));
  renderTrace(id);
}

function clearTrail(id) {
  trails.delete(id);
  removeTraceLayer(id);
}

/** Turn a trail on or off, or change its length, for me ('me') or a contact. */
function setTrace(id, patch) {
  const before = traceOf(id);
  const next = { ...before, ...patch };
  if (id === 'me') state.myTrace = next;
  else if (state.contacts[id]) state.contacts[id].trace = next;
  else return;
  if (!next.on) {
    clearTrail(id);
  } else if (!before.on) {
    // Start recording now, from where they are right now.
    trails.delete(id);
    const c = id === 'me' ? null : state.contacts[id];
    const here = id === 'me' ? myPos : (c && seeingThem(c) && c.pos && !isStale(c.pos) ? c.pos : null);
    if (here) recordTrail(id, { lat: here.lat, lon: here.lon, ts: here.ts ?? Date.now() });
  } else {
    trails.set(id, trimToDistance(trails.get(id) ?? [], next.meters));
  }
  saveState();
  renderAll();
}

// ---------- distances ----------
// The measure-tape button toggles a live view of the direct distance from me to each person
// on the map: a dashed line in their colour with the distance at its middle. Off by default,
// and the choice is remembered. A label is only shown for people who are visible on the map.

const distLabels = new Map(); // contact id -> Marker holding the label
let distanceItems = [];       // what is currently drawn, so labels can be re-placed as the map moves
const EMPTY_LINES = { type: 'FeatureCollection', features: [] };

function clearDistances() {
  for (const m of distLabels.values()) m.remove();
  distLabels.clear();
  distanceItems = [];
  if (mapReady) map.getSource('distance-lines')?.setData(EMPTY_LINES);
}

function renderDistances() {
  if (!map || !state) return;
  const on = state.showDistances === true;
  const btn = $('#measure');
  btn.setAttribute('aria-pressed', String(on));
  btn.title = on ? 'Hide distances to people' : 'Show distances to people';
  btn.setAttribute('aria-label', btn.title);
  if (!on || !myPos) return clearDistances();

  const people = [];
  for (const c of activeContacts()) {
    if (c.pos && !isStale(c.pos) && seeingThem(c)) people.push({ id: c.id, lat: c.pos.lat, lon: c.pos.lon, color: colorOf(c.id) });
  }
  const items = buildDistanceItems({ lat: myPos.lat, lon: myPos.lon }, people);

  if (mapReady) {
    map.getSource('distance-lines')?.setData({
      type: 'FeatureCollection',
      features: items.map((i) => ({ type: 'Feature', properties: { color: i.color }, geometry: { type: 'LineString', coordinates: i.line } })),
    });
  }
  const seen = new Set();
  for (const it of items) {
    seen.add(it.id);
    let marker = distLabels.get(it.id);
    if (!marker) {
      const el = document.createElement('div');
      el.className = 'dist-label';
      el.innerHTML = '<i></i><span></span>';
      marker = new maplibregl.Marker({ element: el }).setLngLat(it.mid).addTo(map);
      distLabels.set(it.id, marker);
    }
    const el = marker.getElement();
    el.firstChild.style.background = it.color;
    el.lastChild.textContent = it.text; // textContent: never markup
  }
  for (const [id, marker] of distLabels) if (!seen.has(id)) { marker.remove(); distLabels.delete(id); }
  distanceItems = items;
  placeDistanceLabels();
}

// A label sits in the middle of the part of its line that is on the screen, so it can be read
// even when the person is far away and the true midpoint is off the screen. If none of the line is
// on the screen there is nothing to label, and the label is hidden. Re-run on every map move.
function placeDistanceLabels() {
  if (!map || !distanceItems.length) return;
  const canvas = map.getCanvas();
  const area = { left: 16, right: canvas.clientWidth - 16, top: 72, bottom: canvas.clientHeight - 70 - sheetPadding() };
  for (const it of distanceItems) {
    const marker = distLabels.get(it.id);
    if (!marker) continue;
    const mid = visibleMidpoint(map.project(it.line[0]), map.project(it.line[1]), area);
    const el = marker.getElement();
    if (!mid) { el.style.display = 'none'; continue; }
    el.style.display = '';
    marker.setLngLat(map.unproject([mid.x, mid.y]));
  }
}

// ---------- following ----------
// The map opens following my own position. Three controls change that:
//   the bottom-left arrow (my colour) follows me,
//   the bottom-right arrow (the person's colour) follows the person chosen with "Show",
//   "All" in the top menu keeps everyone in view.
// Dragging the map stops following; each control then resumes its own target.

let follow = initialFollow();
let programmaticMove = false;
let lastFollowed = null; // what we last moved to, so repeated identical updates don't re-animate

/** Where the followed thing is right now, or null if we don't have a usable position for it. */
function followedPoint() {
  if (follow.target === 'me') return myPos ? { lat: myPos.lat, lon: myPos.lon } : null;
  const c = state?.contacts[follow.target];
  if (!c || c.status !== 'active' || !c.pos || isStale(c.pos) || !seeingThem(c)) return null;
  return { lat: c.pos.lat, lon: c.pos.lon };
}

// On a phone the open sheet covers the lower part of the map; keep the followed point in the part you can see.
function sheetPadding() {
  const panel = $('#panel');
  const phone = window.matchMedia('(max-width: 640px)').matches;
  return phone && !panel.hidden && panel.classList.contains('open') ? panel.offsetHeight : 0;
}

/** Everyone I can currently see on the map: me, and each contact with a fresh, permitted position. */
function everyonePoints() {
  const pts = [];
  if (myPos) pts.push([myPos.lon, myPos.lat]);
  for (const c of activeContacts()) {
    if (c.pos && !isStale(c.pos) && seeingThem(c)) pts.push([c.pos.lon, c.pos.lat]);
  }
  return pts;
}

/** Zoom and pan so that everyone is in view. */
function fitEveryone({ force = false } = {}) {
  const pts = everyonePoints();
  if (!pts.length || !map) return;
  const key = `all|${pts.map((p) => p.map((v) => v.toFixed(5)).join(',')).join(';')}`;
  if (!force && key === lastFollowed) return;
  if (!force && map.isMoving() && !programmaticMove) return; // don't fight the user's gesture
  lastFollowed = key;
  programmaticMove = true;
  const bottom = sheetPadding();
  if (pts.length === 1) {
    map.easeTo({ center: pts[0], zoom: Math.max(map.getZoom(), 15), padding: { top: 0, left: 0, right: 0, bottom }, duration: 600 });
    return;
  }
  const bounds = pts.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
  map.fitBounds(bounds, { padding: { top: 100, left: 60, right: 60, bottom: 90 + bottom }, maxZoom: 17, duration: 600 });
}

/**
 * fresh: starting to follow, so zoom in to a useful level.
 * force: re-centre even if nothing has changed (e.g. the sheet opened or closed).
 */
function moveToFollowed({ fresh = false, force = false } = {}) {
  if (follow.target === 'all') return fitEveryone({ force: fresh || force });
  const pt = followedPoint();
  if (!pt || !map) return;
  const key = `${follow.target}|${pt.lat},${pt.lon}`;
  if (!fresh && !force && key === lastFollowed) return;
  if (!fresh && !force && map.isMoving() && !programmaticMove) return; // don't fight the user's gesture
  lastFollowed = key;
  programmaticMove = true;
  map.easeTo({
    center: [pt.lon, pt.lat],
    zoom: fresh ? Math.max(map.getZoom(), 15) : map.getZoom(),
    padding: { top: 0, left: 0, right: 0, bottom: sheetPadding() },
    duration: fresh ? 800 : 500,
  });
}

// An arrow is a circle in the person's colour, with a glyph that stays visible on that colour
// (white or black). Filled arrow = following them; outlined = not following.
function paintArrow(btn, hex, state) {
  btn.style.setProperty('--arrow-bg', hex);
  btn.style.setProperty('--arrow-fg', contrastText(hex));
  btn.dataset.state = state;
  btn.setAttribute('aria-pressed', String(state === 'on'));
}

function renderFollowUi() {
  paintArrow($('#follow-me'), colorOf('me'), meArrowState(follow));
  if (myMarker) myMarker.getElement().style.setProperty('--me', colorOf('me'));

  const person = follow.person && state?.contacts[follow.person];
  const pbtn = $('#follow-person');
  const lab = $('#follow-label');
  const have = Boolean(person && person.status === 'active');
  pbtn.hidden = !have || $('#menu').hidden;
  if (have) {
    paintArrow(pbtn, colorOf(person.id), personArrowState(follow));
    pbtn.setAttribute('aria-label', `Follow ${label(person)}`);
    pbtn.title = `Follow ${label(person)}`;
  }
  const followingPerson = have && follow.target === person.id;
  lab.hidden = !followingPerson;
  if (followingPerson) lab.textContent = followedPoint() ? `Following ${label(person)}` : `Waiting for ${label(person)}…`;

  $('#menu-all').setAttribute('aria-pressed', String(allState(follow) === 'on'));
}

function setFollow(next, { recentre = false } = {}) {
  follow = next;
  lastFollowed = null;
  renderFollowUi();
  if (recentre) moveToFollowed({ fresh: true });
}

function renderMarkers() {
  const seen = new Set();
  for (const c of activeContacts()) {
    if (!c.pos || isStale(c.pos) || !seeingThem(c)) continue;
    seen.add(c.id);
    const ll = [c.pos.lon, c.pos.lat];
    const m = markers.get(c.id);
    if (m) m.setLngLat(ll);
    else {
      const el = makeEl('person', initials(label(c)));
      el.title = label(c);
      el.addEventListener('click', (e) => { e.stopPropagation(); focusPerson(c.id); });
      markers.set(c.id, new maplibregl.Marker({ element: el }).setLngLat(ll).addTo(map));
    }
    const hex = colorOf(c.id); // follows the person's colour setting
    const markerEl = markers.get(c.id).getElement();
    markerEl.style.background = hex;
    markerEl.style.color = contrastText(hex);
  }
  for (const [id, m] of markers) if (!seen.has(id)) { m.remove(); markers.delete(id); }
  if (follow.target !== null && follow.target !== 'me') { moveToFollowed(); renderFollowUi(); }
  renderDistances(); // people moved, appeared or changed colour
}

// ---------- GPS and heights ----------

let gpsWatch = null;

const GPS_HELP = {
  1: 'Location is blocked for this page. On iPhone: Settings → Privacy & Security → Location Services → Safari Websites → While Using the App. Then tap Enable location.',
  2: 'Your position is unavailable. Check that Location Services is on, then tap Enable location.',
  3: 'Still waiting for a GPS fix. Try moving near a window or outdoors.',
};

function showGpsBanner(text) {
  $('#gps-msg').textContent = text;
  $('#gps-banner').hidden = false;
}

function stopGps() {
  if (gpsWatch !== null) navigator.geolocation.clearWatch(gpsWatch);
  gpsWatch = null;
}

// Safe to call repeatedly. Also called from a button tap, which iOS needs for its permission prompt.
function startGps() {
  if (gpsWatch !== null) return;
  if (!('geolocation' in navigator)) return showGpsBanner('This browser has no location support.');
  showGpsBanner('Waiting for location permission…');
  try {
    gpsWatch = navigator.geolocation.watchPosition(onFix, onGpsError,
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  } catch (err) {
    showGpsBanner(`Could not start location: ${err.message}`);
  }
}

function onGpsError(err) {
  setStatus('GPS: no fix');
  showGpsBanner(GPS_HELP[err.code] ?? err.message);
  if (err.code === 1) stopGps(); // denied: stop retrying until the user taps Enable location
}

function onFix(p) {
  $('#gps-banner').hidden = true;
  const { latitude: lat, longitude: lon, accuracy, altitude } = p.coords;
  const firstFix = myPos === null;
  myPos = { lat, lon, acc: accuracy };
  if (!myMarker) {
    const dot = makeEl('me-dot', '');
    dot.style.setProperty('--me', colorOf('me'));
    dot.addEventListener('click', (e) => { e.stopPropagation(); openPanel('me'); });
    myMarker = new maplibregl.Marker({ element: dot }).setLngLat([lon, lat]).addTo(map);
  }
  else myMarker.setLngLat([lon, lat]);
  $('#me-gps').textContent = `±${Math.round(accuracy)} m accuracy`;
  $('#gps-alt').textContent = altitude == null ? 'n/a' : `${Math.round(altitude)} m`;
  setStatus('GPS live');
  if (follow.target === 'me') moveToFollowed({ fresh: firstFix });
  else if (follow.target === 'all') fitEveryone();
  if (state && accuracy <= 100) recordTrail('me', { lat, lon, ts: Date.now() }); // skip very rough fixes
  maybeSendPosition();
  maybeUpdateTerrain();
  renderContacts();
  renderDistances();
}

const elevationCache = new Map();
async function elevationAt(lat, lon) {
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (elevationCache.has(key)) return elevationCache.get(key);
  const u = new URL(ELEVATION_URL);
  u.search = new URLSearchParams({ nord: lat, ost: lon, koordsys: '4258', geojson: 'false' });
  const res = await fetch(u);
  if (!res.ok) throw new Error(`Elevation service returned ${res.status}`);
  const z = (await res.json())?.punkter?.[0]?.z;
  const value = typeof z === 'number' && Number.isFinite(z) ? Math.round(z * 10) / 10 : null;
  elevationCache.set(key, value);
  return value;
}

async function maybeUpdateTerrain() {
  if (!myPos) return;
  const moved = terrainFor ? haversineM(terrainFor.lat, terrainFor.lon, myPos.lat, myPos.lon) : Infinity;
  if (moved < 50 && Date.now() - terrainAt < 60000) return;
  terrainFor = { lat: myPos.lat, lon: myPos.lon };
  terrainAt = Date.now();
  try {
    const h = await elevationAt(myPos.lat, myPos.lon);
    $('#terrain').textContent = h == null ? 'outside coverage' : `${h.toFixed(1)} m a.s.l.`;
  } catch { $('#terrain').textContent = 'unavailable'; }
}

// ---------- messaging ----------

async function publish(topic, obj, aes) {
  try {
    await relay.publish(topic, aes ? await seal(aes, obj) : JSON.stringify(obj));
  } catch {
    setStatus('Can’t reach the rendezvous server'); // a plain "Failed to fetch" tells the user nothing
  }
}

async function sendPair(c, obj) {
  const ch = channels.get(c.id);
  if (ch) await publish(ch.topic, obj, ch.aes);
}

function maybeSendPosition(force = false) {
  if (!myPos || (!force && Date.now() - lastSent < SEND_EVERY_MS)) return;
  lastSent = Date.now();
  for (const c of activeContacts()) {
    if (shouldSendPosition(me(), c)) sendPair(c, { t: 'pos', ts: Date.now(), lat: myPos.lat, lon: myPos.lon, acc: myPos.acc });
  }
}

async function sendAdminState(c) {
  const obj = adminPayload(c.youAdminThem === true, Date.now());
  await sendPair(c, { ...obj, sig: await signObj(keys.ecdsa, obj) });
}

async function openChannel(c) {
  const ch = await channelFromSecret(c.secret);
  channels.set(c.id, ch);
  relay.subscribe(ch.topic, (text) => onPairMessage(c.id, text));
}

async function onPairMessage(id, text) {
  const c = state.contacts[id];
  const ch = channels.get(id);
  if (!c || !ch) return;
  const msg = await open(ch.aes, text);
  if (!msg) return;
  let adminVerified = false;
  if (msg.t === 'admin') {
    adminVerified = await verifyObj(c.s, adminPayload(msg.on, msg.ts), msg.sig);
  }
  const patch = applyPairMessage(c, msg, { adminVerified });
  if (!Object.keys(patch).length) return;
  Object.assign(c, patch);
  if (patch.pos) recordTrail(id, { lat: patch.pos.lat, lon: patch.pos.lon, ts: patch.pos.ts });
  if ('theirVisible' in patch && !seeingThem(c)) clearTrail(id); // they stopped sharing: their trail goes too
  saveState();
  renderAll();
}

async function activate(c) {
  c.secret = await deriveSecret(keys.ecdh, c.e);
  c.status = 'active';
  await openChannel(c);
  saveState();
  await sendPair(c, { t: 'vis', v: state.visible });
  if (c.adminTouched) await sendAdminState(c);
  renderAll();
}

async function onInboxMessage(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (!msg || (msg.t !== 'hello' && msg.t !== 'ack')) return;
  let card;
  try { card = decodeCard(typeof msg.card === 'string' ? msg.card : ''); } catch { return; }
  const id = await fingerprint(card.e);
  if (id === state.identity.id) return;
  const c = state.contacts[id];
  if (c?.status === 'active') return;
  if (c?.status === 'pending') {
    Object.assign(c, { name: card.n, e: card.e, s: card.s });
    await activate(c);
    if (msg.t === 'hello') await publish(await inboxTopic(card.e), { t: 'ack', card: encodeCard(cardOf(state.identity)) });
    return;
  }
  if (msg.t === 'ack') return; // an ack is only meaningful for a request we made
  state.contacts[id] = { id, name: card.n, e: card.e, s: card.s, status: 'request' };
  saveState();
  renderAll();
}

async function addContactFromCode(raw) {
  let code = String(raw).trim();
  const m = /[#&]c=([A-Za-z0-9_-]+)/.exec(code);
  if (m) code = m[1];
  const card = decodeCard(code);
  const id = await fingerprint(card.e);
  if (id === state.identity.id) throw new Error('That is your own code');
  const existing = state.contacts[id];
  if (existing?.status === 'active') throw new Error(`${existing.name} is already a contact`);
  state.contacts[id] = { ...(existing ?? {}), id, name: card.n, e: card.e, s: card.s, status: existing?.status === 'request' ? 'request' : 'pending' };
  saveState();
  if (state.contacts[id].status === 'request') await acceptRequest(id);
  else await publish(await inboxTopic(card.e), { t: 'hello', card: encodeCard(cardOf(state.identity)) });
  renderAll();
}

async function acceptRequest(id) {
  const c = state.contacts[id];
  await activate(c);
  await publish(await inboxTopic(c.e), { t: 'ack', card: encodeCard(cardOf(state.identity)) });
}

// ---------- rendering ----------

function renderMe() {
  $('#me-name').textContent = state.identity.name;
  $('#visible').checked = state.visible;
  $('#relay').value = state.relay;
  $('#fingerprint').textContent = state.identity.id.match(/.{1,4}/g).join(' ');
  const admins = activeContacts().filter((c) => c.adminOverMe).map(label);
  const notice = $('#admin-notice');
  notice.hidden = !admins.length;
  if (admins.length) notice.textContent = `${admins.join(', ')} can see you even when sharing is off. This is set by them and cannot be changed here.`;
  $('#visible').disabled = false;
  const mt = traceOf('me');
  $('#trace-me').checked = mt.on;
  $('#trace-me-length').classList.toggle('off', !mt.on);
  $('#trace-me-meters').value = String(mt.meters);
  $('#trace-me-colors').innerHTML = swatchesHtml('me', mt.color);
}

function renderRequests() {
  const reqs = Object.values(state.contacts).filter((c) => c.status === 'request');
  const ul = $('#requests');
  ul.hidden = !reqs.length;
  const badge = $('#req-badge'); // so a request is noticed even while the map is showing
  badge.hidden = !reqs.length;
  badge.textContent = String(reqs.length);
  ul.innerHTML = reqs.map((c) => `
    <li class="contact request">
      <div class="who"><div class="name">${esc(c.name)} wants to connect</div>
      <div class="muted small">Check that this code matches theirs: <code class="fp" data-fp="${esc(c.id)}">${esc(c.id.match(/.{1,4}/g).join(' '))}</code></div></div>
      <div class="contact-actions">
        <button class="primary" data-act="accept" data-id="${esc(c.id)}">Accept</button>
        <button class="ghost danger" data-act="decline" data-id="${esc(c.id)}">Decline</button>
      </div>
    </li>`).join('');
}

function renderContacts() {
  const list = $('#contacts');
  // Don't rebuild the list under a picker that is open: it would close on the user.
  if (document.activeElement?.tagName === 'SELECT' && list.contains(document.activeElement)) return;
  const all = Object.values(state.contacts).filter((c) => c.status !== 'request').sort((a, b) => label(a).localeCompare(label(b)));
  if (!all.length) {
    list.innerHTML = '<li class="muted empty">No contacts yet. Share your invite link, or paste someone else’s link above.</li>';
    return;
  }
  list.innerHTML = all.map((c) => {
    const id = esc(c.id);
    if (c.status === 'pending') {
      return `<li class="contact"><div class="contact-head"><div class="avatar" style="background:${colorOf(c.id)};color:${contrastText(colorOf(c.id))}">${esc(initials(c.name))}</div>
        <div class="who"><div class="name">${esc(c.name)}</div><div class="muted small">Waiting for them to accept</div></div></div>
        <div class="contact-actions"><button class="ghost danger" data-act="remove" data-id="${id}">Cancel</button></div></li>`;
    }
    const visibleNow = seeingThem(c) && c.pos && !isStale(c.pos);
    const dist = myPos && visibleNow ? formatMetres(haversineM(myPos.lat, myPos.lon, c.pos.lat, c.pos.lon)) : '—';
    let status;
    if (visibleNow && c.youAdminThem && !c.theirVisible) status = 'Visible to you as admin';
    else if (visibleNow) status = 'Live';
    else if (!seeingThem(c)) status = 'Hidden by them';
    else status = c.pos ? 'Last position is old' : 'No position yet';
    const lock = c.adminOverMe ? '<span class="chip lock">Admin set · locked</span>' : '';
    const adminBtn = c.adminOverMe ? '' :
      `<button class="ghost" data-act="admin" data-id="${id}" data-on="${!c.youAdminThem}">${c.youAdminThem ? 'Remove my admin' : 'Make me admin'}</button>`;
    const removeBtn = canRemoveContact(c)
      ? `<button class="ghost danger" data-act="remove" data-id="${id}">Remove</button>`
      : '<button class="ghost" disabled title="Locked by an admin">Remove</button>';
    const t = traceSettings(c.trace);
    const lengths = `<select data-trace-meters data-id="${id}" aria-label="Trail length for ${esc(label(c))}">${TRACE_OPTIONS
      .map((m) => `<option value="${m}"${m === t.meters ? ' selected' : ''}>${labelForMeters(m)}</option>`).join('')}</select>`;
    // Length and colour can be set before the trail is switched on; they are dimmed while it is off.
    const traceRow = `<div class="trace-block${t.on ? '' : ' off'}">
        <div class="trace-row"><span>Trail</span>${lengths}<input type="checkbox" role="switch" data-trace-on data-id="${id}" aria-label="Show trail for ${esc(label(c))}"${t.on ? ' checked' : ''}></div>
      </div>
      <div class="colour-row"><span>Colour</span>
        <div class="swatches" role="group" aria-label="Colour for ${esc(label(c))}">${swatchesHtml(id, t.color)}</div>
      </div>`;
    return `
      <li class="contact" data-contact="${id}">
        <div class="contact-head">
          <div class="avatar" style="background:${colorOf(c.id)};color:${contrastText(colorOf(c.id))}">${esc(initials(label(c)))}</div>
          <div class="who">
            <div class="name">${esc(c.nick || c.name)}${c.nick ? ` <small class="muted">(${esc(c.name)})</small>` : ''}</div>
            <div class="muted small">${esc(status)} · they ${theyCanSeeMe(me(), c) ? 'can' : 'cannot'} see you</div>
          </div>
          <div class="dist" title="Straight-line distance">${dist}</div>
        </div>
        <div class="contact-actions">
          ${lock}
          ${visibleNow ? `<button class="ghost" data-act="focus" data-id="${id}">Show</button>` : ''}
          <button class="ghost" data-act="nick" data-id="${id}">Nickname</button>
          ${adminBtn}${removeBtn}
        </div>
        ${traceRow}
      </li>`;
  }).join('');
}

/** Open People and bring a person's row (with their trail settings) into view. */
function focusPerson(id) {
  openPanel('people');
  setTimeout(() => {
    const row = document.querySelector(`#contacts li[data-contact="${CSS.escape(id)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1400);
  }, 460); // after the sheet has slid in
}

function renderAll() {
  renderMe();
  renderRequests();
  renderContacts();
  renderMarkers();
  renderTraces();
  renderFollowUi(); // arrows, my dot and the person label follow the colour settings
}

async function onListClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const c = state.contacts[btn.dataset.id];
  if (!c) return;
  try {
    switch (btn.dataset.act) {
      case 'color': setTrace(c.id, { color: btn.dataset.color }); return; // setTrace saves and redraws
      case 'accept': await acceptRequest(c.id); break;
      case 'decline': delete state.contacts[c.id]; break;
      case 'focus':
        closePanel(); // show the map
        setFollow(followPerson(follow, c.id), { recentre: true }); // and follow this person
        return;
      case 'nick': {
        const nick = prompt(`Nickname for ${c.name} (empty to clear)`, c.nick ?? '');
        if (nick === null) return;
        c.nick = nick.trim().slice(0, 40) || undefined;
        break;
      }
      case 'admin': {
        const on = btn.dataset.on === 'true';
        if (on && !confirm(`Make yourself admin over ${c.name}? You will see their position even when they turn sharing off, and they cannot remove this.`)) return;
        c.youAdminThem = on;
        c.adminTouched = true;
        await sendAdminState(c);
        break;
      }
      case 'remove':
        if (c.status === 'active' && !canRemoveContact(c)) return setStatus('An admin has set this. Only they can change it.');
        if (!confirm(`Remove ${c.name}?`)) return;
        if (channels.has(c.id)) { relay.unsubscribe(channels.get(c.id).topic); channels.delete(c.id); }
        delete state.contacts[c.id];
        clearTrail(c.id);
        setFollow(contactRemoved(follow, c.id)); // never keep following someone who is gone
        break;
    }
    saveState();
    renderAll();
  } catch (err) { setStatus(err.message); }
}

// ---------- route ----------

function populateProfiles() {
  $('#profile').innerHTML = Object.keys(ROUTING).map((k) => `<option value="${k}">Car</option>`).join('');
}

function setDestination(dest) {
  destination = dest;
  if (!destMarker) destMarker = new maplibregl.Marker({ element: makeEl('dest', '⚑') }).setLngLat([dest.lon, dest.lat]).addTo(map);
  else destMarker.setLngLat([dest.lon, dest.lat]);
  routeMode = false;
  $('#pick').classList.remove('active');
  $('#route-hint').textContent = 'Calculating route…';
  computeRoute();
}

function showRouteError(msg) {
  const el = $('#route-error');
  el.hidden = false;
  el.textContent = msg;
}

const formatDuration = (s) => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

async function computeRoute() {
  $('#route-error').hidden = true;
  if (!myPos) return showRouteError('Waiting for a GPS fix to use as the start.');
  const base = ROUTING[$('#profile').value];
  const url = `${base}/${myPos.lon},${myPos.lat};${destination.lon},${destination.lat}?overview=full&geometries=geojson&steps=false`;
  try {
    const data = await (await fetch(url)).json();
    if (data.code !== 'Ok' || !data.routes?.length) throw new Error(data.message ?? 'No route found');
    const route = data.routes[0];
    map.getSource('route').setData({ type: 'Feature', geometry: route.geometry, properties: {} });
    $('#route-hint').textContent = '';
    $('#route-summary').hidden = false;
    $('#r-dist').textContent = formatMetres(route.distance);
    $('#r-time').textContent = formatDuration(route.duration);
    await renderProfile(route.geometry.coordinates, route.distance);
  } catch (err) { showRouteError(`Route failed: ${err.message}`); }
}

// Sample up to 40 evenly spaced vertices, look up their heights, and draw the profile.
async function renderProfile(coords, totalM) {
  const n = Math.min(40, coords.length);
  const idx = Array.from({ length: n }, (_, i) => Math.round((i * (coords.length - 1)) / Math.max(1, n - 1)));
  const pts = idx.map((i) => [coords[i][1], coords[i][0]]);
  const elevations = new Array(pts.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < pts.length) {
      const i = next++;
      try { elevations[i] = await elevationAt(pts[i][0], pts[i][1]); } catch { /* leave gap */ }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  const dists = [0];
  for (let i = 1; i < pts.length; i++) dists.push(dists[i - 1] + haversineM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  const { up, down } = elevationGainLoss(elevations);
  $('#r-up').textContent = `${up} m`;
  $('#r-down').textContent = `${down} m`;

  const svg = $('#profile-svg');
  const valid = elevations.map((h, i) => ({ h, d: dists[i] })).filter((p) => p.h != null);
  svg.hidden = valid.length < 2;
  if (svg.hidden) return;
  const hs = valid.map((p) => p.h);
  const min = Math.min(...hs), max = Math.max(...hs), span = Math.max(1, max - min);
  const W = 320, H = 110, pad = 6, total = Math.max(1, totalM);
  const xy = valid.map((p) => `${((p.d / total) * W).toFixed(1)},${(H - pad - ((p.h - min) / span) * (H - pad * 2)).toFixed(1)}`);
  svg.innerHTML = `
    <polygon points="0,${H} ${xy.join(' ')} ${W},${H}" fill="currentColor" opacity="0.12"></polygon>
    <polyline points="${xy.join(' ')}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"></polyline>
    <text x="4" y="12" font-size="10" fill="currentColor">${Math.round(max)} m</text>
    <text x="4" y="${H - 2}" font-size="10" fill="currentColor">${Math.round(min)} m</text>`;
}

// ---------- tabs, onboarding, startup ----------

// The app opens on the map. The top menu opens one panel at a time over it; the same
// button (or the close button, or Escape) puts the map back on its own.
const PANEL_TITLES = { people: 'People', route: 'Route', me: 'Me' };
let openTab = null;

let closeTimer = null;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function openPanel(name) {
  openTab = name;
  const panel = $('#panel');
  clearTimeout(closeTimer);
  panel.hidden = false;
  $('#panel-title').textContent = PANEL_TITLES[name];
  for (const t of Object.keys(PANEL_TITLES)) $(`#tab-${t}`).hidden = t !== name;
  document.querySelectorAll('.menu-btn[data-tab]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === name)));
  panel.style.transform = '';
  requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.add('open'))); // let it start off-screen, then slide in
  // Once it has slid in, keep the followed point in the part of the map that is still visible.
  setTimeout(() => { if (follow.target !== null) moveToFollowed({ force: true }); }, 480);
}

function closePanel() {
  openTab = null;
  const panel = $('#panel');
  panel.style.transform = '';
  panel.classList.remove('open');
  document.querySelectorAll('.menu-btn[data-tab]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => { if (openTab === null) panel.hidden = true; }, reducedMotion() ? 0 : 450);
  if (follow.target !== null) moveToFollowed({ force: true }); // sheet is leaving: use the whole map again
}

// Drag the sheet down to dismiss it (phones), like a system sheet.
function enableSheetDrag() {
  const panel = $('#panel');
  const handles = [panel.querySelector('.grabber'), panel.querySelector('.panel-head')];
  let startY = null;
  const phone = () => window.matchMedia('(max-width: 640px)').matches;
  for (const h of handles) {
    h.addEventListener('pointerdown', (e) => {
      if (!phone() || e.target.closest('button')) return;
      startY = e.clientY;
      h.setPointerCapture(e.pointerId);
      panel.classList.add('dragging');
    });
    h.addEventListener('pointermove', (e) => {
      if (startY === null) return;
      panel.style.transform = `translateY(${Math.max(0, e.clientY - startY)}px)`;
    });
    const end = (e) => {
      if (startY === null) return;
      const dy = e.clientY - startY;
      startY = null;
      panel.classList.remove('dragging');
      if (dy > 90) closePanel();
      else panel.style.transform = '';
    };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
  }
}

const togglePanel = (name) => (openTab === name ? closePanel() : openPanel(name));

const inviteLink = () => `${location.origin}${location.pathname}#c=${encodeCard(cardOf(state.identity))}`;

async function startApp() {
  $('#auth').hidden = true;
  $('#menu').hidden = false; // the map stays in view; panels open from the top menu
  $('#follow-me').hidden = false;
  $('#measure').hidden = false;
  renderDistances();
  renderFollowUi();
  startGps(); // first, so a failure further down can't leave location unasked
  keys = await loadKeys(state.identity);
  relay = new Relay(state.relay || DEFAULT_RELAY);
  relay.subscribe(await inboxTopic(state.identity.ecdhPub), onInboxMessage, '12h');
  for (const c of activeContacts()) await openChannel(c);
  for (const c of activeContacts()) if (c.adminTouched) sendAdminState(c);
  // Re-send invites that haven't been answered yet (the rendezvous only keeps them for a while).
  for (const c of Object.values(state.contacts)) {
    if (c.status === 'pending') {
      inboxTopic(c.e).then((t) => publish(t, { t: 'hello', card: encodeCard(cardOf(state.identity)) }));
    }
  }
  renderAll();
  setInterval(() => { renderContacts(); renderMarkers(); renderTraces(); }, 15_000);
  consumeInviteFromUrl();
}

function consumeInviteFromUrl() {
  const m = /[#&]c=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const card = decodeCard(m[1]);
    $('#add-code').value = m[1];
    $('#add-error').hidden = false;
    $('#add-error').classList.remove('error');
    $('#add-error').textContent = `Invite from ${card.n}. Press Add to connect.`;
    openPanel('people');
  } catch { /* ignore a broken link */ }
}

function wire() {
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    try {
      state = { identity: await newIdentity($('#auth-name').value), visible: true, relay: DEFAULT_RELAY, contacts: {} };
      saveState();
      await startApp();
    } catch (err) {
      $('#auth-error').hidden = false;
      $('#auth-error').textContent = err.message;
      btn.disabled = false;
    }
  });

  $('#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = $('#add-error');
    out.hidden = true; out.classList.add('error');
    try {
      await addContactFromCode($('#add-code').value);
      $('#add-code').value = '';
    } catch (err) { out.hidden = false; out.textContent = err.message; }
  });

  $('#copy-link').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(inviteLink()); setStatus('Invite link copied'); }
    catch { prompt('Copy your invite link:', inviteLink()); }
  });

  $('#gps-retry').addEventListener('click', () => { stopGps(); startGps(); });

  // Trails: per person, off by default, length chosen per person.
  $('#contacts').addEventListener('change', (e) => {
    const el = e.target;
    if (el.matches('input[data-trace-on]')) setTrace(el.dataset.id, { on: el.checked });
    else if (el.matches('select[data-trace-meters]')) setTrace(el.dataset.id, { meters: Number(el.value) });
  });
  $('#trace-me-meters').innerHTML = TRACE_OPTIONS.map((m) => `<option value="${m}">${labelForMeters(m)}</option>`).join('');
  $('#trace-me').addEventListener('change', (e) => setTrace('me', { on: e.target.checked }));
  $('#trace-me-meters').addEventListener('change', (e) => setTrace('me', { meters: Number(e.target.value) }));
  $('#trace-me-colors').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-color]');
    if (b) setTrace('me', { color: b.dataset.color });
  });

  $('#contacts').addEventListener('click', onListClick);
  $('#requests').addEventListener('click', onListClick);
  document.querySelectorAll('.menu-btn[data-tab]').forEach((b) => b.addEventListener('click', () => togglePanel(b.dataset.tab)));
  $('#close-panel').addEventListener('click', closePanel);
  enableSheetDrag();
  // Left arrow: follow me. Right arrow: follow the person chosen with Show. All: keep everyone in view.
  $('#follow-me').addEventListener('click', () => {
    if (!myPos) { startGps(); setStatus('Waiting for your location…'); }
    setFollow(followMe(follow), { recentre: true });
  });
  $('#follow-person').addEventListener('click', () => setFollow(pressPersonArrow(follow), { recentre: true }));
  $('#measure').addEventListener('click', () => {
    state.showDistances = state.showDistances !== true; // off by default
    saveState();
    renderDistances();
    if (state.showDistances && !myPos) setStatus('Waiting for your location…');
  });
  $('#menu-all').addEventListener('click', () => {
    closePanel(); // show the map
    setFollow(followAll(follow), { recentre: true });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });

  $('#visible').addEventListener('change', (e) => {
    state.visible = e.target.checked;
    saveState();
    for (const c of activeContacts()) sendPair(c, { t: 'vis', v: state.visible });
    if (state.visible) maybeSendPosition(true);
    renderAll();
  });

  $('#save-relay').addEventListener('click', () => {
    const v = $('#relay').value.trim().replace(/\/$/, '');
    if (!/^https:\/\/[^/\s]+(\/[^\s]*)?$/.test(v)) return setStatus('Relay must be an https URL');
    state.relay = v;
    saveState();
    location.reload();
  });

  $('#backup').addEventListener('click', async () => {
    const text = JSON.stringify(state);
    try { await navigator.clipboard.writeText(text); setStatus('Backup copied. It contains your private keys: keep it secret.'); }
    catch { prompt('Backup (contains private keys):', text); }
  });
  $('#restore').addEventListener('click', () => {
    const text = prompt('Paste a backup to restore. This replaces the identity on this device.');
    if (!text) return;
    try {
      const s = JSON.parse(text);
      if (!s?.identity?.ecdhPriv || !s.identity.ecdsaPriv) throw new Error('Not a Rope backup');
      localStorage.setItem(STORE_KEY, text);
      location.reload();
    } catch (err) { setStatus(err.message); }
  });
  $('#reset').addEventListener('click', () => {
    if (!confirm('Delete your identity and all contacts from this device? This cannot be undone. Export a backup first.')) return;
    try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
    location.reload();
  });

  $('#pick').addEventListener('click', () => {
    routeMode = !routeMode;
    $('#pick').classList.toggle('active', routeMode);
    $('#route-hint').textContent = routeMode ? 'Tap the map to set the destination.' : '';
  });
  $('#clear-route').addEventListener('click', () => {
    destination = null;
    destMarker?.remove(); destMarker = null;
    map.getSource('route').setData({ type: 'FeatureCollection', features: [] });
    $('#route-summary').hidden = true;
    $('#profile-svg').hidden = true;
    $('#route-error').hidden = true;
  });
  $('#profile').addEventListener('change', () => { if (destination) computeRoute(); });
}

// ---------- splash and four-tap reload ----------
// A launch splash covers startup. Tapping the Rope logo four times reloads the app; that shows
// a shorter "Reloading" splash, and the launch splash does not run again (see boot.js).

const isReloadBoot = document.documentElement.dataset.boot === 'reload';
const splashShownAt = performance.now();
let splashHidden = false;

function hideSplash() {
  if (splashHidden) return;
  splashHidden = true;
  const minimum = isReloadBoot ? 600 : 1400; // long enough to read, short enough not to get in the way
  const wait = Math.max(0, minimum - (performance.now() - splashShownAt));
  setTimeout(() => {
    const splash = $('#splash');
    splash.classList.add('hide');
    setTimeout(() => { splash.hidden = true; }, reducedMotion() ? 0 : 550);
  }, wait);
}

function reloadApp() {
  try { sessionStorage.setItem('rope.reload', '1'); } catch { /* the launch splash will show instead */ }
  document.documentElement.dataset.boot = 'reload'; // show the reload variant of the splash
  const splash = $('#splash');
  splash.hidden = false;
  requestAnimationFrame(() => splash.classList.remove('hide'));
  setTimeout(() => location.reload(), 350);
}

// Four quick taps on the Rope button reload the app. This uses the button's plain click, which
// browsers (iOS Safari included) fire for every tap; taps older than 2.5 seconds are forgotten.
// A click also comes from the keyboard, so pressing Enter four times works too.
function enableLogoReload() {
  const NEEDED = 4, WINDOW_MS = 2500;
  let taps = [];
  $('#brand').addEventListener('click', (e) => {
    const now = e.timeStamp;
    taps = taps.filter((t) => now - t <= WINDOW_MS);
    taps.push(now);
    if (taps.length >= NEEDED) { taps = []; reloadApp(); }
  });
}

function bootstrap() {
  enableLogoReload();
  setTimeout(hideSplash, 6000); // never leave the splash up if something below stalls
  const build = $('#build');
  if (build.textContent.startsWith('__')) build.textContent = 'dev'; // not replaced by the Pages build
  populateProfiles();
  initMap();
  wire();
  state = loadState();
  if (!window.crypto?.subtle) {
    setStatus('This browser has no WebCrypto (needs https)');
    hideSplash();
    return;
  }
  if (state) startApp().catch((err) => { setStatus(err.message); hideSplash(); });
  else { $('#auth').hidden = false; setStatus('Create your identity'); consumeInviteFromUrl(); }
}

bootstrap();

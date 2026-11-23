import { haversineM, formatMetres, elevationGainLoss } from './geo.js';
import {
  newIdentity, loadKeys, cardOf, encodeCard, decodeCard, fingerprint,
  deriveSecret, channelFromSecret, seal, open, signObj, verifyObj,
} from './crypto.js';
import { newCode, parseCode, qrText, pairTopic, PakeHost, PakeJoiner, CODE_TTL_MS } from './pake.js';
import { Relay, DEFAULT_RELAY } from './net.js';
import { PeerLink, SIGNAL_MAX_AGE_MS, isOfferer } from './p2p.js';
import { encodeLink, decodeLink, looksLikeLink } from './qrlink.js';
import { debugLog, logger, DebugOverlay, tapCounter, ago } from './debug.js';
import {
  initialFollow, followMe, followPerson, followAll, dragged, pressPersonArrow, contactRemoved,
  meArrowState, personArrowState, allState,
} from './follow.js';
import { personHex, contrastText } from './colors.js';
import { buildDistanceItems, visibleMidpoint, symmetricBounds } from './distance.js';
import { mountWheelPicker, wheelIsBusy, resetWheelActivity } from './wheel.js';
import { registerDemProtocol } from './demprotocol.js';
import * as offline from './offline.js';
import { lookupRoad, nearestSaved, shouldLookup, tapRadiusM } from './road.js';
import {
  normalizeZone, toWire, zonesPayload, zonesFor, sameZones, standing, warnings, warningText, zoneFeatures,
  newZoneId, findPlaces, visibilityOf, DEFAULT_VIS, KINDS, MIN_R, MAX_R, MAX_ZONES,
} from './zones.js';
import { PROTOCOL as DEM_PROTOCOL, DEM_MIN_ZOOM, DEM_MAX_ZOOM, EXAGGERATION, TILT } from './terrain.js';
import {
  TRACE_COLORS, traceSettings, addPoint, trimToDistance, toFeature, labelForLength, metersOfLength,
  colorHex, hexToRgba,
} from './trace.js';
import {
  shouldSendPosition, theyCanSeeMe, seeingThem, canRemoveContact,
  applyPairMessage, adminPayload, adminAnswerPayload, migrateAdmin, isStale,
} from './social.js';

const $ = (sel) => document.querySelector(sel);

// ---------- debug log (shown by the overlay: four quick taps on "All") ----------
const log = { app: logger('app'), gps: logger('gps'), pair: logger('pair') };
window.addEventListener('error', (e) => log.app('error', `${e.message} (${(e.filename ?? '').split('/').pop()}:${e.lineno})`));
window.addEventListener('unhandledrejection', (e) => log.app('error', `unhandled: ${e.reason?.message ?? e.reason}`));
window.addEventListener('online', () => log.app('info', 'network: online'));
window.addEventListener('offline', () => log.app('warn', 'network: offline'));
document.addEventListener('visibilitychange', () => log.app('info', `page ${document.visibilityState}`));
const traffic = new Map(); // contact id -> { txRelay, txDirect, rxRelay, rxDirect, lastRx }
const trafficOf = (id) => {
  if (!traffic.has(id)) traffic.set(id, { txRelay: 0, txDirect: 0, rxRelay: 0, rxDirect: 0, lastRx: 0 });
  return traffic.get(id);
};
const gpsInfo = { fixes: 0, lastFixAt: 0, lastError: '' };
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STORE_KEY = 'rope.v1';
const ELEVATION_URL = 'https://ws.geonorge.no/hoydedata/v1/punkt';
const ROUTING = { car: 'https://router.project-osrm.org/route/v1/driving' };
const SEND_EVERY_MS = 10_000;   // over the rendezvous server: public relays rate-limit
const SEND_DIRECT_MS = 3_000;   // over a direct (peer-to-peer) link: no limit but the battery

// ---------- local state ----------
// state = { identity, visible, relay, contacts: { [id]: contact } }
// contact = { id, name, e, s, status: 'pending'|'active', nick, secret, hw, adminAsk, adminReq, adminAnswer,
//             theirVisible, youAdminThem, adminOverMe, adminTs, adminTouched, pos }
let state = null;
let keys = null;                 // imported private keys
let relay = null;
const channels = new Map();      // contact id -> { aes, topic }
const links = new Map();         // contact id -> PeerLink (direct WebRTC channel)
const lastSentTo = new Map();    // contact id -> when my position last went to them
let myPos = null;
let map = null, myMarker = null, destMarker = null, routeMode = false, destination = null;
const markers = new Map();
let terrainFor = null, terrainAt = 0;

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (!s?.identity) return null;
    for (const [id, c] of Object.entries(s.contacts ?? {})) {
      // Invite-link requests and unanswered invites are gone with the invite link: pair with a code.
      if (c.status !== 'active') { delete s.contacts[id]; continue; }
      Object.assign(c, migrateAdmin(c)); // admin rights now need the subject's approval
    }
    return s;
  } catch { return null; }
}
function saveState() {
  try {
    const copy = { ...state, contacts: Object.fromEntries(Object.entries(state.contacts).map(([id, c]) => [id, { ...c, pos: undefined }])) };
    localStorage.setItem(STORE_KEY, JSON.stringify(copy));
  } catch { /* storage unavailable; the session still works */ }
}
// The status: a chip with a coloured dot and the words on a wide screen. On a phone it is only the
// dot (so the top bar fits on one row), and a message that isn't "GPS live" appears as a short toast.
let toastTimer = null;
const isPhone = () => window.matchMedia('(max-width: 640px)').matches;
function showToast(text) {
  const toast = $('#toast');
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4000);
}
function setStatus(text) {
  if (text !== 'GPS live') log.app(/^(Starting|Create your identity|Invite link copied|Code copied)/.test(text) ? 'info' : 'warn', `status: ${text}`);
  const ok = text === 'GPS live';
  $('#status-text').textContent = text;
  $('#status').dataset.tone = ok ? 'ok' : /^(Starting|Create your identity)/.test(text) ? 'idle' : 'warn';
  $('#status').title = text;
  if (isPhone() && !ok) showToast(text);
}
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
    attributionControl: false, // added below, so the terrain's credit can be added and removed
    maxPitch: 75,             // the camera can be tilted well down for the 3D terrain
  });
  setAttribution(false);
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
  // A small scale line that adapts as you zoom in and out.
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');

  // Put the first map error on screen with the build id, so a blank map can be diagnosed from a phone.
  let mapErrorShown = false;
  let terrainErrors = 0;
  map.on('error', (e) => {
    if (e.sourceId === 'terrain-dem') { // a terrain tile that could not be made: the ground is flat there for now
      if (++terrainErrors === 1) setStatus('Some terrain data could not be loaded');
      return; // not the red "map problem" banner, which is for the base map
    }
    if (offlineOn() && e.sourceId === 'osm') { // a tile that is not saved: the map stays empty there, not an error
      if (++offlineErrors === 1) setStatus('Offline: this part of the map is not saved on this device');
      return;
    }
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
    map.addSource('zones', { type: 'geojson', data: zoneFeatures([]) });
    map.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones',
      paint: { 'fill-color': ['match', ['get', 'kind'], 'no', '#ff3b30', '#34c759'], 'fill-opacity': ['min', 0.65, ['+', ['+', 0.02, ['*', 0.18, ['get', 'v']]], ['*', ['get', 's'], 0.38]]] } }, 'route-line');
    map.addLayer({ id: 'zones-line', type: 'line', source: 'zones',
      paint: { 'line-color': ['match', ['get', 'kind'], 'no', '#ff3b30', '#34c759'], 'line-width': 1.5, 'line-opacity': ['min', 1, ['+', ['+', 0.1, ['*', 0.5, ['get', 'v']]], ['*', ['get', 's'], 0.5]]] } }, 'route-line');
    map.addSource('zone-draft', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'zone-draft-fill', type: 'fill', source: 'zone-draft', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#007aff', 'fill-opacity': 0.12 } });
    map.addLayer({ id: 'zone-draft-line', type: 'line', source: 'zone-draft', filter: ['==', '$type', 'Polygon'], paint: { 'line-color': '#007aff', 'line-width': 2, 'line-dasharray': [2, 2] } });
    map.addLayer({ id: 'zone-draft-point', type: 'circle', source: 'zone-draft', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 6, 'circle-color': '#fff', 'circle-stroke-color': '#007aff', 'circle-stroke-width': 3 } });
    map.addSource('inspect-road', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'inspect-line', type: 'line', source: 'inspect-road', filter: ['in', '$type', 'LineString'],
      paint: { 'line-color': '#2563eb', 'line-width': 9, 'line-opacity': 0.4 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
    map.addLayer({ id: 'inspect-point', type: 'circle', source: 'inspect-road', filter: ['==', '$type', 'Point'],
      paint: { 'circle-radius': 6, 'circle-color': '#fff', 'circle-stroke-color': '#2563eb', 'circle-stroke-width': 3 } });
    renderTraces();
    renderZones();
    renderDraft();
    renderDistances();
    applyTerrain(); // the 3D terrain, if it was left switched on
    if (terrainOn()) map.jumpTo({ pitch: TILT });
  });
  map.on('click', (e) => {
    if (zonePicking) return placeZone(e.lngLat.lat, e.lngLat.lng);
    if (inspectOn) return inspectAt(e.lngLat.lat, e.lngLat.lng);
    if (routeMode) setDestination({ lat: e.lngLat.lat, lon: e.lngLat.lng });
  });

  // Dragging the map by hand stops following. The map's own animated moves don't fire dragstart.
  map.on('dragstart', () => setFollow(dragged(follow)));
  map.on('moveend', () => { programmaticMove = false; });
  map.on('zoomend', noteTerrainZoom);
  map.on('move', placeDistanceLabels);
  // Resizing the window (or turning the phone) keeps following whatever is being followed.
  map.on('resize', () => { if (follow.target !== null) moveToFollowed({ force: true }); });
  // Zooming by hand leaves "All" (its zoom is chosen for you) but keeps following me at the new zoom.
  // (A zoom the app did not start itself is the user's: wheel, pinch, double tap or the zoom buttons.)
  map.on('zoomstart', (e) => { if (!e.programmatic && follow.target === 'all') setFollow(followMe(follow)); });
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
  next.meters = metersOfLength(next.length); // the same length in metres, for the trail
  // Store the length as { unit, value }, the way the wheels show it (3 mi stays 3 mi), not as metres.
  const stored = { on: next.on, length: next.length, color: next.color };
  if (id === 'me') state.myTrace = stored;
  else if (state.contacts[id]) state.contacts[id].trace = stored;
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

// ---------- 3D terrain ----------
// The terrain button draws the ordinary map in 3D: the OpenStreetMap map is draped over the real
// terrain model from hoydedata.no (Kartverket), with a light hillshade, and the camera is tilted so
// the relief shows. Off by default; the choice is remembered. The heights come from Kartverket's
// elevation service, turned into MapLibre height tiles on demand (terrain.js, demprotocol.js).
// Below zoom 8 and outside the area the service covers the ground is flat.

let attributionControl = null;
let demNoted = false;

const terrainOn = () => state?.showHeightmap === true;

/** The map's credits: OpenStreetMap always, and Kartverket while the 3D terrain is on. */
function setAttribution(terrain) {
  if (attributionControl) map.removeControl(attributionControl);
  attributionControl = new maplibregl.AttributionControl({
    compact: true,
    customAttribution: terrain ? 'Terrain © <a href="https://www.kartverket.no/" target="_blank" rel="noopener">Kartverket</a> (hoydedata.no)' : undefined,
  });
  map.addControl(attributionControl, 'bottom-right');
}

/** Makes the map match the switch: terrain, its height tiles and its hillshade on, or all off. */
function applyTerrain() {
  if (!map || !mapReady) return;
  if (terrainOn()) {
    if (!map.getSource('terrain-dem')) {
      map.addSource('terrain-dem', {
        type: 'raster-dem', tiles: [`${DEM_PROTOCOL}://{z}/{x}/{y}`], tileSize: 256,
        minzoom: DEM_MIN_ZOOM, maxzoom: DEM_MAX_ZOOM, encoding: 'terrarium',
      });
    }
    if (!map.getLayer('hillshade')) {
      // Just above the base map, under the trails, lines and route. Light, so the map stays the map.
      const above = map.getStyle().layers.find((l) => l.id !== 'osm' && l.id !== 'hillshade')?.id;
      map.addLayer({
        id: 'hillshade', type: 'hillshade', source: 'terrain-dem',
        paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#2b2b3a', 'hillshade-highlight-color': '#ffffff', 'hillshade-accent-color': '#44445a' },
      }, above);
    }
    map.setTerrain({ source: 'terrain-dem', exaggeration: EXAGGERATION });
  } else {
    map.setTerrain(null);
    if (map.getLayer('hillshade')) map.removeLayer('hillshade');
    if (map.getSource('terrain-dem')) map.removeSource('terrain-dem');
  }
}

/** Say once why the ground is flat when it is, instead of leaving a silent 2D map. */
function noteTerrainZoom() {
  if (!terrainOn() || !map) return;
  if (map.getZoom() < DEM_MIN_ZOOM) {
    if (!demNoted) { demNoted = true; showToast('Zoom in to see the terrain in 3D'); }
  } else {
    demNoted = false;
  }
}

function syncTerrainButton() {
  const on = terrainOn();
  const btn = $('#heightmap');
  btn.setAttribute('aria-pressed', String(on));
  btn.title = on ? 'Hide the 3D terrain' : 'Show the map in 3D';
  btn.setAttribute('aria-label', btn.title);
}

function setTerrain3D(on) {
  state.showHeightmap = on; // off by default
  saveState();
  syncTerrainButton();
  setAttribution(on);
  demNoted = false;
  applyTerrain();
  map.easeTo({ pitch: on ? TILT : 0, duration: 900 }, APP_MOVE);
  if (on) {
    showToast(map.getZoom() < DEM_MIN_ZOOM ? 'Zoom in to see the terrain in 3D' : '3D terrain: tilt with two fingers, or right-drag');
    demNoted = map.getZoom() < DEM_MIN_ZOOM;
  }
}

// ---------- offline map ----------
// The service worker (sw.js) keeps the map tiles, terrain tiles and heights that are looked at. "Go
// offline" tells it to use only those and make no map requests, so the map works without a network.

const offlineOn = () => state?.offlineMap === true;
let offlineErrors = 0;

function syncOfflineUi() {
  const on = offlineOn();
  const btn = $('#offline');
  btn.setAttribute('aria-pressed', String(on));
  btn.title = on ? 'Go back online with the map' : 'Go offline with the map';
  btn.setAttribute('aria-label', btn.title);
  $('#offline-switch').checked = on;
}

async function refreshOfflineStats() {
  if (!offline.supported()) {
    $('#offline-count').textContent = 'Not supported here';
    $('#offline-bytes').textContent = '—';
    $('#offline-switch').disabled = true;
    $('#offline-clear').disabled = true;
    return;
  }
  const st = await offline.stats();
  $('#offline-count').textContent = st.parts.map((p) => `${p.count.toLocaleString()} ${p.label.toLowerCase()}`).join(' · ');
  $('#offline-bytes').textContent = st.bytes == null ? '—' : offline.formatBytes(st.bytes);
}

async function setOfflineMap(on, { quiet = false } = {}) {
  try {
    await offline.setOfflineMode(on);
  } catch (err) {
    setStatus(`Offline map: ${err.message}. Reload and try again.`);
    syncOfflineUi();
    return;
  }
  state.offlineMap = on; // off by default
  saveState();
  syncOfflineUi();
  offlineErrors = 0;
  updateRoad();
  if (!quiet) showToast(on ? 'Offline map: using only what is saved on this device' : 'Back online');
  if (on) offline.keepStorage();
  if (mapReady) { // draw again with the new mode: saved tiles appear, missing ones stop being retried
    for (const id of ['osm', 'terrain-dem']) map.getSource(id)?.reload?.();
  }
  refreshOfflineStats();
}

async function startOffline() {
  const reg = await offline.register();
  if (!reg) {
    if (offlineOn()) { state.offlineMap = false; saveState(); }
    syncOfflineUi();
    return;
  }
  // The worker remembers the mode too, but the page's own setting wins, so both always agree.
  try { if (offlineOn() !== (await offline.getOfflineMode())) await offline.setOfflineMode(offlineOn()); } catch { /* the worker starts on the next load */ }
  syncOfflineUi();
}

// ---------- road name ----------
// Under the menu bar: the name of the road I am on, or the one the person I am following is on.
// Nothing is shown when there is no road close enough, no network, or the position is too rough.

let roadLast = null;
let roadBusy = false;
let roadShownFor = null;

function hideRoad() {
  roadShownFor = null;
  $('#road').hidden = true;
}

/** Whose road to name: the person being followed, otherwise me. */
function roadSubject() {
  const c = state?.contacts[follow.target];
  if (c) {
    const pt = followedPoint();
    return pt ? { id: c.id, lat: pt.lat, lon: pt.lon, acc: c.pos?.acc ?? null } : null;
  }
  return myPos ? { id: 'me', lat: myPos.lat, lon: myPos.lon, acc: myPos.acc } : null;
}

/** Road sequences saved on this device (the service worker keeps every answer), read back for offline use. */
const savedRoads = new Map(); // sequence id -> segments
async function readSavedRoads() {
  if (typeof caches === 'undefined' || !(await caches.has('rope-road-v1'))) return [];
  const cache = await caches.open('rope-road-v1');
  for (const req of await cache.keys()) {
    const id = /\/veglenkesekvenser\/segmentert\/(\d+)/.exec(req.url)?.[1];
    if (!id || savedRoads.has(id)) continue;
    try { savedRoads.set(id, await (await cache.match(req, { ignoreVary: true })).json()); } catch { /* unreadable: skip */ }
  }
  return [...savedRoads].map(([id, segments]) => ({ id, segments }));
}

/**
 * The road at a position: from the service when there is a network, otherwise (airplane mode, Offline map,
 * or a service that cannot be reached) from the roads already saved here, which covers any spot on a road
 * looked at before. Throws if neither can answer.
 */
async function findRoad(lat, lon, radius = undefined, opts = {}) {
  let failure = null;
  if (offlineOn()) failure = new Error('Offline map is on and this road is not saved');
  else {
    try { return await lookupRoad(lat, lon, radius, opts); } catch (err) { failure = err; }
  }
  const local = nearestSaved(await readSavedRoads(), lat, lon, radius, opts);
  if (local) return local;
  throw failure;
}

async function updateRoad() {
  if (inspectOn) return; // a tapped road is on show
  const who = roadSubject();
  if (!who) return hideRoad(); // offline, a saved answer may still be there; if not, the lookup fails quietly
  if (roadShownFor !== null && roadShownFor !== who.id) hideRoad(); // never show the previous person's road
  if (roadBusy || !shouldLookup(roadLast, Date.now(), who, haversineM)) return;
  roadBusy = true;
  roadLast = { lat: who.lat, lon: who.lon, at: Date.now(), id: who.id };
  try {
    const name = (await findRoad(who.lat, who.lon, undefined, { needLabel: true }))?.label ?? null;
    if (roadSubject()?.id !== who.id) return; // the map moved on to someone else meanwhile
    if (name) { $('#road').textContent = name; $('#road').hidden = false; roadShownFor = who.id; }
    else hideRoad();
  } catch {
    if (roadShownFor === who.id) hideRoad(); // an old name could be wrong by now
  } finally {
    roadBusy = false;
  }
}

// ---------- road info: the ? button ----------
// Tap ?, then a spot on the map. If a road is there its name shows in the pill under the menu bar, with
// a see-through card of facts and the road drawn on the map. Tap ? again to leave and go back to the
// road I am on.

let inspectOn = false;
let inspectSeq = 0;

function clearInspect() {
  $('#road-info').hidden = true;
  map?.getSource('inspect-road')?.setData({ type: 'FeatureCollection', features: [] });
}

function setInspect(on) {
  inspectOn = on;
  inspectSeq++;
  document.body.classList.toggle('inspecting', on);
  $('#inspect').setAttribute('aria-pressed', String(on));
  clearInspect();
  hideRoad();
  if (on) showToast('Tap a spot on the map to see the road');
  else { roadLast = null; updateRoad(); }
}

async function inspectAt(lat, lon) {
  const mine = ++inspectSeq;
  const radius = tapRadiusM(map.getZoom(), lat);
  clearInspect();
  map.getSource('inspect-road')?.setData({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: {} });
  $('#road').textContent = 'Looking…';
  $('#road').hidden = false;
  let result;
  try {
    result = await findRoad(lat, lon, radius, { info: true, timeoutMs: 10000 });
  } catch (err) {
    if (mine !== inspectSeq) return;
    hideRoad();
    showToast(offlineOn() || navigator.onLine === false ? 'No saved road information here' : 'Could not get road information. Try again.');
    log.app('warn', `road info: ${err.message}`);
    return;
  }
  if (mine !== inspectSeq) return; // another tap, or the tool was switched off, meanwhile
  if (!result) {
    hideRoad();
    showToast('No road here');
    return;
  }
  $('#road').textContent = result.title;
  const card = $('#road-info');
  card.replaceChildren();
  const h = document.createElement('h4');
  h.textContent = result.title;
  card.append(h);
  for (const [k, v] of result.rows) {
    const row = document.createElement('div');
    row.className = 'ri-row';
    const a = document.createElement('span'); a.textContent = k;
    const b = document.createElement('b'); b.textContent = v;
    row.append(a, b);
    card.append(row);
  }
  card.hidden = false;
  map.getSource('inspect-road')?.setData({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: result.lines }, properties: {} },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: {} },
  ] });
}

// ---------- zones ----------
// An admin defines "no fly" zones (keep out) and "green field" zones (stay in) as circles, by tapping the
// map, using their position, or an address with a perimeter. A zone is for everyone they are admin over,
// or for chosen people. The zones that apply to a person are signed and sent to that person's phone,
// where they are shown and checked, and cannot be removed while that admin holds the rights.
// Each zone shows faintly in red or green; it grows stronger as the person nears a no fly zone, and a
// warning covers the width of the screen. The admin sees the same for the people they watch over.

const myZones = () => (state.zones ??= []);
const adminsOverMe = () => activeContacts().filter((c) => c.adminOverMe);
const myWards = () => activeContacts().filter((c) => c.youAdminThem);
const zoneInfo = (z) => `${z.kind === 'no' ? 'No fly' : 'Green field'} · ${z.r >= 1000 ? `${(z.r / 1000).toFixed(z.r % 1000 ? 1 : 0)} km` : `${z.r} m`}`;

function renderZones() {
  if (!state || !mapReady) return;
  const features = [];
  const alerts = [];
  // zones my admins set for me, checked against my position
  const given = adminsOverMe().flatMap((a) => (a.zones ?? []).map((z) => ({ ...z, id: `${a.id}:${z.id}` })));
  const vis = (z) => visibilityOf(state.zoneVis, z.kind);
  for (const z of given) features.push({ zone: z, strength: myPos ? standing(z, myPos).strength : 0, visibility: vis(z) });
  if (myPos) for (const w of warnings(given, myPos)) alerts.push({ w, who: null });
  // zones I set, checked against where the people they apply to are
  const level = new Map();
  for (const c of myWards()) {
    const set = zonesFor(myZones(), c);
    const pos = c.pos && !isStale(c.pos) && seeingThem(c) ? c.pos : null;
    if (!set.length || !pos) continue;
    for (const z of set) level.set(z.id, Math.max(level.get(z.id) ?? 0, standing(z, pos).strength));
    for (const w of warnings(set, pos)) alerts.push({ w, who: label(c) });
  }
  for (const z of myZones()) {
    const n = normalizeZone(z);
    if (n) features.push({ zone: n, strength: level.get(z.id) ?? 0, visibility: vis(n) });
  }
  map.getSource('zones')?.setData(zoneFeatures(features));
  showZoneAlert(alerts);
}

const LEVEL_RANK = { danger: 0, warn: 1, note: 2 };
function showZoneAlert(alerts) {
  const pill = $('#zone-pill');
  if (!alerts.length) { pill.hidden = true; return; }
  alerts.sort((a, b) => LEVEL_RANK[a.w.level] - LEVEL_RANK[b.w.level] || a.w.metres - b.w.metres);
  const top = alerts[0];
  pill.dataset.level = top.w.level;
  pill.dataset.kind = top.w.zone.kind;
  pill.replaceChildren(document.createTextNode(`${top.w.level === 'danger' ? '⚠ ' : ''}${warningText(top.w, top.who)}`));
  if (alerts.length > 1) {
    const more = document.createElement('small');
    more.textContent = `+ ${alerts.length - 1} more warning${alerts.length > 2 ? 's' : ''}`;
    pill.append(more);
  }
  pill.hidden = false;
}

/** The zones sent to one person: signed by me, kept so it can be sent again until it has arrived. */
async function sendZones(c) {
  if (!c.youAdminThem) return;
  const set = zonesFor(myZones(), c);
  if (c.zonesOut ? sameZones(c.zonesOut.zones, set) : set.length === 0) return;
  const ts = Math.max(Date.now(), (c.zonesOut?.ts ?? 0) + 1);
  const sig = await signObj(keys.ecdsa, zonesPayload(ts, set));
  c.zonesOut = { ts, zones: set, sig };
  saveState();
  await sendPair(c, { t: 'zones', ts, zones: toWire(set), sig });
}
const sendZonesToAll = () => Promise.all(myWards().map((c) => sendZones(c)));

// ----- the Zones panel -----

function renderZonesPanel() {
  if (!state) return;
  for (const kind of ['no', 'green']) {
    const el = $(`#zvis-${kind}`);
    if (document.activeElement !== el) el.value = String(Math.round(visibilityOf(state.zoneVis, kind) * 100));
  }
  const given = adminsOverMe().flatMap((a) => (a.zones ?? []).map((z) => ({ z, a })));
  $('#zones-assigned-box').hidden = given.length === 0;
  $('#zones-assigned').innerHTML = given.map(({ z, a }) => `
    <li data-focus="${esc(z.id)}" data-admin="${esc(a.id)}"><i class="zone-dot ${z.kind}"></i>
      <div class="who"><div class="name">${esc(z.name || KINDS[z.kind])}</div><div class="muted small">${esc(zoneInfo(z))} · set by ${esc(label(a))}</div></div>
      <span class="chip lock">Locked</span></li>`).join('');
  const zs = myZones();
  const wards = myWards();
  $('#zones-none').hidden = zs.length > 0 && wards.length > 0;
  $('#zones-none').textContent = !wards.length
    ? 'You are not admin over anyone yet. Ask someone under People to be their admin; zones you set here apply once they approve.'
    : 'No zones yet.';
  $('#zone-list').innerHTML = zs.map((z) => {
    const names = z.scope === 'all' ? 'everyone I am admin over' : (z.who ?? []).map((id) => (state.contacts[id] ? label(state.contacts[id]) : null)).filter(Boolean).join(', ') || 'nobody';
    return `<li data-focus="${esc(z.id)}"><i class="zone-dot ${z.kind}"></i>
      <div class="who"><div class="name">${esc(z.name || KINDS[z.kind])}</div><div class="muted small">${esc(zoneInfo(z))} · ${esc(names)}</div></div>
      <div class="actions"><button class="ghost" data-zone-edit="${esc(z.id)}">Edit</button><button class="ghost danger" data-zone-del="${esc(z.id)}">Delete</button></div></li>`;
  }).join('');
  $('#zone-add').disabled = zs.length >= MAX_ZONES;
  const n = zs.length, g = given.length;
  $('#zones-summary').textContent = n || g
    ? [n ? `${n} zone${n > 1 ? 's' : ''} set by you` : '', g ? `${g} set for you by an admin` : ''].filter(Boolean).join(' · ')
    : 'Keep people out of an area, or in one. For people you are admin over.';
}

function flyToZone(z) {
  const dLat = (z.r / 6371000) * (180 / Math.PI) * 1.3;
  const dLon = dLat / Math.max(0.01, Math.cos((z.lat * Math.PI) / 180));
  setFollow(dragged(follow));
  map.fitBounds([[z.lon - dLon, z.lat - dLat], [z.lon + dLon, z.lat + dLat]], { padding: 50, maxZoom: 17, duration: 700 }, APP_MOVE);
}

// ----- the zone form -----

let draft = null;            // the zone being made or edited: { id|null, kind, name, lat, lon, r, scope, who: [], label }
let zonePicking = false;
const CHIPS = [100, 250, 500, 1000, 2500];

function renderDraft() {
  const src = map?.getSource('zone-draft');
  if (!src) return;
  if (!draft || draft.lat == null) { src.setData({ type: 'FeatureCollection', features: [] }); return; }
  const z = normalizeZone({ id: 'draft', kind: draft.kind, lat: draft.lat, lon: draft.lon, r: Math.max(MIN_R, Number(draft.r) || MIN_R) });
  src.setData({ type: 'FeatureCollection', features: [
    ...(z ? zoneFeatures([{ zone: z }]).features : []),
    { type: 'Feature', geometry: { type: 'Point', coordinates: [draft.lon, draft.lat] }, properties: {} },
  ] });
}

function syncZoneForm() {
  if (!draft) return;
  document.querySelectorAll('input[name="zone-kind"]').forEach((r) => { r.checked = r.value === draft.kind; });
  $('#zone-kind-help').textContent = draft.kind === 'no'
    ? 'Red. A warning shows when someone nears or enters it.'
    : 'Green. A warning shows when someone leaves it, or is outside every green zone.';
  $('#zone-name').value = draft.name;
  $('#zone-radius').value = draft.r;
  $('#zone-slider').value = Math.min(5000, Math.max(50, draft.r));
  $('#zone-where').textContent = draft.lat == null ? 'No place chosen yet.' : `${draft.label ? `${draft.label} · ` : ''}${draft.lat.toFixed(5)}, ${draft.lon.toFixed(5)}`;
  document.querySelectorAll('input[name="zone-scope"]').forEach((r) => { r.checked = r.value === draft.scope; });
  const wards = myWards();
  const who = $('#zone-who');
  who.hidden = draft.scope !== 'some';
  who.innerHTML = wards.length
    ? wards.map((c) => `<label><input type="checkbox" value="${esc(c.id)}"${draft.who.includes(c.id) ? ' checked' : ''}><span>${esc(label(c))}</span></label>`).join('')
    : '<p class="muted small">You are not admin over anyone yet.</p>';
  $('#zone-chips').innerHTML = CHIPS.map((m) => `<button type="button" class="tinted" data-chip="${m}">${m >= 1000 ? `${m / 1000} km` : `${m} m`}</button>`).join('');
  renderDraft();
}

function openZoneForm(zone = null) {
  draft = zone
    ? { id: zone.id, kind: zone.kind, name: zone.name, lat: zone.lat, lon: zone.lon, r: zone.r, scope: zone.scope ?? 'all', who: [...(zone.who ?? [])], label: '' }
    : { id: null, kind: 'no', name: '', lat: null, lon: null, r: 500, scope: 'all', who: [], label: '' };
  $('#zone-form').hidden = false;
  $('#zone-add').hidden = true;
  $('#zone-error').hidden = true;
  $('#zone-address').value = '';
  $('#zone-results').hidden = true;
  syncZoneForm();
  if (draft.lat != null) flyToZone(draft);
}

function closeZoneForm() {
  draft = null;
  zonePicking = false;
  document.body.classList.remove('zone-picking');
  $('#zone-form').hidden = true;
  $('#zone-add').hidden = false;
  renderDraft();
}

function placeZone(lat, lon) {
  zonePicking = false;
  document.body.classList.remove('zone-picking');
  if (!draft) return;
  Object.assign(draft, { lat, lon, label: '' });
  openPanel('zones');
  syncZoneForm();
}

function setDraftRadius(r) {
  if (!draft) return;
  draft.r = Math.min(MAX_R, Math.max(MIN_R, Math.round(Number(r) || MIN_R)));
  $('#zone-radius').value = draft.r;
  $('#zone-slider').value = Math.min(5000, Math.max(50, draft.r));
  renderDraft();
}

async function findAddress() {
  const text = $('#zone-address').value;
  const list = $('#zone-results');
  list.hidden = false;
  list.innerHTML = '<li class="none">Searching…</li>';
  try {
    const places = await findPlaces(text);
    list.innerHTML = places.length
      ? places.map((p, i) => `<li><button type="button" data-place="${i}">${esc(p.label)}</button></li>`).join('')
      : '<li class="none">No match. Try street, number and town.</li>';
    list.places = places;
  } catch (err) {
    list.innerHTML = '<li class="none">The address search cannot be reached. Pick on the map instead.</li>';
    log.app('warn', `address search: ${err.message}`);
  }
}

function saveZone() {
  const err = (t) => { $('#zone-error').textContent = t; $('#zone-error').hidden = false; };
  if (!draft) return;
  draft.name = $('#zone-name').value.trim();
  if (draft.lat == null) return err('Choose a place: tap the map, use your position, or find an address.');
  if (!(draft.r >= MIN_R && draft.r <= MAX_R)) return err(`The perimeter must be between ${MIN_R} m and ${MAX_R / 1000} km.`);
  if (draft.scope === 'some' && draft.who.length === 0) return err('Choose who it is for, or pick everyone.');
  const zones = myZones();
  const id = draft.id ?? newZoneId(zones.map((z) => z.id));
  const zone = { id, kind: draft.kind, name: draft.name || `${KINDS[draft.kind]} ${zones.length + 1}`, lat: draft.lat, lon: draft.lon, r: draft.r, scope: draft.scope, who: draft.scope === 'some' ? draft.who : [] };
  if (!normalizeZone(zone)) return err('That zone is not valid.');
  const i = zones.findIndex((z) => z.id === id);
  if (i >= 0) zones[i] = zone; else zones.push(zone);
  saveState();
  closeZoneForm();
  renderZonesPanel();
  renderZones();
  sendZonesToAll();
}

// ---------- distances ----------// ---------- distances ----------
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
const APP_MOVE = { programmatic: true }; // event data on every move the app starts itself, so a zoom/drag without it is the user's
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

/** Where everyone else I can currently see is: each contact with a fresh, permitted position. */
function othersPoints() {
  const pts = [];
  for (const c of activeContacts()) {
    if (c.pos && !isStale(c.pos) && seeingThem(c)) pts.push([c.pos.lon, c.pos.lat]);
  }
  return pts;
}

/**
 * "All": follow ME, and zoom out just far enough that everyone else is in view. The bounds are
 * mirrored around my position, so I stay in the middle as people and I move. It runs again on every
 * update and when the window is resized. The user leaves it by dragging the map or zooming it.
 */
function fitEveryone({ force = false } = {}) {
  if (!map || !myPos) return;
  const me = [myPos.lon, myPos.lat];
  const others = othersPoints();
  const size = map.getCanvas();
  const key = `all|${[me, ...others].map((p) => p.map((v) => v.toFixed(5)).join(',')).join(';')}|${sheetPadding()}|${size.clientWidth}x${size.clientHeight}`;
  if (!force && key === lastFollowed) return;
  if (!force && map.isMoving() && !programmaticMove) return; // don't fight the user's gesture
  lastFollowed = key;

  const bottom = sheetPadding();
  const none = { top: 0, left: 0, right: 0, bottom: 0 };
  if (!others.length) {
    programmaticMove = true;
    map.easeTo({ center: me, zoom: Math.max(map.getZoom(), 15), padding: { ...none, bottom }, ...(terrainOn() ? { pitch: 0 } : {}), duration: 600 }, APP_MOVE);
    return;
  }
  const camera = map.cameraForBounds(symmetricBounds(me, others), {
    padding: { top: 100, left: 60, right: 60, bottom: 90 + bottom },
    maxZoom: 17,
  });
  if (!camera) return;
  // Already there? Then don't start another animation for a sub-pixel change.
  const here = map.project(map.getCenter());
  const there = map.project(camera.center);
  if (!force && Math.hypot(here.x - there.x, here.y - there.y) < 1 && Math.abs(map.getZoom() - camera.zoom) < 0.01) return;
  programmaticMove = true;
  // "All" is a view from above (the fit is worked out for a flat camera), so the tilt is lifted while the terrain is on.
  map.easeTo({ center: camera.center, zoom: camera.zoom, padding: none, ...(terrainOn() ? { pitch: 0 } : {}), duration: 500 }, APP_MOVE);
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
  }, APP_MOVE);
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
  updateRoad();
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
  gpsInfo.lastError = `${err.code}: ${err.message}`;
  log.gps('error', `error ${err.code}: ${err.message}`);
  setStatus('GPS: no fix');
  showGpsBanner(GPS_HELP[err.code] ?? err.message);
  if (err.code === 1) stopGps(); // denied: stop retrying until the user taps Enable location
}

function onFix(p) {
  $('#gps-banner').hidden = true;
  const { latitude: lat, longitude: lon, accuracy, altitude } = p.coords;
  const firstFix = myPos === null;
  myPos = { lat, lon, acc: accuracy };
  gpsInfo.fixes++;
  gpsInfo.lastFixAt = Date.now();
  if (firstFix) log.gps('info', `first fix, ±${Math.round(accuracy)} m`);
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
  else if (follow.target === 'all') fitEveryone(); // still me-centred: my position changed
  if (state && accuracy <= 100) recordTrail('me', { lat, lon, ts: Date.now() }); // skip very rough fixes
  maybeSendPosition();
  maybeUpdateTerrain();
  updateRoad();
  renderZones();
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

// The relay already retries a few times, so a failure here means a real outage. Say so once
// (not once per contact and per position), in words that match the cause.
let relayDown = false, relayWarnedAt = 0, relayPausedUntil = 0;
const RELAY_ERROR_TEXT = {
  offline: 'No connection to the rendezvous server. Retrying…',
  rate: 'The rendezvous server is busy (rate limit). Retrying…',
  server: 'The rendezvous server refused a message',
};
function relayFailed(err) {
  relayDown = true;
  // Rate-limited: hold back position updates until the server says it's fine (direct links carry on).
  if (err?.kind === 'rate') relayPausedUntil = Date.now() + (err.retryAfterMs || 30_000);
  if (Date.now() - relayWarnedAt < 60_000) return;
  relayWarnedAt = Date.now();
  const kind = navigator.onLine === false ? 'offline' : err?.kind;
  setStatus(RELAY_ERROR_TEXT[kind] ?? RELAY_ERROR_TEXT.offline);
}
function relayOk() {
  if (!relayDown) return;
  relayDown = false;
  relayWarnedAt = 0;
  setStatus(myPos ? 'GPS live' : 'Connected to the rendezvous server');
}

async function publish(topic, obj, aes) {
  try {
    await relay.publish(topic, aes ? await seal(aes, obj) : JSON.stringify(obj));
    relayOk();
    return true;
  } catch (err) {
    relayFailed(err);
    return false;
  }
}

// Every pair message carries my id (the relay echoes my own messages back on the shared topic) and
// a timestamp (replay protection). While the direct link is open, everything goes over it and the
// relay is not used at all: its stream is paused. Only when there is no direct link do messages go
// through the relay, sealed with the pair key, and the direct link is re-established through it.
async function sendPair(c, obj) {
  const ch = channels.get(c.id);
  if (!ch) return true;
  const msg = { ts: Date.now(), ...obj, fr: state.identity.id };
  const link = links.get(c.id);
  const t = trafficOf(c.id);
  if (obj.t !== 'rtc' && link?.open && link.send(await seal(ch.aes, msg))) {
    t.txDirect++;
    return true;
  }
  if (obj.t === 'pos' && Date.now() < relayPausedUntil) return false;
  t.txRelay++;
  return publish(ch.topic, msg, ch.aes);
}

// Sends my current state to a contact over whatever path is in use now: on pairing, when the direct
// link opens and when it falls back to the relay (the other side may have missed something).
async function syncContact(c) {
  await sendPair(c, { t: 'vis', v: state.visible });
  await resendAdmin(c);
  lastSentTo.delete(c.id);
  maybeSendPosition();
}

// ---------- admin rights, with the subject's consent ----------
// The would-be admin sends a signed request. The subject's app shows it and only an approval
// (signed by the subject, over the request) makes it count. Requests, answers and releases are
// stored and re-sent until delivered, so it works even if the other phone is offline for a while.

async function requestAdmin(c, on) {
  const ts = Date.now();
  const obj = adminPayload(on, ts);
  const sig = await signObj(keys.ecdsa, obj);
  if (on) Object.assign(c, { adminReq: { ts, sig }, adminRelease: null, adminDeclined: null });
  else Object.assign(c, { adminReq: null, youAdminThem: false, adminRelease: { ts, sig }, zonesOut: null });
  saveState();
  await sendPair(c, { ...obj, sig });
}

async function answerAdmin(c, ok) {
  const req = c.adminAsk;
  if (!req) return;
  const obj = adminAnswerPayload(ok, req);
  const sig = await signObj(keys.ecdsa, obj);
  Object.assign(c, { adminAsk: null, adminTs: req, adminAnswer: { ok, req, sig } });
  if (ok) c.adminOverMe = true;
  saveState();
  await sendPair(c, { ...obj, sig });
}

async function resendAdmin(c) {
  if (c.adminReask) { c.adminReask = false; await requestAdmin(c, true); return; } // from before consent
  if (c.adminReq) await sendPair(c, { ...adminPayload(true, c.adminReq.ts), sig: c.adminReq.sig });
  if (c.adminRelease) await sendPair(c, { ...adminPayload(false, c.adminRelease.ts), sig: c.adminRelease.sig });
  if (c.adminAnswer) await sendPair(c, { ...adminAnswerPayload(c.adminAnswer.ok, c.adminAnswer.req), sig: c.adminAnswer.sig });
  if (c.youAdminThem && c.zonesOut) await sendPair(c, { t: 'zones', ts: c.zonesOut.ts, zones: toWire(c.zonesOut.zones), sig: c.zonesOut.sig });
}

function maybeSendPosition(force = false) {
  if (!myPos) return;
  const now = Date.now();
  for (const c of activeContacts()) {
    if (!shouldSendPosition(me(), c)) continue;
    const every = links.get(c.id)?.open ? SEND_DIRECT_MS : SEND_EVERY_MS;
    if (!force && now - (lastSentTo.get(c.id) ?? 0) < every) continue;
    lastSentTo.set(c.id, now);
    sendPair(c, { t: 'pos', ts: now, lat: myPos.lat, lon: myPos.lon, acc: myPos.acc })
      .then((ok) => { if (!ok) lastSentTo.delete(c.id); }); // send the newest fix as soon as the next one arrives
  }
}

// Coming back from a dead zone or from the background: reopen dropped streams and direct links,
// and send where I am now.
function onNetworkBack() {
  if (!relay) return;
  relay.reconnect();
  for (const link of links.values()) link.kick();
  maybeSendPosition(true);
}

const pendingLinks = new Map(); // contact id -> a link made while pairing with QR codes, waiting for its contact

function openLink(c) {
  if (links.has(c.id) || !globalThis.RTCPeerConnection) return;
  const adopt = pendingLinks.get(c.id); // a direct link already made by the QR pairing
  pendingLinks.delete(c.id);
  const opts = {
    myId: state.identity.id,
    theirId: c.id,
    // While a QR code is being made, the offer or answer goes into the code instead of over the relay.
    signal: (obj) => (adopt?.qrCapture ? adopt.qrCapture(obj) : sendPair(c, { ...obj, ts: Date.now() })),
    onMessage: (text) => onPairMessage(c.id, text, 'direct'),
    log: logger(`p2p ${c.name}`),
    onChange: (isOpen) => {
      // Direct link up: stop using the relay for this contact. Down: listen on the relay again,
      // send through it, and let the link re-establish itself through it.
      const ch = channels.get(c.id);
      if (ch) { if (isOpen) relay.pause(ch.topic); else relay.resume(ch.topic); }
      if (!isOpen) linkLostAt.set(c.id, Date.now());
      if (isOpen && link.qrPaired) {
        link.qrPaired = false;
        link.offerer = isOfferer(state.identity.id, c.id); // from now on the usual roles
        link.attemptMs = 45_000;
        qrConnected(c);
      }
      syncContact(c);
      renderContacts();
      renderConn();
    },
  };
  const link = adopt ? Object.assign(adopt, opts) : new PeerLink(opts);
  links.set(c.id, link);
  if (!adopt) link.kick();
}

function closeLink(id) {
  links.get(id)?.close();
  links.delete(id);
  lastSentTo.delete(id);
}

async function openChannel(c) {
  const ch = await channelFromSecret(c.secret);
  channels.set(c.id, ch);
  relay.subscribe(ch.topic, (text) => onPairMessage(c.id, text, 'relay'));
  openLink(c);
}

async function onPairMessage(id, text, via = 'relay') {
  const c = state.contacts[id];
  const ch = channels.get(id);
  if (!c || !ch) return;
  const msg = await open(ch.aes, text);
  if (!msg || msg.fr === state.identity.id) return; // my own message, echoed back by the relay
  const t = trafficOf(id);
  if (via === 'direct') t.rxDirect++; else t.rxRelay++;
  t.lastRx = Date.now();
  if (msg.t === 'rtc') {
    if (Math.abs(Date.now() - Number(msg.ts)) <= SIGNAL_MAX_AGE_MS) links.get(id)?.onSignal(msg);
    return;
  }
  let adminVerified = false;
  if (msg.t === 'admin') {
    adminVerified = await verifyObj(c.s, adminPayload(msg.on, msg.ts), msg.sig);
    // A request I already answered, sent again: they may have missed my answer.
    if (adminVerified && msg.on === true && c.adminAnswer?.req === Number(msg.ts)) await resendAdmin(c);
  } else if (msg.t === 'adminok') {
    adminVerified = await verifyObj(c.s, adminAnswerPayload(msg.ok, Number(msg.req)), msg.sig);
  } else if (msg.t === 'zones') {
    adminVerified = await verifyObj(c.s, { t: 'zones', ts: msg.ts, zones: msg.zones }, msg.sig);
  }
  const patch = applyPairMessage(c, msg, { adminVerified });
  if (!Object.keys(patch).length) return;
  if (patch.adminAsk) showToast(`${label(c)} asks to be your admin. See People.`);
  if ('youAdminThem' in patch) showToast(patch.youAdminThem ? `${label(c)} approved: you are now their admin.` : `${label(c)} declined your admin request.`);
  if (msg.t === 'admin' && msg.on !== true && patch.adminOverMe === false) c.adminAnswer = null; // released
  Object.assign(c, patch);
  if (patch.zones) { renderZonesPanel(); if (patch.zonesTs) showToast(patch.zones.length ? `${label(c)} updated your zones` : `${label(c)} cleared your zones`); }
  if (patch.youAdminThem) sendZones(c); // newly approved: send the zones that apply to them
  if (patch.pos) { recordTrail(id, { lat: patch.pos.lat, lon: patch.pos.lon, ts: patch.pos.ts }); if (follow.target === id) updateRoad(); }
  if ('theirVisible' in patch && !seeingThem(c)) clearTrail(id); // they stopped sharing: their trail goes too
  saveState();
  renderAll();
}

async function activate(c) {
  c.secret = await deriveSecret(keys.ecdh, c.e);
  c.status = 'active';
  await openChannel(c);
  saveState();
  await syncContact(c); // a new contact sees me straight away, not at my next GPS fix
  renderAll();
}

// ---------- pairing with a number (QR code or read aloud), made safe by a PAKE ----------
// One person shows a code (digits and a QR code). The other scans it or types it in. A PAKE
// (CPace, see pake.js) over the relay turns the code into a shared key, which carries both
// contact cards; then the usual per-contact key (ECDH) takes over. The relay can't learn the code
// or try codes offline; each wrong guess needs a live exchange and the code dies after 3 tries.

let pairing = null; // { code, topic, expires, timer, tick, host } while I'm showing a code
const nowSince = () => String(Math.floor(Date.now() / 1000) - 5); // only messages from now on

function stopPairing(text, isError = false) {
  if (!pairing) return;
  const { host, topic } = pairing;
  pairing = null; // first, so the host's rejection below isn't reported again
  host.cancel();
  relay.unsubscribe(topic);
  clearTimeout(host.timer);
  clearInterval(host.tick);
  $('#pair-show').hidden = true;
  $('#pair-new').hidden = false;
  $('#pair-qr').innerHTML = '';
  if (text) showAddMessage(text, isError);
}

function showAddMessage(text, isError = false) {
  const out = $('#add-error');
  out.hidden = false;
  out.classList.toggle('error', isError);
  out.textContent = text;
}

// Adds (or re-activates) the person behind a card received through the PAKE.
async function addPaired(card) {
  const id = await fingerprint(card.e);
  if (id === state.identity.id) throw new Error('That is your own code');
  const existing = state.contacts[id];
  if (existing?.status === 'active') return existing;
  const c = { ...(existing ?? {}), id, name: card.n, e: card.e, s: card.s, status: 'pending', adminConsent: 2 };
  state.contacts[id] = c;
  await activate(c);
  return c;
}

// The relay as the PAKE's transport: plain JSON (it holds only public values, MACs and ciphertext).
function pakeTransport(topic, party) {
  relay.subscribe(topic, (text) => {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    party.handle(m).catch((err) => log.pair('warn', `bad message: ${err.message}`));
  }, nowSince());
}
const pakeSend = (topic) => async (obj) => {
  if (!(await publish(topic, obj))) throw new Error('Couldn’t reach the rendezvous server. Try again.');
};

async function startPairing() {
  stopPairing();
  $('#add-error').hidden = true;
  const code = newCode();
  const topic = pairTopic(code);
  const host = new PakeHost({ code, card: { card: encodeCard(cardOf(state.identity)) }, send: pakeSend(topic) });
  const expires = Date.now() + CODE_TTL_MS;
  pairing = { code: code.code, topic, expires, host };
  host.timer = setTimeout(() => stopPairing('The code expired. Show a new one when you’re ready.'), CODE_TTL_MS);
  host.tick = setInterval(() => {
    $('#pair-wait').textContent = `Waiting for them… (${Math.max(0, Math.ceil((expires - Date.now()) / 60_000))} min left)`;
  }, 15_000);
  $('#pair-new').hidden = true;
  $('#pair-show').hidden = false;
  $('#pair-code').textContent = code.code;
  $('#pair-wait').textContent = 'Waiting for them… (10 min left)';
  const { default: qrcode } = await import('./vendor/qrcode.js');
  const qr = qrcode(0, 'M');
  qr.addData(qrText(code), 'Alphanumeric');
  qr.make();
  if (pairing?.host === host) $('#pair-qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
  pakeTransport(topic, host);
  log.pair('info', 'showing a code, waiting for the other person');
  host.done.then(async ({ card }) => {
    stopPairing(); // the code works once
    const c = await addPaired(decodeCard(card));
    log.pair('info', `paired with ${c.name}`);
    showAddMessage(`Paired with ${c.name}.`);
    renderAll();
  }).catch((err) => {
    if (pairing?.host !== host) return; // cancelled or expired: already handled
    log.pair('warn', err.message);
    stopPairing(err.message, true);
  });
}

// The other side: a scanned or typed code.
async function joinWithCode(code) {
  showAddMessage('Connecting…');
  const topic = pairTopic(code);
  const joiner = new PakeJoiner({ code, card: { card: encodeCard(cardOf(state.identity)) }, send: pakeSend(topic) });
  pakeTransport(topic, joiner);
  log.pair('info', 'joining with a code');
  try {
    // A wrong code shows at once (the other phone's proof doesn't match), but wait a few seconds
    // more in case that answer came from someone else pairing on the same 2-digit nameplate.
    const wrong = new Promise((r) => { joiner.onWrongAnswer = () => setTimeout(() => r(null), 4_000); });
    await joiner.start();
    const res = await Promise.race([joiner.done, wrong, new Promise((r) => setTimeout(() => r(null), 45_000))]);
    if (!res) {
      log.pair('warn', joiner.wrongAnswers ? 'wrong code' : 'no answer to the code');
      throw new Error(joiner.wrongAnswers
        ? 'Wrong code. Check the digits, or ask them to show a new code.'
        : 'No answer. Check the code (it works once, for 10 minutes) and that they are still showing it.');
    }
    const c = await addPaired(decodeCard(res.card));
    log.pair('info', `paired with ${c.name}`);
    showAddMessage(`Paired with ${c.name}.`);
    renderAll();
  } finally {
    joiner.cancel();
    relay.unsubscribe(topic);
  }
}

// ---------- scanning a code with the camera ----------
let scan = null; // { stream, timer }

/** Opens the camera and calls onText(text) for each code it reads, until it returns true. */
async function startScan(onText, prompt = 'Point the camera at the code on the other phone') {
  stopScan();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser can’t use the camera. Type the number instead.');
  const { default: jsQR } = await import('./vendor/jsqr.js');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  const video = $('#scan-video');
  video.srcObject = stream;
  $('#scan-text').textContent = prompt;
  $('#scan').hidden = false;
  await video.play().catch(() => {});
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  scan = { stream };
  scan.timer = setInterval(() => {
    if (!video.videoWidth) return;
    const k = Math.min(1, 1100 / Math.max(video.videoWidth, video.videoHeight)); // big enough for a dense code
    canvas.width = Math.round(video.videoWidth * k);
    canvas.height = Math.round(video.videoHeight * k);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const found = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
    if (!found || !onText(found.data)) return;
    stopScan();
    if (navigator.vibrate) navigator.vibrate(30);
  }, 250);
}

function stopScan() {
  if (!scan) return;
  clearInterval(scan.timer);
  for (const t of scan.stream.getTracks()) t.stop();
  $('#scan-video').srcObject = null;
  $('#scan').hidden = true;
  scan = null;
}

// ---------- connecting with QR codes only ----------
// No rendezvous server. One phone shows an offer code and the other scans it; the second shows an answer
// code and the first scans it. See qrlink.js. The cards in the codes are seen by camera, in person, so they
// are authentic; the direct link opens over the local network.

let qrSession = null; // { role, link, sid, done }

function qrReset() {
  if (qrSession && !qrSession.done) { qrSession.link?.close(); pendingLinks.delete(qrSession.id); }
  qrSession = null;
  stopScan();
  $('#qr-link').hidden = true;
  $('#qr-open').hidden = false;
  $('#qr-choose').hidden = false;
  $('#qr-step').hidden = true;
  $('#qr-img').innerHTML = '';
}

function qrMessage(text, isError = false) {
  $('#qr-note').textContent = text;
  $('#qr-note').classList.toggle('error', isError);
}

async function qrShow(text, title, note, next) {
  const { default: qrcode } = await import('./vendor/qrcode.js');
  const qr = qrcode(0, 'L');
  qr.addData(text, 'Byte');
  qr.make();
  $('#qr-img').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  $('#qr-img').dataset.size = String(text.length);
  $('#qr-choose').hidden = true;
  $('#qr-step').hidden = false;
  $('#qr-title').textContent = title;
  qrMessage(note);
  $('#qr-next').hidden = !next;
  $('#qr-next').onclick = next ?? null;
}

/** A direct link that is not yet tied to a contact: its offer or answer goes into a code. */
function newQrLink(offerer) {
  if (!globalThis.RTCPeerConnection) throw new Error('This browser cannot make direct connections.');
  const link = new PeerLink({
    myId: state.identity.id, theirId: 'qr', signal: (obj) => link.qrCapture?.(obj), onMessage: () => {}, onChange: () => {},
    offerer, attemptMs: 5 * 60_000, log: logger('p2p qr'),
  });
  return link;
}

/** Adds the contact from a scanned card and gives it the link that was made for it. */
async function qrAdopt(card, link) {
  const id = await fingerprint(card.e);
  if (id === state.identity.id) throw new Error('That is your own code.');
  const existing = state.contacts[id];
  if (existing?.status === 'active' && existing.s !== card.s) throw new Error('That is not the same phone as your contact with this name. Nothing was changed.');
  link.qrPaired = true;
  link.theirId = id;
  pendingLinks.set(id, link);
  if (qrSession) qrSession.id = id;
  const c = await addPaired(card);
  if (pendingLinks.has(id)) { closeLink(id); openLink(c); } // already a contact: use this link instead of the old one
  return c;
}

function qrConnected(c) {
  if (qrSession) qrSession.done = true;
  clearTimeout(qrSession?.slow);
  qrReset();
  showAddMessage(`Connected with ${c.name}, directly. No server was used.`);
  log.pair('info', `connected with ${c.name} by QR codes`);
  renderAll();
}

async function qrStartHost() {
  $('#qr-choose').hidden = true;
  qrMessage('Preparing your code…');
  $('#qr-step').hidden = false;
  const link = newQrLink(true);
  qrSession = { role: 'host', link, done: false };
  const offer = new Promise((resolve, reject) => {
    link.qrCapture = (obj) => { if (obj.k === 'o') resolve(obj); };
    setTimeout(() => reject(new Error('Could not prepare the code. Is Wi-Fi on?')), 15_000);
  });
  link.kick();
  const o = await offer;
  link.qrCapture = null;
  qrSession.sid = o.sid;
  const text = encodeLink({ kind: 'o', card: cardOf(state.identity), sid: o.sid, d: o.d });
  await qrShow(text, 'Step 1: let them scan this', 'Hold your phone so they can scan it. When they have, they show you a code.', () => {
    qrMessage('Scan the code on their phone.');
    startScan((scanned) => {
      if (!looksLikeLink(scanned)) return false;
      let r;
      try { r = decodeLink(scanned, { expect: 'a' }); } catch (err) { qrMessage(err.message, true); return false; }
      if (r.sid !== qrSession?.sid) { qrMessage('That answer is for a different code. Start again.', true); return false; }
      qrFinishHost(r).catch((err) => { qrMessage(err.message, true); });
      return true;
    }, 'Scan the answer code on their phone').catch((err) => qrMessage(err.name === 'NotAllowedError' ? 'Camera access was refused.' : err.message, true));
  });
}

async function qrFinishHost(r) {
  const { link } = qrSession;
  qrMessage('Connecting…');
  $('#qr-step').hidden = false;
  const c = await qrAdopt(r.card, link);
  qrSession.slow = setTimeout(() => qrMessage('Still connecting. Both phones need to be on the same Wi-Fi, or one on the other’s hotspot.'), 20_000);
  await link.onSignal({ t: 'rtc', k: 'a', sid: r.sid, d: r.d });
  log.pair('info', `scanned ${c.name}'s answer`);
}

async function qrStartJoin() {
  $('#qr-choose').hidden = true;
  $('#qr-step').hidden = false;
  qrMessage('Scan the code on their phone.');
  qrSession = { role: 'join', link: null, done: false };
  await startScan((scanned) => {
    if (!looksLikeLink(scanned)) return false;
    let r;
    try { r = decodeLink(scanned, { expect: 'o' }); } catch (err) { qrMessage(err.message, true); return false; }
    qrFinishJoin(r).catch((err) => { qrMessage(err.message, true); log.pair('warn', err.message); });
    return true;
  }, 'Scan the first code on their phone');
}

async function qrFinishJoin(r) {
  qrMessage('Preparing the answer…');
  const link = newQrLink(false);
  qrSession.link = link;
  const answer = new Promise((resolve, reject) => {
    link.qrCapture = (obj) => { if (obj.k === 'a') resolve(obj); };
    setTimeout(() => reject(new Error('Could not prepare the answer. Is Wi-Fi on?')), 15_000);
  });
  const c = await qrAdopt(r.card, link);
  await link.onSignal({ t: 'rtc', k: 'o', sid: r.sid, d: r.d });
  const a = await answer;
  link.qrCapture = null;
  const text = encodeLink({ kind: 'a', card: cardOf(state.identity), sid: a.sid, d: a.d });
  qrSession.slow = setTimeout(() => qrMessage('Still connecting. Both phones need to be on the same Wi-Fi, or one on the other’s hotspot.'), 60_000);
  await qrShow(text, `Step 2: let ${c.name} scan this`, `You now have ${c.name} as a contact. Let them scan this code to finish the connection.`);
}

// ---------- connection status (green: direct, orange: via relay, red: none) ----------

const linkLostAt = new Map(); // contact id -> when its direct link went down
const RELAY_GRACE_MS = 8_000; // the relay stream reopening after a lost link counts as "via relay"

function connOf(c) {
  if (links.get(c.id)?.open) return 'direct';
  const ch = channels.get(c.id);
  const st = relay && ch ? relay.streamState(ch.topic) : null;
  const s = relay?.stats;
  const failing = s && s.lastErrorAt > s.lastOkAt && Date.now() - s.lastErrorAt < 60_000;
  if (navigator.onLine === false || failing) return 'none';
  if (st === 'open') return 'relay';
  return st === 'connecting' && Date.now() - (linkLostAt.get(c.id) ?? 0) < RELAY_GRACE_MS ? 'relay' : 'none';
}

const CONN_TEXT = { direct: 'direct', relay: 'via relay', none: 'no connection', idle: 'no contacts yet' };

let lastConnKey = '';
function renderConn() {
  const cs = activeContacts();
  const key = cs.map((c) => `${c.id}:${connOf(c)}`).join();
  if (key !== lastConnKey) { // someone's connection changed: their line in People says so at once
    if (lastConnKey) renderContacts();
    lastConnKey = key;
  }
  const rank = { none: 0, relay: 1, direct: 2 };
  const overall = cs.length ? cs.map(connOf).reduce((a, b) => (rank[b] < rank[a] ? b : a)) : 'idle';
  const el = $('#status');
  el.dataset.conn = overall;
  el.setAttribute('aria-label', `Connection: ${CONN_TEXT[overall]}. ${$('#status-text').textContent}`);
  el.title = `Connection: ${CONN_TEXT[overall]}`;
}

function connSummary() {
  const cs = activeContacts();
  if (!cs.length) return 'No contacts yet. Pair with someone under People.';
  return cs.map((c) => `${label(c)}: ${CONN_TEXT[connOf(c)]}`).join(' · ');
}

// ---------- rendering ----------

function renderMe() {
  $('#me-name').textContent = state.identity.name;
  $('#visible').checked = state.visible;
  $('#relay').value = state.relay;
  refreshOfflineStats();
  $('#fingerprint').textContent = state.identity.id.match(/.{1,4}/g).join(' ');
  const admins = activeContacts().filter((c) => c.adminOverMe).map(label);
  const notice = $('#admin-notice');
  notice.hidden = !admins.length;
  if (admins.length) notice.textContent = `${admins.join(', ')} can see you even when sharing is off. You approved this; only they can end it.`;
  $('#visible').disabled = false;
  const mt = traceOf('me');
  $('#trace-me').checked = mt.on;
  $('#trace-me-length').classList.toggle('off', !mt.on);
  renderMyLengthControl(mt);
  $('#trace-me-colors').innerHTML = swatchesHtml('me', mt.color);
}

// Requests waiting for my answer: someone asking to become my admin.
function renderRequests() {
  const reqs = Object.values(state.contacts).filter((c) => c.status === 'active' && c.adminAsk);
  const ul = $('#requests');
  ul.hidden = !reqs.length;
  const badge = $('#req-badge'); // so a request is noticed even while the map is showing
  badge.hidden = !reqs.length;
  badge.textContent = String(reqs.length);
  ul.innerHTML = reqs.map((c) => `
    <li class="contact request">
      <div class="who"><div class="name">${esc(label(c))} asks to be your admin</div>
      <div class="muted small">If you approve, ${esc(label(c))} sees your position even when you turn sharing off,
        and you can’t remove ${esc(label(c))} until they give it up. Only approve a parent or someone you fully trust.</div></div>
      <div class="contact-actions">
        <button class="primary" data-act="admin-yes" data-id="${esc(c.id)}">Approve</button>
        <button class="ghost danger" data-act="admin-no" data-id="${esc(c.id)}">Decline</button>
      </div>
    </li>`).join('');
}

function renderContacts() {
  const list = $('#contacts');
  // Live updates must not rebuild the list under a wheel that is being turned; try again a moment later.
  if (wheelIsBusy()) {
    clearTimeout(renderContactsRetry);
    renderContactsRetry = setTimeout(renderContacts, 750);
    return;
  }
  const all = Object.values(state.contacts).filter((c) => c.status === 'active').sort((a, b) => label(a).localeCompare(label(b)));
  if (!all.length) {
    list.innerHTML = '<li class="muted empty">No contacts yet. Tap “Pair with a code” and tell them the code, or enter the code they give you.</li>';
    return;
  }
  const kept = takeOpenWheel(); // the open wheel is carried across the redraw, so it keeps its place and focus
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
    status += ` · ${CONN_TEXT[connOf(c)]}`;
    if (c.adminDeclined && !c.youAdminThem) status += ' · declined your admin request';
    const lock = c.adminOverMe ? '<span class="chip lock">Admin set · locked</span>' : '';
    const adminBtn = c.adminOverMe ? '' : c.youAdminThem
      ? `<button class="ghost" data-act="admin" data-id="${id}" data-on="false">Remove my admin</button>`
      : c.adminReq
        ? `<button class="ghost" data-act="admin" data-id="${id}" data-on="false" title="Waiting for ${esc(label(c))} to approve">Admin asked · Cancel</button>`
        : `<button class="ghost" data-act="admin" data-id="${id}" data-on="true">Ask to be admin</button>`;
    const removeBtn = canRemoveContact(c)
      ? `<button class="ghost danger" data-act="remove" data-id="${id}">Remove</button>`
      : '<button class="ghost" disabled title="Locked by an admin">Remove</button>';
    const t = traceSettings(c.trace);
    // The length shows as a button; it opens two wheels (a number and a unit) right under the row.
    const lengths = `<button type="button" class="length-btn" data-act="wheel" data-id="${id}" aria-expanded="${wheelOpenFor === c.id}" aria-label="Trail length for ${esc(label(c))}: ${labelForLength(t.length)}">${labelForLength(t.length)}</button>`;
    // Length and colour can be set before the trail is switched on; they are dimmed while it is off.
    const traceRow = `<div class="trace-block${t.on ? '' : ' off'}">
        <div class="trace-row"><span>Trail</span>${lengths}<input type="checkbox" role="switch" data-trace-on data-id="${id}" aria-label="Show trail for ${esc(label(c))}"${t.on ? ' checked' : ''}></div>
      </div>
      ${wheelOpenFor === c.id ? `<div class="wheel-host" data-id="${id}"></div>` : ''}
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
  putBackOpenWheel(kept);
  mountContactWheels();
}

let renderContactsRetry = null;
let wheelOpenFor = null; // 'me', a contact id, or null: whose two wheels are open

/** Takes the open wheel (and where its two columns are scrolled, and which has focus) out of the list. */
function takeOpenWheel() {
  if (!wheelOpenFor || wheelOpenFor === 'me') return null;
  const root = document.querySelector(`#contacts .wheel-host[data-id="${CSS.escape(wheelOpenFor)}"] .wheel-picker`);
  if (!root) return null;
  const wheels = [...root.querySelectorAll('.wheel')];
  return { root, id: wheelOpenFor, tops: wheels.map((w) => w.scrollTop), focus: wheels.indexOf(document.activeElement) };
}

/** Puts the same wheel back into the redrawn row, scrolled and focused as it was. */
function putBackOpenWheel(kept) {
  if (!kept) return;
  const host = document.querySelector(`#contacts .wheel-host[data-id="${CSS.escape(kept.id)}"]`);
  if (!host) return;
  host.replaceChildren(kept.root);
  const wheels = [...kept.root.querySelectorAll('.wheel')];
  wheels.forEach((w, i) => { w.scrollTop = kept.tops[i]; });
  if (kept.focus >= 0) wheels[kept.focus].focus({ preventScroll: true });
}

function mountContactWheels() {
  for (const host of document.querySelectorAll('#contacts .wheel-host')) {
    if (host.firstChild) continue; // already holds the carried-over wheel
    const id = host.dataset.id;
    mountWheelPicker(host, {
      length: traceOf(id).length,
      label: `Trail length for ${label(state.contacts[id])}`,
      onChange: (length) => { resetWheelActivity(); setTrace(id, { length }); },
    });
  }
}

/** Me: the length is a button; it opens the two wheels under the row. */
function renderMyLengthControl(mt) {
  const open = wheelOpenFor === 'me';
  const btn = $('#trace-me-length-btn');
  btn.textContent = labelForLength(mt.length);
  btn.setAttribute('aria-expanded', String(open));
  const host = $('#trace-me-wheel');
  host.hidden = !open;
  if (!open) { host.replaceChildren(); return; }
  if (!host.firstChild) {
    mountWheelPicker(host, {
      length: mt.length,
      label: 'Length of my trail',
      onChange: (length) => { resetWheelActivity(); setTrace('me', { length }); },
    });
  }
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
  renderZones();
  renderZonesPanel();
}

async function onListClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const c = state.contacts[btn.dataset.id];
  if (!c) return;
  try {
    switch (btn.dataset.act) {
      case 'color': setTrace(c.id, { color: btn.dataset.color }); return; // setTrace saves and redraws
      case 'wheel': // open or close this person's trail-length wheels
        wheelOpenFor = wheelOpenFor === c.id ? null : c.id;
        renderContacts();
        return;
      case 'admin-yes':
        if (!confirm(`Let ${label(c)} see you even when sharing is off? You can’t undo this yourself.`)) return;
        await answerAdmin(c, true);
        break;
      case 'admin-no': await answerAdmin(c, false); break;
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
        if (on && !confirm(`Ask ${c.name} to make you their admin? If they approve, you see their position even when they turn sharing off.`)) return;
        await requestAdmin(c, on);
        break;
      }
      case 'remove':
        if (c.status === 'active' && !canRemoveContact(c)) return setStatus('An admin has set this. Only they can change it.');
        if (!confirm(`Remove ${c.name}?`)) return;
        if (channels.has(c.id)) { relay.unsubscribe(channels.get(c.id).topic); channels.delete(c.id); }
        closeLink(c.id);
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
const PANEL_TITLES = { people: 'People', route: 'Route', me: 'Me', zones: 'Zones' };
let openTab = null;

let closeTimer = null;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function openPanel(name) {
  closeShips();
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

// ---------- ships ----------

// "Ships" in the top menu covers the map with the 3D ship inspector (public/ships/). It is loaded the
// first time it is opened, so the map never waits for three.js, and it stops drawing while closed.
let ships = null; // the inspector once built
let shipsLoading = null;
const shipsOpen = () => !$('#ships').hidden;

async function openShips() {
  if (openTab !== null) closePanel();
  $('#ships').hidden = false;
  $('#menu-ships').setAttribute('aria-pressed', 'true');
  if (ships) { ships.resume(); return; }
  if (!shipsLoading) {
    showToast('Loading the ship inspector…');
    shipsLoading = import('./ships/ui.js')
      .then((m) => { ships = m.createShipInspector($('#ships'), { onClose: closeShips }); $('#toast').hidden = true; })
      .catch((err) => { shipsLoading = null; closeShips(); showToast(`Could not load the ship inspector: ${err.message}`); });
  }
  await shipsLoading;
  if (!shipsOpen()) ships?.pause(); // closed again while it was loading
}

function closeShips() {
  if (!shipsOpen()) return;
  $('#ships').hidden = true;
  $('#menu-ships').setAttribute('aria-pressed', 'false');
  ships?.pause();
}

const toggleShips = () => (shipsOpen() ? closeShips() : openShips());


// ---------- debug overlay ----------

// Name a relay stream by what it is for, not by its (random-looking) topic.
function streamName(topic) {
  if (pairing?.topic === topic) return 'pairing code';
  for (const [id, ch] of channels) if (ch.topic === topic) return `→ ${label(state.contacts[id] ?? { name: '?' })}`;
  return topic.startsWith('rope-pake-') ? 'pairing (joining)' : topic.slice(0, 14);
}

async function debugSnapshot() {
  const now = Date.now();
  const tone = (bad, warn) => (bad ? 'error' : warn ? 'warn' : '');
  const sections = [{
    title: 'App',
    rows: [
      ['build', $('#build')?.textContent ?? '?'],
      ['network', navigator.onLine ? 'online' : 'OFFLINE', tone(!navigator.onLine)],
      ['page', document.visibilityState],
      ['WebRTC', globalThis.RTCPeerConnection ? 'available' : 'not available', tone(!globalThis.RTCPeerConnection)],
    ],
  }, {
    title: 'GPS',
    rows: [
      ['watching', gpsWatch !== null ? 'yes' : 'no', tone(gpsWatch === null)],
      ['fixes', `${gpsInfo.fixes}, last ${ago(gpsInfo.lastFixAt, now)} ago`, tone(false, gpsInfo.lastFixAt && now - gpsInfo.lastFixAt > 60_000)],
      ['accuracy', myPos ? `±${Math.round(myPos.acc)} m` : '-'],
      ...(gpsInfo.lastError ? [['last error', gpsInfo.lastError, 'warn']] : []),
    ],
  }];
  if (relay) {
    const st = relay.stats;
    const paused = relayPausedUntil > now ? Math.ceil((relayPausedUntil - now) / 1000) : 0;
    sections.push({
      title: `Rendezvous ${relay.base.replace(/^https?:\/\//, '')}`,
      rows: [
        ['sent', `${st.sent} ok, last ${ago(st.lastOkAt, now)} ago`],
        ['failed', `${st.failed} (${st.rateLimited} rate-limited), ${st.retries} retries`, tone(false, st.failed)],
        ...(st.lastError ? [['last error', `${st.lastError}, ${ago(st.lastErrorAt, now)} ago`, now - st.lastErrorAt < 120_000 ? 'error' : 'warn']] : []),
        ...(paused ? [['positions paused', `${paused} s (rate limit)`, 'error']] : []),
        ...relay.streams().map((x) => [`stream ${streamName(x.topic)}`,
          `${x.state}, msg ${ago(x.lastMsgAt, now)} ago, opens ${x.opens}, errors ${x.errors}`, tone(x.state === 'closed', x.state !== 'open')]),
      ],
    });
  }
  if (pairing) sections.push({ title: 'Pairing', rows: [['code', `${pairing.code}, ${Math.ceil((pairing.expires - now) / 1000)} s left`]] });
  for (const c of Object.values(state?.contacts ?? {})) {
    const conn = connOf(c);
    const rows = [
      ['status', c.status === 'active' ? (seeingThem(c) ? 'active, sharing with me' : 'active, hidden from me') : c.status],
      ['connection', CONN_TEXT[conn], conn === 'none' ? 'error' : conn === 'relay' ? 'warn' : ''],
    ];
    if (c.adminAsk || c.adminReq || c.adminOverMe || c.youAdminThem) {
      rows.push(['admin', c.adminOverMe ? 'they are my admin' : c.youAdminThem ? 'I am their admin' : c.adminAsk ? 'they ask, waiting for my answer' : 'I asked, waiting for theirs']);
    }
    const link = links.get(c.id);
    if (link) {
      const ls = link.status();
      rows.push(['direct link', `${ls.state} (${ls.role}), ICE ${ls.ice}, attempts ${ls.attempts}`, tone(false, ls.state !== 'open')]);
      if (ls.retryInMs) rows.push(['next try', `in ${Math.ceil(ls.retryInMs / 1000)} s`]);
      if (ls.lastError) rows.push(['link error', ls.lastError, 'warn']);
      if (ls.state === 'open') {
        const r = await link.route();
        if (r) rows.push(['route', `${r.local} → ${r.remote}${r.rttMs != null ? `, ${r.rttMs} ms` : ''}`]);
      }
    }
    const t = traffic.get(c.id);
    if (t) {
      rows.push(['sent', `${t.txDirect} direct, ${t.txRelay} via server`]);
      rows.push(['received', `${t.rxDirect} direct, ${t.rxRelay} via server, last ${ago(t.lastRx, now)} ago`]);
    }
    rows.push(['their position', c.pos ? `${ago(c.pos.ts, now)} old` : 'none', tone(false, !c.pos || isStale(c.pos))]);
    sections.push({ title: label(c), rows });
  }
  return sections;
}

const debugOverlay = new DebugOverlay(debugSnapshot);

async function startApp() {
  $('#auth').hidden = true;
  $('#menu').hidden = false; // the map stays in view; panels open from the top menu
  $('#follow-me').hidden = false;
  $('#measure').hidden = false;
  $('#heightmap').hidden = false;
  $('#offline').hidden = false;
  $('#inspect').hidden = false;
  setInterval(renderZones, 5000); // positions age: a person who stops reporting stops warning
  setInterval(updateRoad, 4000); // also asks when a position stays put but the wait since the last question is over
  syncOfflineUi();
  startOffline();
  syncTerrainButton();
  if (terrainOn()) setAttribution(true);
  renderDistances();
  renderFollowUi();
  startGps(); // first, so a failure further down can't leave location unasked
  keys = await loadKeys(state.identity);
  relay = new Relay(state.relay || DEFAULT_RELAY, { log: logger('relay') });
  log.app('info', `started, build ${$('#build')?.textContent}, relay ${relay.base}`);
  for (const c of activeContacts()) await openChannel(c);
  for (const c of activeContacts()) resendAdmin(c);
  renderAll();
  setInterval(() => { renderContacts(); renderMarkers(); renderTraces(); }, 15_000);
  setInterval(renderConn, 1_000);
  renderConn();
  window.addEventListener('online', onNetworkBack);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onNetworkBack(); });
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
      const code = parseCode($('#add-code').value);
      if (!code) throw new Error('A pairing code has 10 digits, like 37-4821-9305.');
      $('#add-code').value = '';
      await joinWithCode(code);
    } catch (err) { showAddMessage(err.message, true); }
  });

  $('#pair-new').addEventListener('click', () => startPairing().catch((err) => { stopPairing(); showAddMessage(err.message, true); }));
  $('#pair-cancel').addEventListener('click', () => stopPairing());
  $('#pair-scan').addEventListener('click', () => startScan((text) => {
    const code = parseCode(text);
    if (!code) return false;
    joinWithCode(code).catch((err) => showAddMessage(err.message, true));
    return true;
  }).catch((err) => {
    stopScan();
    showAddMessage(err.name === 'NotAllowedError' ? 'Camera access was refused. Type the number instead.' : err.message, true);
  }));
  $('#scan-cancel').addEventListener('click', stopScan);
  $('#qr-open').addEventListener('click', () => { $('#qr-link').hidden = false; $('#qr-open').hidden = true; qrMessage(''); });
  $('#qr-cancel').addEventListener('click', qrReset);
  $('#qr-show').addEventListener('click', () => qrStartHost().catch((err) => { qrReset(); showAddMessage(err.message, true); }));
  $('#qr-scan').addEventListener('click', () => qrStartJoin().catch((err) => { qrReset(); showAddMessage(err.name === 'NotAllowedError' ? 'Camera access was refused.' : err.message, true); }));

  $('#gps-retry').addEventListener('click', () => { stopGps(); startGps(); });

  // Trails: per person, off by default, length chosen per person.
  $('#contacts').addEventListener('change', (e) => {
    const el = e.target;
    if (el.matches('input[data-trace-on]')) setTrace(el.dataset.id, { on: el.checked });
  });
  $('#trace-me').addEventListener('change', (e) => setTrace('me', { on: e.target.checked }));
  $('#trace-me-length-btn').addEventListener('click', () => {
    wheelOpenFor = wheelOpenFor === 'me' ? null : 'me';
    renderMyLengthControl(traceOf('me'));
  });
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
  $('#status').addEventListener('click', () => showToast(state ? `${connSummary()}${isPhone() ? ` — ${$('#status-text').textContent}` : ''}` : $('#status-text').textContent));
  $('#follow-me').addEventListener('click', () => {
    if (!myPos) { startGps(); setStatus('Waiting for your location…'); }
    setFollow(followMe(follow), { recentre: true });
  });
  $('#follow-person').addEventListener('click', () => setFollow(pressPersonArrow(follow), { recentre: true }));
  $('#heightmap').addEventListener('click', () => setTerrain3D(!terrainOn()));
  $('#open-zones').addEventListener('click', () => { renderZonesPanel(); openPanel('zones'); });
  for (const kind of ['no', 'green']) {
    $(`#zvis-${kind}`).addEventListener('input', (e) => {
      state.zoneVis = { ...(state.zoneVis ?? {}), [kind]: Number(e.target.value) / 100 };
      saveState();
      renderZones();
    });
  }
  $('#zones-back').addEventListener('click', () => { closeZoneForm(); openPanel('me'); });
  $('#zone-add').addEventListener('click', () => openZoneForm());
  $('#zone-cancel').addEventListener('click', closeZoneForm);
  $('#zone-form').addEventListener('submit', (e) => { e.preventDefault(); saveZone(); });
  $('#zone-form').addEventListener('change', (e) => {
    if (!draft) return;
    if (e.target.name === 'zone-kind') { draft.kind = e.target.value; syncZoneForm(); }
    else if (e.target.name === 'zone-scope') { draft.scope = e.target.value; syncZoneForm(); }
    else if (e.target.closest('#zone-who')) draft.who = [...document.querySelectorAll('#zone-who input:checked')].map((i) => i.value);
  });
  $('#zone-name').addEventListener('input', (e) => { if (draft) draft.name = e.target.value; });
  $('#zone-radius').addEventListener('input', (e) => { if (draft && e.target.value !== '') { draft.r = Number(e.target.value); renderDraft(); $('#zone-slider').value = Math.min(5000, Math.max(50, draft.r)); } });
  $('#zone-radius').addEventListener('change', (e) => setDraftRadius(e.target.value));
  $('#zone-slider').addEventListener('input', (e) => setDraftRadius(e.target.value));
  $('#zone-chips').addEventListener('click', (e) => { const b = e.target.closest('[data-chip]'); if (b) setDraftRadius(b.dataset.chip); });
  $('#zone-pick').addEventListener('click', () => {
    if (!draft) return;
    zonePicking = true;
    document.body.classList.add('zone-picking');
    closePanel();
    showToast('Tap the map to place the zone');
  });
  $('#zone-here').addEventListener('click', () => {
    if (!draft) return;
    if (!myPos) { $('#zone-error').textContent = 'Waiting for your position…'; $('#zone-error').hidden = false; return; }
    $('#zone-error').hidden = true;
    Object.assign(draft, { lat: myPos.lat, lon: myPos.lon, label: 'My position' });
    syncZoneForm();
    flyToZone({ ...draft });
  });
  $('#zone-find').addEventListener('click', findAddress);
  $('#zone-address').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findAddress(); } });
  $('#zone-results').addEventListener('click', (e) => {
    const b = e.target.closest('[data-place]');
    const p = b && $('#zone-results').places?.[Number(b.dataset.place)];
    if (!p || !draft) return;
    Object.assign(draft, { lat: p.lat, lon: p.lon, label: p.label });
    $('#zone-results').hidden = true;
    syncZoneForm();
    flyToZone({ ...draft });
  });
  $('#zone-list').addEventListener('click', (e) => {
    const edit = e.target.closest('[data-zone-edit]'), del = e.target.closest('[data-zone-del]');
    if (edit) return openZoneForm(myZones().find((z) => z.id === edit.dataset.zoneEdit));
    if (del) {
      const z = myZones().find((x) => x.id === del.dataset.zoneDel);
      if (z && confirm(`Delete “${z.name || KINDS[z.kind]}”?`)) {
        state.zones = myZones().filter((x) => x.id !== z.id);
        saveState(); renderZonesPanel(); renderZones(); sendZonesToAll();
      }
      return;
    }
    const li = e.target.closest('[data-focus]');
    const z = li && myZones().find((x) => x.id === li.dataset.focus);
    if (z) flyToZone(z);
  });
  $('#zones-assigned').addEventListener('click', (e) => {
    const li = e.target.closest('[data-focus]');
    const z = li && state.contacts[li.dataset.admin]?.zones?.find((x) => x.id === li.dataset.focus);
    if (z) flyToZone(z);
  });
  $('#inspect').addEventListener('click', () => setInspect(!inspectOn));
  $('#offline').addEventListener('click', () => setOfflineMap(!offlineOn()));
  $('#offline-switch').addEventListener('change', (e) => setOfflineMap(e.target.checked));
  $('#offline-clear').addEventListener('click', async () => {
    const n = await offline.clearSaved();
    showToast(n ? `Forgot ${n.toLocaleString()} saved map parts` : 'Nothing was saved');
    refreshOfflineStats();
  });
  $('#measure').addEventListener('click', () => {
    state.showDistances = state.showDistances !== true; // off by default
    saveState();
    renderDistances();
    if (state.showDistances && !myPos) setStatus('Waiting for your location…');
  });
  const allTaps = tapCounter();
  $('#menu-all').addEventListener('click', () => {
    if (allTaps()) showToast(debugOverlay.toggle() ? 'Debug overlay on (tap All 4 times to hide)' : 'Debug overlay off');
    closePanel(); // show the map
    if (!myPos) { startGps(); setStatus('Waiting for your location…'); }
    setFollow(followAll(follow), { recentre: true });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Escape in a field of the ship inspector only leaves the field.
    if (shipsOpen()) { if (!e.target.closest?.('#ships input, #ships select')) closeShips(); return; }
    closePanel();
  });
  $('#menu-ships').addEventListener('click', toggleShips);

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
  registerDemProtocol(maplibregl, { log: (level, text) => log.app(level, text) }); // 3D terrain tiles, made on demand
  initMap();
  wire();
  state = loadState();
  if (!window.crypto?.subtle) {
    setStatus('This browser has no WebCrypto (needs https)');
    hideSplash();
    return;
  }
  if (state) startApp().catch((err) => { setStatus(err.message); hideSplash(); });
  else { $('#auth').hidden = false; setStatus('Create your identity'); }
}

bootstrap();

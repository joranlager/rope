import { haversineM, formatMetres, elevationGainLoss } from './geo.js';
import {
  newIdentity, loadKeys, cardOf, encodeCard, decodeCard, fingerprint, inboxTopic,
  deriveSecret, channelFromSecret, seal, open, signObj, verifyObj,
} from './crypto.js';
import { Relay, DEFAULT_RELAY } from './net.js';
import {
  initialFollow, followPerson, dragged, arrowPressed, contactRemoved, arrowState,
} from './follow.js';
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
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');

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
    map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'route-line', type: 'line', source: 'route',
      paint: { 'line-color': '#2563eb', 'line-width': 5, 'line-opacity': 0.85 },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    });
  });
  map.on('click', (e) => {
    if (routeMode) setDestination({ lat: e.lngLat.lat, lon: e.lngLat.lng });
  });

  // Dragging the map by hand stops following. The map's own animated moves don't fire dragstart.
  map.on('dragstart', () => setFollow(dragged(follow)));
  map.on('moveend', () => { programmaticMove = false; });
}

function makeEl(cls, text, color) {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  if (color) el.style.background = color;
  return el;
}
function colorFor(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 65% 45%)`;
}
const initials = (n) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
const label = (c) => c.nick || c.name;

// ---------- following ----------
// The map opens following my own position. "Show" on a person follows them instead.
// Dragging the map stops following; the arrow button resumes it.

let follow = initialFollow();
let programmaticMove = false;
let lastFollowed = null; // the point we last centred on, so repeated identical updates don't re-animate

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

/**
 * fresh: starting to follow, so zoom in to a useful level.
 * force: re-centre even if the point hasn't changed (e.g. the sheet opened or closed).
 */
function moveToFollowed({ fresh = false, force = false } = {}) {
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

function renderFollowUi() {
  const st = arrowState(follow);
  const btn = $('#locate');
  btn.dataset.follow = st; // 'me' = filled arrow, otherwise outlined
  btn.setAttribute('aria-pressed', String(st !== 'off'));
  const lab = $('#follow-label');
  if (st === 'person' && state?.contacts[follow.target]) {
    const c = state.contacts[follow.target];
    lab.hidden = false;
    lab.textContent = followedPoint() ? `Following ${label(c)}` : `Waiting for ${label(c)}…`;
  } else {
    lab.hidden = true;
  }
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
      const el = makeEl('person', initials(label(c)), colorFor(c.id));
      el.title = label(c);
      markers.set(c.id, new maplibregl.Marker({ element: el }).setLngLat(ll).addTo(map));
    }
  }
  for (const [id, m] of markers) if (!seen.has(id)) { m.remove(); markers.delete(id); }
  if (follow.target !== null && follow.target !== 'me') { moveToFollowed(); renderFollowUi(); }
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
  if (!myMarker) myMarker = new maplibregl.Marker({ element: makeEl('me-dot', '') }).setLngLat([lon, lat]).addTo(map);
  else myMarker.setLngLat([lon, lat]);
  $('#me-gps').textContent = `±${Math.round(accuracy)} m accuracy`;
  $('#gps-alt').textContent = altitude == null ? 'n/a' : `${Math.round(altitude)} m`;
  setStatus('GPS live');
  if (follow.target === 'me') moveToFollowed({ fresh: firstFix });
  maybeSendPosition();
  maybeUpdateTerrain();
  renderContacts();
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
  const all = Object.values(state.contacts).filter((c) => c.status !== 'request').sort((a, b) => label(a).localeCompare(label(b)));
  if (!all.length) {
    list.innerHTML = '<li class="muted empty">No contacts yet. Share your invite link, or paste someone else’s link above.</li>';
    return;
  }
  list.innerHTML = all.map((c) => {
    const id = esc(c.id);
    if (c.status === 'pending') {
      return `<li class="contact"><div class="contact-head"><div class="avatar" style="background:${colorFor(c.id)}">${esc(initials(c.name))}</div>
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
    return `
      <li class="contact">
        <div class="contact-head">
          <div class="avatar" style="background:${colorFor(c.id)}">${esc(initials(label(c)))}</div>
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
      </li>`;
  }).join('');
}

function renderAll() {
  renderMe();
  renderRequests();
  renderContacts();
  renderMarkers();
}

async function onListClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const c = state.contacts[btn.dataset.id];
  if (!c) return;
  try {
    switch (btn.dataset.act) {
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
  document.querySelectorAll('.menu-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === name)));
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
  document.querySelectorAll('.menu-btn').forEach((b) => b.setAttribute('aria-pressed', 'false'));
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
  $('#locate').hidden = false;
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
  setInterval(() => { renderContacts(); renderMarkers(); }, 15_000);
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

  $('#contacts').addEventListener('click', onListClick);
  $('#requests').addEventListener('click', onListClick);
  document.querySelectorAll('.menu-btn').forEach((b) => b.addEventListener('click', () => togglePanel(b.dataset.tab)));
  $('#close-panel').addEventListener('click', closePanel);
  enableSheetDrag();
  // The arrow: after a drag it resumes following; while following a person it returns to me.
  $('#locate').addEventListener('click', () => {
    const next = arrowPressed(follow);
    if (next.target === 'me' && !myPos) { startGps(); setStatus('Waiting for your location…'); }
    setFollow(next, { recentre: true });
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

function bootstrap() {
  const build = $('#build');
  if (build.textContent.startsWith('__')) build.textContent = 'dev'; // not replaced by the Pages build
  populateProfiles();
  initMap();
  wire();
  state = loadState();
  if (!window.crypto?.subtle) {
    setStatus('This browser has no WebCrypto (needs https)');
    return;
  }
  if (state) startApp().catch((err) => setStatus(err.message));
  else { $('#auth').hidden = false; setStatus('Create your identity'); consumeInviteFromUrl(); }
}

bootstrap();

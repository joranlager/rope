import { haversineM, formatMetres, elevationGainLoss } from './geo.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const TOKEN_KEY = 'rope.token';
const storage = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

let token = storage.get(TOKEN_KEY);
let config = null;
let state = null;      // last /api/state payload
let myPos = null;      // { lat, lon, accuracy, altitude }
let map = null;
let myMarker = null;
let destMarker = null;
let routeMode = false;
let destination = null;
const markers = new Map();
let lastSent = 0;
let terrainFor = null; // position the terrain height was last fetched for
let terrainAt = 0;

// ---------- API ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

function setStatus(text) {
  $('#status').textContent = text;
}

// ---------- map ----------

function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        topo: {
          type: 'raster',
          tiles: ['https://cache.kartverket.no/topo/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png'],
          tileSize: 256,
          maxzoom: 18,
          attribution: '© <a href="https://www.kartverket.no/">Kartverket</a>',
        },
      },
      layers: [{ id: 'topo', type: 'raster', source: 'topo' }],
    },
    center: [10.75, 59.91],
    zoom: 11,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'bottom-right');

  map.on('load', () => {
    map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      paint: { 'line-color': '#2563eb', 'line-width': 5, 'line-opacity': 0.85 },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    });
  });

  map.on('click', (e) => {
    if (!routeMode) return;
    setDestination({ lat: e.lngLat.lat, lon: e.lngLat.lng });
  });
}

function makeMarker(cls, text, color) {
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

const initials = (name) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';

function renderMyMarker() {
  if (!myPos) return;
  const ll = [myPos.lon, myPos.lat];
  if (!myMarker) {
    myMarker = new maplibregl.Marker({ element: makeMarker('me-dot', '', null) }).setLngLat(ll).addTo(map);
  } else {
    myMarker.setLngLat(ll);
  }
}

function renderContactMarkers() {
  const seen = new Set();
  for (const c of state.contacts) {
    if (!c.position) continue;
    seen.add(c.id);
    const ll = [c.position.lon, c.position.lat];
    const existing = markers.get(c.id);
    if (existing) {
      existing.setLngLat(ll);
    } else {
      const el = makeMarker('person', initials(c.nick ?? c.name), colorFor(c.id));
      el.title = c.nick ?? c.name;
      markers.set(c.id, new maplibregl.Marker({ element: el }).setLngLat(ll).addTo(map));
    }
  }
  for (const [id, m] of markers) {
    if (!seen.has(id)) {
      m.remove();
      markers.delete(id);
    }
  }
}

// ---------- GPS and heights ----------

function startGps() {
  if (!('geolocation' in navigator)) {
    setStatus('No GPS support in this browser');
    return;
  }
  navigator.geolocation.watchPosition(
    onFix,
    (err) => setStatus(`GPS: ${err.message}`),
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 },
  );
}

function onFix(p) {
  const { latitude: lat, longitude: lon, accuracy, altitude } = p.coords;
  myPos = { lat, lon, accuracy, altitude };
  renderMyMarker();
  $('#me-gps').textContent = `±${Math.round(accuracy)} m accuracy`;
  $('#gps-alt').textContent = altitude == null ? 'n/a' : `${Math.round(altitude)} m`;
  setStatus('GPS live');

  if (Date.now() - lastSent > 2000) {
    lastSent = Date.now();
    api('POST', '/api/position', { lat, lon, accuracy }).catch(() => {});
  }
  maybeUpdateTerrain();
  renderContacts();
}

async function maybeUpdateTerrain() {
  if (!myPos) return;
  const moved = terrainFor ? haversineM(terrainFor.lat, terrainFor.lon, myPos.lat, myPos.lon) : Infinity;
  if (moved < 50 && Date.now() - terrainAt < 60000) return;
  terrainFor = { lat: myPos.lat, lon: myPos.lon };
  terrainAt = Date.now();
  try {
    const { elevation } = await api('GET', `/api/elevation?lat=${myPos.lat}&lon=${myPos.lon}`);
    $('#terrain').textContent = elevation == null ? 'outside coverage' : `${elevation.toFixed(1)} m a.s.l.`;
  } catch {
    $('#terrain').textContent = 'unavailable';
  }
}

// ---------- people ----------

function renderMe() {
  const me = state.me;
  $('#me-name').textContent = me.name;
  $('#visible').checked = me.visible;
  $('#my-code').value = me.code;
  const notice = $('#admin-notice');
  if (me.adminsOverMe.length) {
    notice.hidden = false;
    notice.textContent = `${me.adminsOverMe.join(', ')} can see you even when sharing is off. This is set by them and cannot be changed here.`;
  } else {
    notice.hidden = true;
  }
}

function renderContacts() {
  const list = $('#contacts');
  if (!state) return;
  if (!state.contacts.length) {
    list.innerHTML = '<li class="muted empty">No contacts yet. Share your code, or paste theirs above.</li>';
    return;
  }
  list.innerHTML = state.contacts.map((c) => {
    const label = c.nick ? `${esc(c.nick)} <small class="muted">(${esc(c.name)})</small>` : esc(c.name);
    let dist = '—';
    if (myPos && c.position) dist = formatMetres(haversineM(myPos.lat, myPos.lon, c.position.lat, c.position.lon));
    let status;
    if (c.position && c.youAdminThem && !c.visible) status = 'Visible to you as admin';
    else if (c.position) status = 'Live';
    else if (c.hidden) status = 'Hidden by them';
    else status = 'No position yet';
    const lock = c.themAdminYou
      ? '<span class="chip lock">Admin set · locked</span>'
      : '';
    const adminBtn = c.themAdminYou
      ? ''
      : `<button class="ghost" data-act="admin" data-id="${c.id}" data-on="${!c.youAdminThem}">${c.youAdminThem ? 'Remove my admin' : 'Make me admin'}</button>`;
    const removeBtn = c.themAdminYou
      ? '<button class="ghost" disabled title="Locked by an admin">Remove</button>'
      : `<button class="ghost danger" data-act="remove" data-id="${c.id}">Remove</button>`;
    return `
      <li class="contact">
        <div class="contact-head">
          <div class="avatar" style="background:${colorFor(c.id)}">${esc(initials(c.nick ?? c.name))}</div>
          <div class="who">
            <div class="name">${label}</div>
            <div class="muted small">${esc(status)} · they ${c.theyCanSeeYou ? 'can' : 'cannot'} see you</div>
          </div>
          <div class="dist" title="Straight-line distance">${dist}</div>
        </div>
        <div class="contact-actions">
          ${lock}
          ${c.position ? `<button class="ghost" data-act="focus" data-id="${c.id}">Show</button>` : ''}
          <button class="ghost" data-act="nick" data-id="${c.id}">Nickname</button>
          ${adminBtn}
          ${removeBtn}
        </div>
      </li>`;
  }).join('');
}

function renderAll() {
  renderMe();
  renderContacts();
  renderContactMarkers();
}

async function refresh() {
  state = await api('GET', '/api/state');
  renderAll();
}

function startPolling() {
  setInterval(() => {
    if (token && state) refresh().catch(() => {});
  }, 4000);
}

async function onContactsClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const contact = state.contacts.find((c) => c.id === id);
  try {
    if (btn.dataset.act === 'focus' && contact?.position) {
      map.flyTo({ center: [contact.position.lon, contact.position.lat], zoom: Math.max(map.getZoom(), 14) });
      selectTab('people');
      return;
    }
    if (btn.dataset.act === 'nick') {
      const nick = prompt(`Nickname for ${contact.name} (empty to clear)`, contact.nick ?? '');
      if (nick === null) return;
      await api('PATCH', `/api/contacts/${id}`, { nick });
    }
    if (btn.dataset.act === 'admin') {
      const on = btn.dataset.on === 'true';
      if (on && !confirm(`Give yourself admin rights over ${contact.name}? They will see that you can see them, and cannot remove this.`)) return;
      await api('PUT', `/api/contacts/${id}/admin`, { admin: on });
    }
    if (btn.dataset.act === 'remove') {
      if (!confirm(`Remove ${contact.name} from your contacts?`)) return;
      await api('DELETE', `/api/contacts/${id}`);
    }
    await refresh();
  } catch (err) {
    setStatus(err.message);
  }
}

// ---------- route ----------

const profileLabels = { car: 'Car', foot: 'Walk', bike: 'Bike' };

function populateProfiles() {
  const sel = $('#profile');
  sel.innerHTML = Object.keys(config.routing)
    .map((k) => `<option value="${k}">${profileLabels[k] ?? k}</option>`)
    .join('');
}

function setDestination(dest) {
  destination = dest;
  if (!destMarker) {
    destMarker = new maplibregl.Marker({ element: makeMarker('dest', '⚑', null) }).setLngLat([dest.lon, dest.lat]).addTo(map);
  } else {
    destMarker.setLngLat([dest.lon, dest.lat]);
  }
  routeMode = false;
  $('#pick').classList.remove('active');
  $('#route-hint').textContent = 'Calculating route…';
  computeRoute();
}

async function computeRoute() {
  $('#route-error').hidden = true;
  if (!myPos) {
    showRouteError('Waiting for a GPS fix to use as the start.');
    return;
  }
  const base = config.routing[$('#profile').value];
  const url = `${base}/${myPos.lon},${myPos.lat};${destination.lon},${destination.lat}?overview=full&geometries=geojson&steps=false`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes?.length) throw new Error(data.message ?? 'No route found');
    const route = data.routes[0];
    map.getSource('route').setData({ type: 'Feature', geometry: route.geometry, properties: {} });
    $('#route-hint').textContent = '';
    $('#route-summary').hidden = false;
    $('#r-dist').textContent = formatMetres(route.distance);
    $('#r-time').textContent = formatDuration(route.duration);
    await renderProfile(route.geometry.coordinates, route.distance);
  } catch (err) {
    showRouteError(`Route failed: ${err.message}`);
  }
}

function showRouteError(msg) {
  const el = $('#route-error');
  el.hidden = false;
  el.textContent = msg;
}

function formatDuration(s) {
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

// Sample up to 60 evenly spaced vertices, fetch their heights, and draw the profile.
async function renderProfile(coords, totalM) {
  const n = Math.min(60, coords.length);
  const idx = Array.from({ length: n }, (_, i) => Math.round((i * (coords.length - 1)) / Math.max(1, n - 1)));
  const pts = idx.map((i) => [coords[i][1], coords[i][0]]);
  const { elevations } = await api('POST', '/api/elevations', { points: pts });

  const dists = [0];
  for (let i = 1; i < pts.length; i++) {
    dists.push(dists[i - 1] + haversineM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  }
  const { up, down } = elevationGainLoss(elevations);
  $('#r-up').textContent = `${up} m`;
  $('#r-down').textContent = `${down} m`;

  const svg = $('#profile-svg');
  const valid = elevations.map((h, i) => ({ h, d: dists[i] })).filter((p) => p.h != null);
  svg.hidden = valid.length < 2;
  if (svg.hidden) return;
  const hs = valid.map((p) => p.h);
  const min = Math.min(...hs);
  const max = Math.max(...hs);
  const span = Math.max(1, max - min);
  const W = 320, H = 110, pad = 6;
  const total = Math.max(1, totalM);
  const xy = valid.map((p) => {
    const x = (p.d / total) * W;
    const y = H - pad - ((p.h - min) / span) * (H - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  svg.innerHTML = `
    <polygon points="0,${H} ${xy.join(' ')} ${W},${H}" fill="currentColor" opacity="0.12"></polygon>
    <polyline points="${xy.join(' ')}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"></polyline>
    <text x="4" y="12" font-size="10" fill="currentColor">${Math.round(max)} m</text>
    <text x="4" y="${H - 2}" font-size="10" fill="currentColor">${Math.round(min)} m</text>`;
}

// ---------- tabs and auth ----------

function selectTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  for (const t of ['people', 'route', 'me']) $(`#tab-${t}`).hidden = t !== name;
}

function showAuth() {
  $('#auth').hidden = false;
  $('#panel').hidden = true;
}

function showApp() {
  $('#auth').hidden = true;
  $('#panel').hidden = false;
}

async function start() {
  try {
    await refresh();
    showApp();
    startGps();
    startPolling();
  } catch {
    storage.del(TOKEN_KEY);
    token = null;
    showAuth();
  }
}

function wire() {
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { token: t } = await api('POST', '/api/register', { name: $('#auth-name').value });
      token = t;
      storage.set(TOKEN_KEY, t);
      await start();
    } catch (err) {
      $('#auth-error').hidden = false;
      $('#auth-error').textContent = err.message;
    }
  });

  $('#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#add-error');
    err.hidden = true;
    try {
      await api('POST', '/api/contacts', { code: $('#add-code').value });
      $('#add-code').value = '';
      await refresh();
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message;
    }
  });

  $('#contacts').addEventListener('click', onContactsClick);
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

  $('#visible').addEventListener('change', async (e) => {
    try {
      await api('POST', '/api/visibility', { visible: e.target.checked });
      await refresh();
    } catch (err) {
      setStatus(err.message);
      e.target.checked = !e.target.checked;
    }
  });

  $('#copy-code').addEventListener('click', () => navigator.clipboard?.writeText($('#my-code').value));
  $('#rotate-code').addEventListener('click', async () => {
    if (!confirm('Rotate your code? The old code stops working. Existing contacts stay.')) return;
    await api('POST', '/api/code/rotate');
    await refresh();
  });

  $('#pick').addEventListener('click', () => {
    routeMode = !routeMode;
    $('#pick').classList.toggle('active', routeMode);
    $('#route-hint').textContent = routeMode ? 'Tap the map to set the destination.' : '';
  });
  $('#clear-route').addEventListener('click', () => {
    destination = null;
    destMarker?.remove();
    destMarker = null;
    map.getSource('route').setData({ type: 'FeatureCollection', features: [] });
    $('#route-summary').hidden = true;
    $('#profile-svg').hidden = true;
    $('#route-error').hidden = true;
  });
  $('#profile').addEventListener('change', () => { if (destination) computeRoute(); });
}

async function main() {
  config = await api('GET', '/api/config');
  populateProfiles();
  wire();
  if (token) await start();
  else showAuth();
}

function bootstrap() {
  initMap();
  map.once('load', () => main().catch((err) => setStatus(err.message)));
}

bootstrap();

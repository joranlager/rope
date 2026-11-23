/* Rope's service worker: keeps the app and the map parts that are used on the device, so the map
 * works without a network.
 *
 * What is kept, and how:
 *   shell  the app's own files          network first (always the newest), the saved copy when there is no network
 *   lib    MapLibre from unpkg          saved forever (the address names its version)
 *   osm    OpenStreetMap map tiles      saved as they are looked at; refreshed in the background after 7 days
 *   dem    Kartverket height tiles      saved as used (the 3D terrain); refreshed after 90 days
 *   elev   Kartverket height at a point saved as used
 * Nothing is downloaded ahead of time: only what has been looked at is kept, which is also what
 * OpenStreetMap's tile policy asks of apps. The routing service and the people relay are never
 * touched here; they need the network.
 *
 * "Offline map" mode (set from the page): only saved parts are used and no network is tried. A part
 * that is not saved answers 404, so the map shows nothing there instead of waiting for a timeout.
 *
 * The tile caches live across app updates; only the app files are replaced when a new build arrives.
 *
 * This is a classic script (not a module) so every browser accepts it. __BUILD__ and the file list
 * below are filled in by scripts/build.mjs; in development they stay as they are and the app files
 * are saved as they are fetched.
 */
'use strict';

const BUILD = '__BUILD__';
const PRECACHE = /*PRECACHE*/ [] /*END*/;
// Keep in step with the MapLibre version in index.html.
const LIB_URLS = [
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
];

const CACHES = {
  shell: `rope-shell-${BUILD}`, // replaced with every build
  lib: 'rope-lib-v1',
  osm: 'rope-osm-v1',
  dem: 'rope-dem-v1',
  elev: 'rope-elev-v1',
  meta: 'rope-meta-v1',
};
const DAY = 24 * 60 * 60 * 1000;
const TTL = { osm: 7 * DAY, dem: 90 * DAY, elev: 365 * DAY, lib: Infinity };
// Roughly: 5 000 map tiles of ~20 KB, 1 200 height tiles of ~66 KB, many tiny heights.
const LIMITS = { osm: 5000, dem: 1200, elev: 4000 };
const CONFIG = { shellTimeoutMs: 4000, trimEvery: 40 };
const STAMP = 'x-rope-cached-at';
const META_KEY = 'https://rope.invalid/offline-mode'; // a made-up address, used only as a key

const now = () => Date.now();
const cacheName = (kind) => CACHES[kind];
const indexUrl = () => new URL('./', self.registration.scope).href;

/** Which kind of thing is this address? null = not ours: leave it to the browser. */
function kindOf(url, origin) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.origin === origin) return 'shell';
  if (u.hostname === 'tile.openstreetmap.org') return 'osm';
  if (u.hostname === 'wcs.geonorge.no' && u.pathname.startsWith('/skwms1/wcs.hoyde-dtm')) return 'dem';
  if (u.hostname === 'ws.geonorge.no' && u.pathname.startsWith('/hoydedata/')) return 'elev';
  if (u.hostname === 'unpkg.com' && u.pathname.startsWith('/maplibre-gl@')) return 'lib';
  return null;
}

// ---------- the offline-map switch ----------

let offlineMode = null;

async function isOffline() {
  if (offlineMode !== null) return offlineMode;
  try {
    const hit = await (await caches.open(CACHES.meta)).match(META_KEY);
    offlineMode = hit ? (await hit.json()).offline === true : false;
  } catch {
    offlineMode = false;
  }
  return offlineMode;
}

async function setOffline(value) {
  offlineMode = value === true;
  const cache = await caches.open(CACHES.meta); // kept, so the worker still knows after it was stopped
  await cache.put(META_KEY, new Response(JSON.stringify({ offline: offlineMode }), { headers: { 'content-type': 'application/json' } }));
}

// ---------- saving ----------

/** A copy of the response with the time it was saved, which decides when it is refreshed. */
async function stamped(res) {
  const headers = new Headers(res.headers);
  headers.set(STAMP, String(now()));
  return new Response(await res.arrayBuffer(), { status: res.status, statusText: res.statusText, headers });
}

/** Only ordinary successful answers are kept: never an error, a redirect or an opaque answer. */
async function store(kind, key, res) {
  if (res.status !== 200 || res.type === 'opaque' || res.type === 'opaqueredirect') return false;
  await (await caches.open(cacheName(kind))).put(key, await stamped(res));
  return true;
}

const stores = {};
/** Keeps a cache within its limit by dropping the oldest saved entries. */
async function maybeTrim(kind, { force = false } = {}) {
  const limit = LIMITS[kind];
  if (!limit) return;
  stores[kind] = (stores[kind] || 0) + 1;
  if (!force && stores[kind] % CONFIG.trimEvery !== 0) return;
  const cache = await caches.open(cacheName(kind));
  const keys = await cache.keys(); // oldest first
  for (const k of keys.slice(0, Math.max(0, keys.length - limit))) await cache.delete(k);
}

const missing = () => new Response('Not saved on this device', { status: 404, statusText: 'Not saved offline', headers: { 'content-type': 'text/plain' } });

// ---------- strategies ----------

/** Map tiles, height tiles, libraries: the saved copy first; the network only for what is not saved. */
async function savedFirst(kind, request, ctx) {
  const offline = await isOffline();
  const cache = await caches.open(cacheName(kind));
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) {
    const age = now() - Number(hit.headers.get(STAMP) || 0);
    if (!offline && age > TTL[kind]) {
      // Old: show it now, and fetch a fresh one for next time.
      ctx.waitUntil(
        fetch(request, { cache: 'no-cache' })
          .then(async (res) => { if (await store(kind, request, res)) await maybeTrim(kind); })
          .catch(() => {}),
      );
    }
    return hit;
  }
  if (offline) return missing();
  const res = await fetch(request); // throws when there is no connection: the map reports that tile as failed
  if (res.status === 200) ctx.waitUntil(store(kind, request, res.clone()).then((saved) => saved && maybeTrim(kind)).catch(() => {}));
  return res;
}

function shellKey(request) {
  return request.mode === 'navigate' ? indexUrl() : request.url; // any way of opening the app is the same page
}

function fetchWithTimeout(request, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return fetch(request, { cache: 'no-cache', signal: ctl.signal }).finally(() => clearTimeout(timer));
}

/** The app's own files: the newest from the network, the saved copy when there is none (or offline mode). */
async function shell(request, ctx) {
  const offline = await isOffline();
  const cache = await caches.open(CACHES.shell);
  const key = shellKey(request);
  let bad = null;
  if (!offline) {
    try {
      const res = await fetchWithTimeout(request, CONFIG.shellTimeoutMs);
      if (res.ok) {
        ctx.waitUntil(store('shell', key, res.clone()).catch(() => {}));
        return res;
      }
      bad = res; // a server error: prefer a saved copy if there is one
    } catch {
      /* no connection, or too slow: use the saved copy */
    }
  }
  const hit = await cache.match(key, { ignoreVary: true });
  if (hit) return hit;
  if (request.mode === 'navigate') {
    const home = await cache.match(indexUrl(), { ignoreVary: true });
    if (home) return home;
  }
  return bad ?? new Response('Offline, and this part of the app has not been saved yet.', { status: 503, headers: { 'content-type': 'text/plain' } });
}

function handle(kind, request, ctx) {
  return kind === 'shell' ? shell(request, ctx) : savedFirst(kind, request, ctx);
}

// ---------- events ----------

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shellCache = await caches.open(CACHES.shell);
    const libCache = await caches.open(CACHES.lib);
    const scope = self.registration.scope;
    const jobs = [
      ...PRECACHE.map(async (path) => {
        const url = new URL(path, scope).href;
        const res = await fetch(url, { cache: 'reload' });
        if (res.status === 200) await shellCache.put(url === scope ? indexUrl() : url, await stamped(res));
      }),
      ...LIB_URLS.map(async (url) => {
        if (await libCache.match(url)) return;
        const res = await fetch(url, { mode: 'cors' });
        if (res.status === 200) await libCache.put(url, await stamped(res));
      }),
    ];
    await Promise.allSettled(jobs); // one file that cannot be fetched must not stop the rest
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('rope-shell-') && name !== CACHES.shell) await caches.delete(name); // the old build's app files
    }
    await self.clients.claim(); // so the very first visit already saves what it uses
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const kind = kindOf(request.url, self.location.origin);
  if (!kind) return;
  event.respondWith(handle(kind, request, event));
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'set-offline') {
    event.waitUntil(setOffline(msg.value).then(() => event.ports && event.ports[0] && event.ports[0].postMessage({ ok: true, offline: offlineMode })));
  } else if (msg.type === 'get-offline') {
    event.waitUntil(isOffline().then((offline) => event.ports && event.ports[0] && event.ports[0].postMessage({ ok: true, offline })));
  }
});

// A way in for the unit tests, which run this file in a sandbox with a fake cache.
if (self.__ROPE_TEST__) {
  self.__rope = { kindOf, handle, isOffline, setOffline, maybeTrim, store, stamped, CACHES, LIMITS, TTL, CONFIG, STAMP, META_KEY, indexUrl, PRECACHE, LIB_URLS, BUILD };
}

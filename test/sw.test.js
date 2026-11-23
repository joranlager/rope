import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');

/** Runs sw.js in a sandbox with a fake Cache Storage and a fake network. */
function boot() {
  const store = new Map(); // cache name -> Map(url -> Response)
  const key = (r) => (typeof r === 'string' ? r : r.url);
  const caches = {
    async open(name) {
      if (!store.has(name)) store.set(name, new Map());
      const m = store.get(name);
      return {
        async match(r) { const hit = m.get(key(r)); return hit ? hit.clone() : undefined; },
        async put(r, res) { m.set(key(r), res); },
        async delete(r) { return m.delete(key(r)); },
        async keys() { return [...m.keys()].map((u) => new Request(u)); },
      };
    },
    async keys() { return [...store.keys()]; },
    async delete(name) { return store.delete(name); },
    async has(name) { return store.has(name); },
  };
  const net = { calls: [], online: true, answer: () => new Response('net', { status: 200 }) };
  const listeners = {};
  const self = {
    __ROPE_TEST__: true,
    location: { origin: 'https://app.test' },
    registration: { scope: 'https://app.test/rope/' },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
    addEventListener: (t, f) => { listeners[t] = f; },
  };
  const sandbox = {
    self, caches, Response, Request, Headers, URL, AbortController, console, setTimeout, clearTimeout,
    fetch: async (r) => { net.calls.push(typeof r === 'string' ? r : r.url); if (!net.online) throw new TypeError('offline'); return net.answer(r); },
  };
  vm.runInNewContext(source, sandbox);
  const ctx = { waitUntil: (p) => { ctx.pending.push(p); }, pending: [] };
  return { sw: self.__rope, store, net, ctx, listeners, self };
}
const req = (url, init) => (init?.mode === 'navigate' ? { url, method: 'GET', mode: 'navigate' } : new Request(url, init)); // Request cannot be built with mode navigate
const settle = (ctx) => Promise.all(ctx.pending.splice(0));
const OSM = 'https://tile.openstreetmap.org/5/16/9.png';

test('kindOf sorts addresses; anything else is left alone', () => {
  const { sw } = boot();
  const o = 'https://app.test';
  assert.equal(sw.kindOf('https://app.test/rope/app.js', o), 'shell');
  assert.equal(sw.kindOf(OSM, o), 'osm');
  assert.equal(sw.kindOf('https://wcs.geonorge.no/skwms1/wcs.hoyde-dtm-nhm-25833?x=1', o), 'dem');
  assert.equal(sw.kindOf('https://ws.geonorge.no/hoydedata/v1/punkt?x=1', o), 'elev');
  assert.equal(sw.kindOf('https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js', o), 'lib');
  assert.equal(sw.kindOf('https://router.project-osrm.org/route/v1', o), null);
  assert.equal(sw.kindOf('https://relay.example/ws', o), null);
  assert.equal(sw.kindOf('not a url', o), null);
});

test('a map tile is fetched once and then served from the saved copy', async () => {
  const { sw, net, ctx } = boot();
  const first = await sw.handle('osm', req(OSM), ctx);
  assert.equal(await first.text(), 'net');
  await settle(ctx);
  net.online = false;
  const again = await sw.handle('osm', req(OSM), ctx);
  assert.equal(await again.text(), 'net');
  assert.equal(net.calls.length, 1);
});

test('errors and opaque answers are never saved', async () => {
  const { sw, net, ctx, store } = boot();
  net.answer = () => new Response('nope', { status: 500 });
  const res = await sw.handle('osm', req(OSM), ctx);
  assert.equal(res.status, 500);
  await settle(ctx);
  assert.equal(store.get('rope-osm-v1')?.size ?? 0, 0);
  assert.equal(await sw.store('osm', OSM, { status: 200, type: 'opaque' }), false);
});

test('with no network and nothing saved the request fails, so the map reports that tile', async () => {
  const { sw, net, ctx } = boot();
  net.online = false;
  await assert.rejects(sw.handle('osm', req(OSM), ctx));
});

test('offline mode: saved tiles are served, others answer 404 without touching the network', async () => {
  const { sw, net, ctx } = boot();
  await sw.handle('osm', req(OSM), ctx);
  await settle(ctx);
  net.calls.length = 0;
  await sw.setOffline(true);
  assert.equal(await sw.isOffline(), true);
  assert.equal((await sw.handle('osm', req(OSM), ctx)).status, 200);
  const other = await sw.handle('osm', req('https://tile.openstreetmap.org/5/1/1.png'), ctx);
  assert.equal(other.status, 404);
  assert.equal(net.calls.length, 0);
  await sw.setOffline(false);
  assert.equal((await sw.handle('osm', req('https://tile.openstreetmap.org/5/1/1.png'), ctx)).status, 200);
});

test('the offline setting survives the worker being stopped (it is read back from the cache)', async () => {
  const a = boot();
  await a.sw.setOffline(true);
  const b = boot();
  b.store.set('rope-meta-v1', a.store.get('rope-meta-v1'));
  assert.equal(await b.sw.isOffline(), true);
});

test('an old saved tile is shown at once and refreshed in the background', async () => {
  const { sw, net, ctx, store } = boot();
  await sw.handle('osm', req(OSM), ctx);
  await settle(ctx);
  const old = new Response('old', { headers: { [sw.STAMP]: String(Date.now() - sw.TTL.osm - 1000) } });
  store.get('rope-osm-v1').set(OSM, old);
  net.answer = () => new Response('fresh', { status: 200 });
  net.calls.length = 0;
  assert.equal(await (await sw.handle('osm', req(OSM), ctx)).text(), 'old');
  await settle(ctx);
  assert.equal(net.calls.length, 1);
  assert.equal(await (await sw.handle('osm', req(OSM), ctx)).text(), 'fresh');
});

test('an old tile is kept as it is in offline mode (no refresh attempt)', async () => {
  const { sw, net, ctx, store } = boot();
  await sw.setOffline(true);
  store.set('rope-osm-v1', new Map([[OSM, new Response('old', { headers: { [sw.STAMP]: '1' } })]]));
  assert.equal(await (await sw.handle('osm', req(OSM), ctx)).text(), 'old');
  await settle(ctx);
  assert.equal(net.calls.length, 0);
});

test('a cache is trimmed to its limit, dropping the oldest', async () => {
  const { sw, store } = boot();
  sw.LIMITS.osm = 3;
  const m = new Map();
  for (let i = 0; i < 6; i++) m.set(`https://tile.openstreetmap.org/${i}`, new Response('x'));
  store.set('rope-osm-v1', m);
  await sw.maybeTrim('osm', { force: true });
  assert.deepEqual([...m.keys()].map((u) => u.split('/').pop()), ['3', '4', '5']);
});

test('the app: newest from the network, saved copy when offline, the home page for any page', async () => {
  const { sw, net, ctx } = boot();
  const nav = req('https://app.test/rope/', { mode: 'navigate' });
  net.answer = () => new Response('v1', { status: 200 });
  assert.equal(await (await sw.handle('shell', nav, ctx)).text(), 'v1');
  await settle(ctx);
  net.answer = () => new Response('v2', { status: 200 });
  assert.equal(await (await sw.handle('shell', nav, ctx)).text(), 'v2');
  await settle(ctx);
  net.online = false;
  assert.equal(await (await sw.handle('shell', nav, ctx)).text(), 'v2');
  const other = req('https://app.test/rope/?x=1', { mode: 'navigate' });
  assert.equal(await (await sw.handle('shell', other, ctx)).text(), 'v2');
});

test('the app in offline mode never tries the network', async () => {
  const { sw, net, ctx } = boot();
  const file = req('https://app.test/rope/app.js');
  await sw.handle('shell', file, ctx);
  await settle(ctx);
  await sw.setOffline(true);
  net.calls.length = 0;
  assert.equal(await (await sw.handle('shell', file, ctx)).text(), 'net');
  assert.equal(net.calls.length, 0);
  const missing = await sw.handle('shell', req('https://app.test/rope/new.js'), ctx);
  assert.equal(missing.status, 503);
});

test('messages switch the mode and answer on the port', async () => {
  const { listeners, ctx } = boot();
  const answers = [];
  const port = { postMessage: (m) => answers.push(m) };
  listeners.message({ data: { type: 'set-offline', value: true }, ports: [port], waitUntil: ctx.waitUntil });
  await settle(ctx);
  listeners.message({ data: { type: 'get-offline' }, ports: [port], waitUntil: ctx.waitUntil });
  await settle(ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(answers)), [{ ok: true, offline: true }, { ok: true, offline: true }]);
});

test('activate drops other builds\' app files but keeps the saved tiles', async () => {
  const { listeners, store, sw } = boot();
  for (const n of ['rope-shell-old', sw.CACHES.shell, 'rope-osm-v1', 'rope-dem-v1']) store.set(n, new Map());
  let done;
  listeners.activate({ waitUntil: (p) => { done = p; } });
  await done;
  assert.deepEqual([...store.keys()].sort(), ['rope-dem-v1', 'rope-osm-v1', sw.CACHES.shell].sort());
});

test('install saves the app files and the map library, and survives one failing', async () => {
  const { listeners, net, store, self, sw } = boot();
  self.__rope.PRECACHE.push('./', 'app.js', 'gone.js');
  net.answer = (r) => (String(r.url ?? r).endsWith('gone.js') ? new Response('', { status: 404 }) : new Response('ok', { status: 200 }));
  let done;
  listeners.install({ waitUntil: (p) => { done = p; } });
  await done;
  const shell = [...store.get(sw.CACHES.shell).keys()].sort();
  assert.deepEqual(shell, ['https://app.test/rope/', 'https://app.test/rope/app.js']);
  assert.equal(store.get('rope-lib-v1').size, 2);
});

const NVDB = (path, q = 'a=1') => `https://nvdbapiles.atlas.vegvesen.no${path}?${q}`;
const POS = '/vegnett/api/v4/posisjon';
const OK = JSON.stringify([{ veglenkesekvens: {} }]);

test('NVDB road answers are saved and served again, also with no network', async () => {
  const { sw, net, ctx } = boot();
  net.answer = () => new Response(OK, { status: 200 });
  assert.equal(sw.kindOf(NVDB(POS), 'https://app.test'), 'road');
  assert.equal(sw.kindOf(NVDB('/vegnett/api/v4/veglenkesekvenser/segmentert/1'), 'https://app.test'), 'road');
  assert.equal(sw.kindOf(NVDB('/vegobjekter/api/v4/vegobjekter/105'), 'https://app.test'), 'road');
  assert.equal(sw.kindOf(NVDB('/other'), 'https://app.test'), null);
  await sw.handle('road', req(NVDB(POS)), ctx);
  await settle(ctx);
  net.calls.length = 0;
  net.online = false;
  assert.equal(await (await sw.handle('road', req(NVDB(POS)), ctx)).text(), OK);
  assert.equal(net.calls.length, 0);
});

test('a road answer that is an error, or not the expected JSON, is not saved', async () => {
  const { sw, net, ctx, store } = boot();
  net.answer = () => new Response('busy', { status: 502 });
  await sw.handle('road', req(NVDB(POS, 'q=1')), ctx);
  net.answer = () => new Response('<html>', { status: 200 });
  await sw.handle('road', req(NVDB(POS, 'q=2')), ctx);
  net.answer = () => new Response('{"timestamp":1,"status":400}', { status: 200 });
  await sw.handle('road', req(NVDB(POS, 'q=3')), ctx);
  await settle(ctx);
  assert.equal(store.get('rope-road-v1')?.size ?? 0, 0);
  net.answer = () => new Response('{"objekter":[]}', { status: 200 });
  await sw.handle('road', req(NVDB('/vegobjekter/api/v4/vegobjekter/105', 'q=4')), ctx);
  await settle(ctx);
  assert.equal(store.get('rope-road-v1').size, 1);
});

test('in offline mode a saved road answer is used and an unsaved one is a 404', async () => {
  const { sw, net, ctx } = boot();
  net.answer = () => new Response(OK, { status: 200 });
  await sw.handle('road', req(NVDB(POS)), ctx);
  await settle(ctx);
  await sw.setOffline(true);
  net.calls.length = 0;
  assert.equal((await sw.handle('road', req(NVDB(POS)), ctx)).status, 200);
  assert.equal((await sw.handle('road', req(NVDB(POS, 'a=2')), ctx)).status, 404);
  assert.equal(net.calls.length, 0);
});

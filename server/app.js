import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, HttpError } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://unpkg.com",
  "img-src 'self' data: blob: https://cache.kartverket.no",
  "connect-src 'self' https://router.project-osrm.org",
  "worker-src blob:",
  "frame-ancestors 'none'",
].join('; ');

export function defaultConfig(env = process.env) {
  const routing = {
    car: env.ROUTING_CAR ?? 'https://router.project-osrm.org/route/v1/driving',
  };
  if (env.ROUTING_FOOT) routing.foot = env.ROUTING_FOOT;
  if (env.ROUTING_BIKE) routing.bike = env.ROUTING_BIKE;
  return {
    routing,
    elevationUrl: env.ELEVATION_URL ?? 'https://ws.geonorge.no/hoydedata/v1/punkt',
  };
}

// Elevation via Kartverket's hoydedata point service (koordsys 4258 = ETRS89 lat/lon).
// Proxied through the server to keep the browser free of CORS trouble and to cache.
export class Elevation {
  constructor({ url, fetchImpl = fetch, cacheSize = 5000 }) {
    this.url = url;
    this.fetch = fetchImpl;
    this.cache = new Map();
    this.cacheSize = cacheSize;
  }

  async at(lat, lon) {
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const u = new URL(this.url);
    u.searchParams.set('nord', String(lat));
    u.searchParams.set('ost', String(lon));
    u.searchParams.set('koordsys', '4258');
    u.searchParams.set('geojson', 'false');
    const res = await this.fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new HttpError(502, `Elevation service returned ${res.status}`);
    const body = await res.json();
    const z = body?.punkter?.[0]?.z;
    const value = typeof z === 'number' && Number.isFinite(z) ? Math.round(z * 10) / 10 : null;
    if (this.cache.size >= this.cacheSize) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, value);
    return value;
  }

  async many(points, concurrency = 6) {
    const out = new Array(points.length);
    let next = 0;
    const worker = async () => {
      while (next < points.length) {
        const i = next++;
        const [lat, lon] = points[i];
        out[i] = await this.at(lat, lon);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, points.length) }, worker));
    return out;
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

export function createApp({ dataFile = null, config = defaultConfig(), elevation, store } = {}) {
  const st = store ?? new Store(dataFile);
  const elev = elevation ?? new Elevation({ url: config.elevationUrl });
  const ready = st.load();

  const authed = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const user = st.userByToken(m?.[1]);
    if (!user) throw new HttpError(401, 'Not signed in');
    return user.id;
  };

  const routes = [
    ['POST', /^\/api\/register$/, async (req) => {
      const body = await readJson(req);
      return [201, st.register(body.name)];
    }],
    ['GET', /^\/api\/config$/, async () => [200, config]],
    ['GET', /^\/api\/state$/, async (req) => [200, st.state(authed(req))]],
    ['POST', /^\/api\/position$/, async (req) => {
      const me = authed(req);
      const b = await readJson(req);
      return [200, st.setPosition(me, { lat: Number(b.lat), lon: Number(b.lon), accuracy: Number(b.accuracy) })];
    }],
    ['POST', /^\/api\/visibility$/, async (req) => {
      const me = authed(req);
      const b = await readJson(req);
      return [200, st.setVisible(me, b.visible === true)];
    }],
    ['POST', /^\/api\/code\/rotate$/, async (req) => [200, st.rotateCode(authed(req))]],
    ['POST', /^\/api\/contacts$/, async (req) => {
      const me = authed(req);
      const b = await readJson(req);
      return [201, st.pair(me, b.code)];
    }],
    ['PATCH', /^\/api\/contacts\/([0-9a-f-]{36})$/, async (req, [, other]) => {
      const me = authed(req);
      const b = await readJson(req);
      return [200, st.setNickname(me, other, b.nick)];
    }],
    ['DELETE', /^\/api\/contacts\/([0-9a-f-]{36})$/, async (req, [, other]) => {
      st.removeContact(authed(req), other);
      return [204, null];
    }],
    ['PUT', /^\/api\/contacts\/([0-9a-f-]{36})\/admin$/, async (req, [, other]) => {
      const me = authed(req);
      const b = await readJson(req);
      return [200, st.setAdmin(me, other, b.admin === true)];
    }],
    ['GET', /^\/api\/elevation$/, async (req) => {
      authed(req);
      const url = new URL(req.url, 'http://x');
      const lat = Number(url.searchParams.get('lat'));
      const lon = Number(url.searchParams.get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new HttpError(400, 'lat and lon required');
      return [200, { elevation: await elev.at(lat, lon) }];
    }],
    ['POST', /^\/api\/elevations$/, async (req) => {
      authed(req);
      const b = await readJson(req, 64 * 1024);
      const pts = Array.isArray(b.points) ? b.points : [];
      if (pts.length > 100) throw new HttpError(400, 'At most 100 points');
      const clean = pts.map(([lat, lon]) => [Number(lat), Number(lon)]);
      if (clean.some(([la, lo]) => !Number.isFinite(la) || !Number.isFinite(lo))) {
        throw new HttpError(400, 'Invalid point');
      }
      return [200, { elevations: await elev.many(clean) }];
    }],
  ];

  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', CSP);
    try {
      await ready;
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) {
        for (const [method, re, handler] of routes) {
          if (req.method !== method) continue;
          const m = re.exec(url.pathname);
          if (!m) continue;
          const [status, data] = await handler(req, m);
          if (status === 204) return res.writeHead(204).end();
          return sendJson(res, status, data);
        }
        throw new HttpError(404, 'No such endpoint');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return serveStatic(req, res, url.pathname);
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error(err);
      return sendJson(res, 500, { error: 'Server error' });
    }
  });
}

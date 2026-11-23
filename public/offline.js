// The page's side of offline maps: starts the service worker (sw.js), switches "Offline map" mode on
// and off, and reports what is kept on the device. The worker does the saving; see sw.js.

export const CACHE_LABELS = {
  'rope-osm-v1': 'Map tiles',
  'rope-dem-v1': 'Terrain tiles',
  'rope-elev-v1': 'Heights',
};
const TILE_CACHES = Object.keys(CACHE_LABELS);

/** 1536 -> "1.5 kB", 3 400 000 -> "3.4 MB". */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return `${Math.round(n)} B`;
  const units = ['kB', 'MB', 'GB'];
  let v = n;
  let i = -1;
  do { v /= 1000; i++; } while (v >= 1000 && i < units.length - 1);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export const supported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof caches !== 'undefined';

/** Registers the worker. Resolves to the registration, or null when this browser cannot (or must not). */
export async function register(url = 'sw.js') {
  if (!supported() || !window.isSecureContext) return null;
  try {
    return await navigator.serviceWorker.register(url, { updateViaCache: 'none' });
  } catch {
    return null;
  }
}

/** Waits until a worker controls this page (the first visit needs a moment), up to ms. */
async function activeWorker(ms = 4000) {
  if (!supported()) return null;
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
  const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, ms, null))]);
  return navigator.serviceWorker.controller || reg?.active || null;
}

/** Sends the worker a message and waits for its answer. Rejects if there is no worker. */
async function ask(message) {
  const worker = await activeWorker();
  if (!worker) throw new Error('The offline helper is not running');
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => reject(new Error('The offline helper did not answer')), 4000);
    channel.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
    worker.postMessage(message, [channel.port2]);
  });
}

/** Switches Offline map mode in the worker. Resolves to the mode that is now in force. */
export async function setOfflineMode(on) {
  const answer = await ask({ type: 'set-offline', value: on === true });
  return answer.offline === true;
}

export async function getOfflineMode() {
  return (await ask({ type: 'get-offline' })).offline === true;
}

/** What is kept: { tiles: {label: count}, total, bytes, quota }. Sizes are the browser's estimate for the whole app. */
export async function stats() {
  const out = { parts: [], total: 0, bytes: null, quota: null };
  if (!supported()) return out;
  for (const name of TILE_CACHES) {
    let count = 0;
    try { if (await caches.has(name)) count = (await (await caches.open(name)).keys()).length; } catch { /* unreadable: count stays 0 */ }
    out.parts.push({ name, label: CACHE_LABELS[name], count });
    out.total += count;
  }
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) { out.bytes = est.usage ?? null; out.quota = est.quota ?? null; }
  } catch { /* not available */ }
  return out;
}

/** Forgets every saved map, terrain and height tile. The app itself stays. Returns how many were removed. */
export async function clearSaved() {
  const before = await stats();
  for (const name of TILE_CACHES) {
    try { await caches.delete(name); } catch { /* ignore */ }
  }
  return before.total;
}

/** Asks the browser not to throw the saved data away when the device is short of space. */
export async function keepStorage() {
  try { return (await navigator.storage?.persist?.()) === true; } catch { return false; }
}

// Transport: publish/subscribe over an ntfy server (https://ntfy.sh by default, or your own).
// The server only ever sees topic names and ciphertext (or public cards on inbox topics).

export const DEFAULT_RELAY = 'https://ntfy.sh';

const PUBLISH_TIMEOUT_MS = 15_000;
const RETRY_DELAYS_MS = [1_000, 4_000]; // mobile data drops out for a moment between cells; try again
const CLOSED = 2; // EventSource.CLOSED

/** Why a publish failed: 'offline' (network error/timeout), 'rate' (429), 'server' (other HTTP error). */
export class RelayError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function timeoutSignal(ms) {
  if (AbortSignal.timeout) return AbortSignal.timeout(ms);
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), ms);
  return ctl.signal;
}

export class Relay {
  constructor(base = DEFAULT_RELAY, { fetchImpl, EventSourceImpl, delays = RETRY_DELAYS_MS } = {}) {
    this.base = base.replace(/\/$/, '');
    this.fetch = fetchImpl ?? ((...a) => fetch(...a));
    this.EventSource = EventSourceImpl ?? globalThis.EventSource;
    this.delays = delays;
    this.subs = new Map(); // topic -> { es, onMessage, since, lastId }
  }

  /** Posts once, retrying network errors, timeouts, 429 and 5xx a couple of times before giving up. */
  async publish(topic, text) {
    let err;
    for (let attempt = 0; attempt <= this.delays.length; attempt++) {
      if (attempt) await sleep(this.delays[attempt - 1]);
      let res;
      try {
        res = await this.fetch(`${this.base}/${topic}`, { method: 'POST', body: text, signal: timeoutSignal(PUBLISH_TIMEOUT_MS) });
      } catch (e) {
        err = new RelayError('offline', e?.message || 'Network error');
        continue;
      }
      if (res.ok) return;
      err = new RelayError(res.status === 429 ? 'rate' : 'server', `Relay refused message (${res.status})`);
      if (res.status !== 429 && res.status < 500) throw err; // other 4xx won't fix itself
    }
    throw err;
  }

  /** onMessage(text, unixSeconds). Reconnects automatically; `since` replays recent messages. */
  subscribe(topic, onMessage, since = '5m') {
    if (this.subs.has(topic)) return;
    const sub = { es: null, onMessage, since, lastId: null };
    this.subs.set(topic, sub);
    this.#open(topic, sub);
  }

  #open(topic, sub) {
    // After a drop, resume from the last message seen so nothing sent meanwhile is missed.
    const since = sub.lastId ?? sub.since;
    const es = new this.EventSource(`${this.base}/${topic}/sse?since=${encodeURIComponent(since)}`);
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.event !== 'message') return;
        if (data.id) sub.lastId = data.id;
        if (typeof data.message === 'string') sub.onMessage(data.message, data.time);
      } catch {
        /* ignore malformed events */
      }
    };
    // The browser retries a dropped stream by itself, but gives up for good after an HTTP error
    // (a 429, or a captive page while the phone switches networks). Then we reopen it ourselves.
    es.onerror = () => {
      if (es.readyState === CLOSED) setTimeout(() => { if (sub.es === es && this.subs.get(topic) === sub) this.#open(topic, sub); }, 5_000);
    };
    sub.es = es;
  }

  /** Reopens streams that gave up (or all, with force). Call when the network returns or the page wakes. */
  reconnect({ force = false } = {}) {
    for (const [topic, sub] of this.subs) {
      if (force || sub.es.readyState === CLOSED) {
        sub.es.close();
        this.#open(topic, sub);
      }
    }
  }

  unsubscribe(topic) {
    this.subs.get(topic)?.es.close();
    this.subs.delete(topic);
  }

  closeAll() {
    for (const sub of this.subs.values()) sub.es.close();
    this.subs.clear();
  }
}

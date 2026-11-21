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

const short = (topic) => topic.replace(/^(rope-(?:inbox-|pair-)?)(.{6}).*$/, '$1$2…');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function timeoutSignal(ms) {
  if (AbortSignal.timeout) return AbortSignal.timeout(ms);
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), ms);
  return ctl.signal;
}

export class Relay {
  constructor(base = DEFAULT_RELAY, { fetchImpl, EventSourceImpl, delays = RETRY_DELAYS_MS, log = () => {} } = {}) {
    this.base = base.replace(/\/$/, '');
    this.fetch = fetchImpl ?? ((...a) => fetch(...a));
    this.EventSource = EventSourceImpl ?? globalThis.EventSource;
    this.delays = delays;
    this.log = log; // log(level, text): 'info' | 'warn' | 'error', for the debug overlay
    this.subs = new Map(); // topic -> { es, onMessage, since, lastId, opens, errors, lastMsgAt }
    this.stats = { sent: 0, failed: 0, retries: 0, rateLimited: 0, lastOkAt: 0, lastError: '', lastErrorAt: 0 };
  }

  #failed(err) {
    this.stats.failed++;
    if (err.kind === 'rate') this.stats.rateLimited++;
    this.stats.lastError = err.message;
    this.stats.lastErrorAt = Date.now();
    this.log(err.kind === 'rate' ? 'warn' : 'error', `publish failed: ${err.message}`);
    return err;
  }

  /** Posts once, retrying network errors, timeouts and 5xx a couple of times before giving up. A 429 is not retried. */
  async publish(topic, text) {
    let err;
    for (let attempt = 0; attempt <= this.delays.length; attempt++) {
      if (attempt) {
        this.stats.retries++;
        this.log('warn', `publish retry ${attempt} after: ${err.message}`);
        await sleep(this.delays[attempt - 1]);
      }
      let res;
      try {
        res = await this.fetch(`${this.base}/${topic}`, { method: 'POST', body: text, signal: timeoutSignal(PUBLISH_TIMEOUT_MS) });
      } catch (e) {
        err = new RelayError('offline', e?.message || 'Network error');
        continue;
      }
      if (res.ok) {
        this.stats.sent++;
        this.stats.lastOkAt = Date.now();
        return;
      }
      if (res.status === 429) {
        // Rate-limited: retrying soon only digs deeper. Say how long to wait, if the server told us.
        err = new RelayError('rate', 'Relay rate limit (429)');
        const after = Number(res.headers?.get?.('Retry-After'));
        if (Number.isFinite(after) && after > 0) err.retryAfterMs = Math.min(after, 600) * 1000;
        throw this.#failed(err);
      }
      err = new RelayError('server', `Relay refused message (${res.status})`);
      if (res.status < 500) throw this.#failed(err); // other 4xx won't fix itself
    }
    throw this.#failed(err);
  }

  /** onMessage(text, unixSeconds). Reconnects automatically; `since` replays recent messages. */
  subscribe(topic, onMessage, since = '5m') {
    if (this.subs.has(topic)) return;
    const sub = { es: null, onMessage, since, lastId: null, opens: 0, errors: 0, lastMsgAt: 0, paused: false, pausedAt: 0, isOpen: false };
    this.subs.set(topic, sub);
    this.#open(topic, sub);
  }

  #open(topic, sub) {
    // After a drop or a pause, resume from the last message seen (or from shortly before the pause)
    // so nothing sent meanwhile is missed.
    const since = sub.lastId ?? (sub.pausedAt ? String(Math.floor(sub.pausedAt / 1000) - 5) : sub.since);
    sub.isOpen = false;
    const es = new this.EventSource(`${this.base}/${topic}/sse?since=${encodeURIComponent(since)}`);
    sub.opens++;
    if (sub.opens > 1) this.log('info', `stream ${short(topic)} reopened (#${sub.opens})`);
    es.onopen = () => {
      sub.isOpen = true;
      this.log('info', `stream ${short(topic)} connected`);
    };
    es.onmessage = (e) => {
      sub.lastMsgAt = Date.now();
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
      if (sub.es !== es) return;
      sub.isOpen = false;
      sub.errors++;
      this.log(es.readyState === CLOSED ? 'error' : 'warn',
        `stream ${short(topic)} ${es.readyState === CLOSED ? 'closed by the browser, reopening in 5 s' : 'dropped, browser retrying'}`);
      if (es.readyState === CLOSED) setTimeout(() => { if (sub.es === es && !sub.paused && this.subs.get(topic) === sub) this.#open(topic, sub); }, 5_000);
    };
    sub.es = es;
  }

  /** Reopens streams that gave up (or all, with force). Call when the network returns or the page wakes. */
  reconnect({ force = false } = {}) {
    for (const [topic, sub] of this.subs) {
      if (sub.paused) continue;
      if (force || sub.es.readyState === CLOSED) {
        sub.es.close();
        this.#open(topic, sub);
      }
    }
  }

  /**
   * Stop listening on a topic for now (a direct link carries the traffic), keeping its place.
   * resume() picks up every message posted meanwhile, so a request to reconnect isn't lost.
   */
  pause(topic) {
    const sub = this.subs.get(topic);
    if (!sub || sub.paused) return;
    sub.paused = true;
    sub.pausedAt = Date.now();
    sub.isOpen = false;
    sub.es.close();
    this.log('info', `stream ${short(topic)} paused (direct link)`);
  }

  resume(topic) {
    const sub = this.subs.get(topic);
    if (!sub || !sub.paused) return;
    sub.paused = false;
    this.#open(topic, sub);
    sub.pausedAt = 0;
  }

  /** 'open' | 'connecting' | 'closed' | 'paused' | null (not subscribed). */
  streamState(topic) {
    const sub = this.subs.get(topic);
    if (!sub) return null;
    if (sub.paused) return 'paused';
    return sub.isOpen && sub.es.readyState === 1 ? 'open' : sub.es.readyState === CLOSED ? 'closed' : 'connecting';
  }

  /** For the debug overlay: one row per stream. */
  streams() {
    return [...this.subs].map(([topic, sub]) => ({
      topic, state: this.streamState(topic), opens: sub.opens, errors: sub.errors, lastMsgAt: sub.lastMsgAt,
    }));
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

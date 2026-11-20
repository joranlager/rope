// Debug overlay: four quick taps on "All" turn it on or off. It shows connection state, counters
// and a log of recent events and errors on top of the map, for diagnosing problems on a phone.
// The log is always kept (it is small); the overlay only draws while it is on.

export const TAPS_TO_TOGGLE = 4;
export const TAP_WINDOW_MS = 1_500;
const MAX_ENTRIES = 300;
const STORE_KEY = 'rope.debug';

/** Returns tap(now) -> true when this is the TAPS_TO_TOGGLE-th tap within TAP_WINDOW_MS. */
export function tapCounter(count = TAPS_TO_TOGGLE, windowMs = TAP_WINDOW_MS) {
  let taps = [];
  return (now = Date.now()) => {
    taps = taps.filter((t) => now - t <= windowMs);
    taps.push(now);
    if (taps.length < count) return false;
    taps = [];
    return true;
  };
}

/** "4 s", "12 min", "3 h" ago; "-" for never. */
export function ago(ts, now = Date.now()) {
  if (!ts) return '-';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 90) return `${s} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

export class DebugLog {
  constructor(max = MAX_ENTRIES) {
    this.max = max;
    this.entries = []; // { ts, level, src, text }
    this.counts = { warn: 0, error: 0 };
  }

  add(level, src, text) {
    const last = this.entries[this.entries.length - 1];
    if (last && last.level === level && last.src === src && last.text === text) {
      last.repeat = (last.repeat ?? 1) + 1; // collapse floods of the same line
      last.ts = Date.now();
    } else {
      this.entries.push({ ts: Date.now(), level, src, text: String(text).slice(0, 300) });
      if (this.entries.length > this.max) this.entries.shift();
    }
    if (level in this.counts) this.counts[level]++;
  }

  clear() {
    this.entries = [];
    this.counts = { warn: 0, error: 0 };
  }

  /** Plain text for copying. */
  text() {
    return this.entries.map((e) => `${clock(e.ts)} ${e.level.toUpperCase().padEnd(5)} ${e.src}: ${e.text}${e.repeat ? ` (x${e.repeat})` : ''}`).join('\n');
  }
}

const clock = (ts) => new Date(ts).toTimeString().slice(0, 8);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export const debugLog = new DebugLog();

/** Logger bound to a source name: dbg('relay')('warn', 'text'). */
export const logger = (src) => (level, text) => debugLog.add(level, src, text);

/**
 * The overlay. snapshot() returns [{ title, rows: [[label, value, tone?]] }] (it may be async);
 * it is called once a second while the overlay is shown.
 */
export class DebugOverlay {
  constructor(snapshot) {
    this.snapshot = snapshot;
    this.el = null;
    this.timer = null;
    this.on = false;
    try { this.on = localStorage.getItem(STORE_KEY) === '1'; } catch { /* storage blocked */ }
    if (this.on) this.#show();
  }

  toggle() {
    this.on = !this.on;
    try { localStorage.setItem(STORE_KEY, this.on ? '1' : '0'); } catch { /* storage blocked */ }
    if (this.on) this.#show();
    else this.#hide();
    return this.on;
  }

  #show() {
    if (!this.el) {
      this.el = document.createElement('section');
      this.el.id = 'debug-overlay';
      this.el.setAttribute('aria-label', 'Debug information');
      this.el.innerHTML = `<div class="dbg-bar"><strong>Debug</strong>
        <span class="dbg-counts"></span>
        <button type="button" data-dbg="copy">Copy</button>
        <button type="button" data-dbg="clear">Clear</button>
        <button type="button" data-dbg="close" aria-label="Close debug overlay">×</button></div>
        <div class="dbg-body"><div class="dbg-state"></div><ol class="dbg-log"></ol></div>`;
      this.el.addEventListener('click', (e) => this.#onClick(e));
      document.body.appendChild(this.el);
    }
    this.el.hidden = false;
    this.#render();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.#render(), 1_000);
  }

  #hide() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.el) this.el.hidden = true;
  }

  async #onClick(e) {
    const act = e.target.closest('[data-dbg]')?.dataset.dbg;
    if (act === 'close') this.toggle();
    else if (act === 'clear') { debugLog.clear(); this.#render(); }
    else if (act === 'copy') {
      const text = `${this.el.querySelector('.dbg-state').innerText}\n\n${debugLog.text()}`;
      try { await navigator.clipboard.writeText(text); e.target.textContent = 'Copied'; }
      catch { e.target.textContent = 'Copy failed'; }
      setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
    }
  }

  async #render() {
    if (!this.el || this.el.hidden) return;
    let sections = [];
    try { sections = await this.snapshot(); }
    catch (err) { sections = [{ title: 'Snapshot failed', rows: [['error', err.message, 'error']] }]; }
    if (!this.on) return;
    this.el.querySelector('.dbg-counts').textContent = `${debugLog.counts.error} errors · ${debugLog.counts.warn} warnings`;
    this.el.querySelector('.dbg-state').innerHTML = sections.map((s) => `<div class="dbg-sec"><div class="dbg-title">${esc(s.title)}</div>${
      s.rows.map(([k, v, tone]) => `<div class="dbg-row${tone ? ` ${tone}` : ''}"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('')}</div>`).join('');
    const log = this.el.querySelector('.dbg-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    log.innerHTML = debugLog.entries.slice(-120).map((e) =>
      `<li class="${e.level}"><time>${clock(e.ts)}</time> <b>${esc(e.src)}</b> ${esc(e.text)}${e.repeat ? ` <i>×${e.repeat}</i>` : ''}</li>`).join('');
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
}

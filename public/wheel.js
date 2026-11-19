// A two-wheel picker, in the style of an iOS picker: one wheel for a number, one for a unit
// (m / km). It is used to choose the trail length for a person. The meaning of the wheels is
// in trace.js (pure, tested); this file is only the on-screen wheel.
//
// Each wheel is a scroll-snapping column. Whatever sits in the highlighted band is the value.
// Touch and trackpad scrolling, the mouse wheel, clicking an item and the arrow keys all work.

import { UNITS, wheelValues, changeUnit, metersFromWheel, wheelFromMeters } from './trace.js';

const ITEM = 44;       // px per row; must match .wheel-item in style.css
const SETTLE_MS = 140; // a wheel has "stopped" this long after its last scroll event

let lastActivity = 0;
/** True while someone is turning a wheel: live updates must not rebuild the page under them. */
export const wheelIsBusy = () => performance.now() - lastActivity < 700;
export const resetWheelActivity = () => { lastActivity = 0; };

const el = (tag, cls) => { const e = document.createElement(tag); e.className = cls; return e; };

/**
 * Mounts a number + unit picker into `host`.
 * meters:   the current length in metres
 * onChange: called with the new length in metres, once a wheel has settled on a different value
 */
export function mountWheelPicker(host, { meters, onChange, label = 'Trail length' }) {
  let cur = wheelFromMeters(meters);
  const timers = {};

  const root = el('div', 'wheel-picker');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', label);
  const band = el('div', 'wheel-band');
  const numberWheel = makeWheel('Number');
  const unitWheel = makeWheel('Unit');
  root.append(band, numberWheel, unitWheel);
  host.replaceChildren(root);

  function makeWheel(name) {
    const w = el('div', 'wheel');
    w.setAttribute('role', 'listbox');
    w.setAttribute('aria-label', name);
    w.tabIndex = 0;
    return w;
  }

  const fill = (wheel, values, text) => wheel.replaceChildren(...values.map((v) => {
    const item = el('div', 'wheel-item');
    item.setAttribute('role', 'option');
    item.textContent = text(v);
    return item;
  }));
  const indexOf = (wheel) => Math.max(0, Math.min(wheel.children.length - 1, Math.round(wheel.scrollTop / ITEM)));
  const mark = (wheel, index) => [...wheel.children].forEach((c, i) => c.setAttribute('aria-selected', String(i === index)));
  const place = (wheel, index) => { wheel.scrollTop = index * ITEM; mark(wheel, index); };
  const scrollToIndex = (wheel, index) => {
    const i = Math.max(0, Math.min(wheel.children.length - 1, index));
    wheel.scrollTo({ top: i * ITEM, behavior: 'smooth' });
  };

  function showCurrent() {
    const values = wheelValues(cur.unit);
    fill(numberWheel, values, String);
    fill(unitWheel, UNITS, String);
    place(numberWheel, values.indexOf(cur.value));
    place(unitWheel, UNITS.indexOf(cur.unit));
  }

  function settle(kind) {
    // The page may have been redrawn since the last scroll event; a wheel that is no longer on the
    // screen must not report a value (its scroll position reads as 0 once detached).
    if (!root.isConnected) return;
    if (kind === 'unit') {
      const unit = UNITS[indexOf(unitWheel)];
      if (unit === cur.unit) return;
      cur = changeUnit(cur, unit); // keep the length as close as the new unit allows
      const values = wheelValues(cur.unit);
      fill(numberWheel, values, String);
      place(numberWheel, values.indexOf(cur.value));
      onChange(metersFromWheel(cur));
    } else {
      const value = wheelValues(cur.unit)[indexOf(numberWheel)];
      if (value === cur.value) return;
      cur = { unit: cur.unit, value };
      onChange(metersFromWheel(cur));
    }
  }

  for (const [wheel, kind] of [[numberWheel, 'number'], [unitWheel, 'unit']]) {
    // Where the last key press is taking this wheel. Quick presses must build on it, not on the
    // scroll position, which is still moving: two presses are two steps.
    let heading = null;
    const goTo = (index) => {
      heading = Math.max(0, Math.min(wheel.children.length - 1, index));
      lastActivity = performance.now();
      scrollToIndex(wheel, heading);
    };
    wheel.addEventListener('scroll', () => {
      lastActivity = performance.now();
      mark(wheel, indexOf(wheel));
      clearTimeout(timers[kind]);
      timers[kind] = setTimeout(() => { heading = null; settle(kind); }, SETTLE_MS);
    }, { passive: true });
    wheel.addEventListener('pointerdown', () => { heading = null; lastActivity = performance.now(); });
    wheel.addEventListener('click', (e) => {
      const item = e.target.closest('.wheel-item');
      if (item) goTo([...wheel.children].indexOf(item));
    });
    wheel.addEventListener('keydown', (e) => {
      const step = { ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5 }[e.key];
      if (step !== undefined) { e.preventDefault(); goTo((heading ?? indexOf(wheel)) + step); }
      else if (e.key === 'Home') { e.preventDefault(); goTo(0); }
      else if (e.key === 'End') { e.preventDefault(); goTo(wheel.children.length - 1); }
    });
  }

  showCurrent();
  // Scroll positions need the wheel to have been laid out; set them again once it has.
  requestAnimationFrame(() => {
    place(numberWheel, wheelValues(cur.unit).indexOf(cur.value));
    place(unitWheel, UNITS.indexOf(cur.unit));
  });
}

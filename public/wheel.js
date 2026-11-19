// A two-wheel picker that behaves like an iOS picker (UIPickerView): a number wheel and a unit
// wheel (Metres, Kilometres, Miles) side by side, with one highlighted band across both.
// It is used to choose the trail length for a person. What the wheels contain is in trace.js
// (pure, tested); this file is only the on-screen wheel.
//
//  - Rows lie on a cylinder: those away from the band shrink, bunch together and fade.
//  - Whatever is in the band is the value. A wheel always comes to rest exactly on a row.
//  - Touch scrolling is native, so it has the platform's own momentum and rubber-banding.
//    A mouse can drag the wheel too (with momentum), and the mouse wheel steps it row by row.
//  - Clicking a row and the arrow / page / home / end keys work as well.

import { UNITS, UNIT_NAMES, wheelValues, changeUnit } from './trace.js';

const ITEM = 44;                 // px per row; must match .wheel-item in style.css
const ROWS = 5;                  // rows visible at once, as on iOS (216 pt picker)
const HEIGHT = ITEM * ROWS;      // must match .wheel-picker / .wheel in style.css
const SETTLE_MS = 140;           // a wheel has "stopped" this long after its last scroll event
const ALPHA = 0.46;              // radians of the cylinder per row: how fast rows turn away
const RADIUS = ITEM / ALPHA;

let lastActivity = 0;
/** True while someone is turning a wheel: live updates must not rebuild the page under them. */
export const wheelIsBusy = () => performance.now() - lastActivity < 700;
export const resetWheelActivity = () => { lastActivity = 0; };

const el = (tag, cls) => { const e = document.createElement(tag); e.className = cls; return e; };

/**
 * Where a row appears on the cylinder. `d` is its distance from the band in rows (negative = above).
 * Returns how far to shift it, how much to squash it (foreshortening) and how visible it is.
 */
export function cylinder(d) {
  const theta = Math.max(-1.5, Math.min(1.5, d * ALPHA));
  const squash = Math.cos(theta);
  return {
    shift: RADIUS * Math.sin(theta) - d * ITEM, // where it appears minus where the layout put it
    squash,
    opacity: Math.abs(d) > 3.4 ? 0 : squash ** 1.7,
  };
}

/**
 * Mounts a number + unit picker into `host`.
 * length:   the current length, { unit, value }
 * onChange: called with the new { unit, value } once a wheel has come to rest on a different one
 */
export function mountWheelPicker(host, { length, onChange, label = 'Trail length' }) {
  let cur = { unit: length.unit, value: length.value };
  const timers = {};

  const root = el('div', 'wheel-picker');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', label);
  const band = el('div', 'wheel-band');
  const numberWheel = makeWheel('Number', 'number');
  const unitWheel = makeWheel('Unit', 'unit');
  root.append(band, numberWheel, unitWheel);
  host.replaceChildren(root);

  function makeWheel(name, kind) {
    const w = el('div', 'wheel');
    w.dataset.kind = kind;
    w.setAttribute('role', 'listbox');
    w.setAttribute('aria-label', name);
    w.tabIndex = 0;
    return w;
  }

  const fill = (wheel, values, text) => wheel.replaceChildren(...values.map((v) => {
    const item = el('div', 'wheel-item');          // the row: it never moves, so scroll-snapping stays exact
    item.setAttribute('role', 'option');
    const face = el('span', 'wheel-face');         // its face is what turns on the cylinder
    face.textContent = text(v);
    item.append(face);
    return item;
  }));

  const count = (wheel) => wheel.children.length;
  const indexOf = (wheel) => Math.max(0, Math.min(count(wheel) - 1, Math.round(wheel.scrollTop / ITEM)));

  // Draw every row of a wheel for its current scroll position.
  function draw(wheel) {
    const pos = wheel.scrollTop / ITEM; // fractional row currently in the band
    const nearest = Math.round(pos);
    for (let i = 0; i < wheel.children.length; i++) {
      const row = wheel.children[i];
      const d = i - pos;
      if (Math.abs(d) > 3.6) { // far away: nothing to draw, so skip the work
        if (row.dataset.far !== '1') { row.firstChild.style.opacity = '0'; row.dataset.far = '1'; }
        continue;
      }
      row.dataset.far = '0';
      const c = cylinder(d);
      const face = row.firstChild;
      face.style.transform = `translateY(${c.shift.toFixed(2)}px) scaleY(${c.squash.toFixed(3)})`;
      face.style.opacity = c.opacity.toFixed(3);
      row.setAttribute('aria-selected', String(i === nearest));
    }
  }

  let drawQueued = false;
  const drawSoon = (wheel) => {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; draw(numberWheel); draw(unitWheel); });
  };

  const place = (wheel, index) => { wheel.scrollTop = index * ITEM; draw(wheel); };
  const scrollToIndex = (wheel, index) => {
    const i = Math.max(0, Math.min(count(wheel) - 1, index));
    wheel.scrollTo({ top: i * ITEM, behavior: 'smooth' });
  };

  function showCurrent() {
    const values = wheelValues(cur.unit);
    fill(numberWheel, values, String);
    fill(unitWheel, UNITS, (u) => UNIT_NAMES[u]);
    place(numberWheel, values.indexOf(cur.value));
    place(unitWheel, UNITS.indexOf(cur.unit));
  }

  function settle(kind) {
    // The page may have been redrawn since the last scroll event; a wheel that is no longer on the
    // screen must not report a value (its scroll position reads as 0 once detached).
    if (!root.isConnected) return;
    const wheel = kind === 'unit' ? unitWheel : numberWheel;
    // A wheel always rests exactly on a row, as on iOS, even if the browser didn't snap it.
    const index = indexOf(wheel);
    if (Math.abs(wheel.scrollTop - index * ITEM) > 1) scrollToIndex(wheel, index);

    if (kind === 'unit') {
      const unit = UNITS[index];
      if (unit === cur.unit) return;
      cur = changeUnit(cur, unit); // keep the length as close as the new unit allows
      const values = wheelValues(cur.unit);
      fill(numberWheel, values, String);
      place(numberWheel, values.indexOf(cur.value));
      onChange({ ...cur });
    } else {
      const value = wheelValues(cur.unit)[index];
      if (value === cur.value) return;
      cur = { unit: cur.unit, value };
      onChange({ ...cur });
    }
  }

  for (const wheel of [numberWheel, unitWheel]) {
    const kind = wheel.dataset.kind;
    // Where the last key press or click is taking this wheel. Quick presses must build on it, not on
    // the scroll position, which is still moving: two presses are two steps.
    let heading = null;
    const goTo = (index) => {
      heading = Math.max(0, Math.min(count(wheel) - 1, index));
      lastActivity = performance.now();
      scrollToIndex(wheel, heading);
    };

    wheel.addEventListener('scroll', () => {
      lastActivity = performance.now();
      drawSoon(wheel);
      clearTimeout(timers[kind]);
      timers[kind] = setTimeout(() => { heading = null; settle(kind); }, SETTLE_MS);
    }, { passive: true });

    // ---- a mouse can drag the wheel, with momentum (touch is native) ----
    let drag = null;
    let swallowClick = false;
    wheel.addEventListener('pointerdown', (e) => {
      heading = null;
      lastActivity = performance.now();
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      drag = { startY: e.clientY, startTop: wheel.scrollTop, lastY: e.clientY, lastT: e.timeStamp, v: 0, moved: false };
      wheel.classList.add('dragging'); // no snapping while it is in the hand
      wheel.setPointerCapture(e.pointerId);
    });
    wheel.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.startY;
      if (Math.abs(dy) > 3) drag.moved = true;
      wheel.scrollTop = drag.startTop - dy;
      const dt = e.timeStamp - drag.lastT;
      if (dt > 0) drag.v = 0.8 * drag.v + 0.2 * ((drag.lastY - e.clientY) / dt); // px per ms, smoothed
      drag.lastY = e.clientY;
      drag.lastT = e.timeStamp;
      lastActivity = performance.now();
    });
    const release = () => {
      if (!drag) return;
      const { moved, v } = drag;
      drag = null;
      wheel.classList.remove('dragging');
      if (moved) {
        swallowClick = true; // the click that ends a drag is not a tap on a row
        setTimeout(() => { swallowClick = false; }, 0);
        // let go: carry on a little in the direction it was going, then come to rest on a row
        const carried = wheel.scrollTop + Math.max(-ITEM * 8, Math.min(ITEM * 8, v * 240));
        goTo(Math.round(carried / ITEM));
      }
    };
    wheel.addEventListener('pointerup', release);
    wheel.addEventListener('pointercancel', release);

    wheel.addEventListener('click', (e) => {
      if (swallowClick) return;
      const item = e.target.closest('.wheel-item');
      if (item) goTo([...wheel.children].indexOf(item));
    });
    wheel.addEventListener('keydown', (e) => {
      const step = { ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5 }[e.key];
      if (step !== undefined) { e.preventDefault(); goTo((heading ?? indexOf(wheel)) + step); }
      else if (e.key === 'Home') { e.preventDefault(); goTo(0); }
      else if (e.key === 'End') { e.preventDefault(); goTo(count(wheel) - 1); }
    });
  }

  showCurrent();
  // Scroll positions need the wheel to have been laid out; set them again once it has.
  requestAnimationFrame(() => {
    place(numberWheel, wheelValues(cur.unit).indexOf(cur.value));
    place(unitWheel, UNITS.indexOf(cur.unit));
  });
}

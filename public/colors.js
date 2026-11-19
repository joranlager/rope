// One colour per person, used for their map marker, avatar, follow arrow and trail.
// Pure, so it is unit tested.
//
// A person has either a chosen palette colour or "auto": a stable colour derived from their id
// (and system blue for me). Everything is returned as '#rrggbb'.

import { colorHex } from './trace.js';

export const ME_HEX = '#007aff';

export function hueOf(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

export function hslToHex(h, s, l) {
  const sat = s / 100;
  const light = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x) => Math.round(255 * x).toString(16).padStart(2, '0');
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

export const autoHex = (id) => (id === 'me' ? ME_HEX : hslToHex(hueOf(id), 65, 45));

/** The person's colour: their chosen palette colour, or their automatic one. */
export const personHex = (id, colorId) => colorHex(colorId) ?? autoHex(id);

const channel = (v) => {
  const x = v / 255;
  return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance of '#rrggbb'. */
export function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/**
 * White or black for a glyph drawn on this colour, so it stays visible on any person colour.
 * White is preferred (as on Apple's own blue) while it keeps at least 3:1 contrast, the
 * threshold for graphics; otherwise black.
 */
export function contrastText(hex) {
  const whiteRatio = 1.05 / (luminance(hex) + 0.05);
  return whiteRatio >= 3 ? '#ffffff' : '#000000';
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hslToHex, autoHex, personHex, contrastText, luminance, hueOf, ME_HEX } from '../public/colors.js';
import { TRACE_COLORS } from '../public/trace.js';

test('hsl converts to hex', () => {
  assert.equal(hslToHex(0, 100, 50), '#ff0000');
  assert.equal(hslToHex(120, 100, 50), '#00ff00');
  assert.equal(hslToHex(240, 100, 50), '#0000ff');
  assert.equal(hslToHex(0, 0, 100), '#ffffff');
});

test('auto colour is stable per person, valid, and blue for me', () => {
  assert.equal(autoHex('me'), ME_HEX);
  assert.equal(autoHex('abc123'), autoHex('abc123'));
  assert.match(autoHex('abc123'), /^#[0-9a-f]{6}$/);
  assert.notEqual(autoHex('abc123'), autoHex('xyz789'));
  assert.ok(hueOf('abc123') >= 0 && hueOf('abc123') < 360);
});

test('a chosen palette colour wins; anything else falls back to auto', () => {
  assert.equal(personHex('abc', 'orange'), '#ff9500');
  assert.equal(personHex('abc', 'auto'), autoHex('abc'));
  assert.equal(personHex('abc', undefined), autoHex('abc'));
  assert.equal(personHex('me', 'nonsense'), ME_HEX);
});

test('the glyph colour keeps at least 3:1 contrast on every palette colour', () => {
  for (const c of TRACE_COLORS) {
    const glyph = contrastText(c.hex);
    const lg = luminance(glyph);
    const lc = luminance(c.hex);
    const ratio = (Math.max(lg, lc) + 0.05) / (Math.min(lg, lc) + 0.05);
    assert.ok(ratio >= 3, `${c.id}: ${glyph} on ${c.hex} is only ${ratio.toFixed(2)}:1`);
  }
});

test('white on dark colours and Apple blue, black on light ones', () => {
  assert.equal(contrastText('#007aff'), '#ffffff');
  assert.equal(contrastText('#000080'), '#ffffff');
  assert.equal(contrastText('#ff9500'), '#000000');
  assert.equal(contrastText('#34c759'), '#000000');
  assert.equal(contrastText('#ffff00'), '#000000');
  assert.equal(contrastText('#ffffff'), '#000000');
});

test('the glyph is visible on every automatic colour too', () => {
  for (let i = 0; i < 200; i++) {
    const bg = autoHex(`person-${i}`);
    const glyph = contrastText(bg);
    const lg = luminance(glyph);
    const lc = luminance(bg);
    assert.ok((Math.max(lg, lc) + 0.05) / (Math.min(lg, lc) + 0.05) >= 3, `${bg} with ${glyph}`);
  }
});

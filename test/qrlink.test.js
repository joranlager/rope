import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeLink, decodeLink, looksLikeLink, trimDescription, PREFIX, MAX_AGE_MS, MAX_TEXT } from '../public/qrlink.js';
import { PeerLink } from '../public/p2p.js';

const card = { v: 1, n: 'Jørån Ølsen', e: 'E'.repeat(87), s: 'S'.repeat(87) };
const desc = (t = 'o', n = 3) => ({ t, u: 'Ab12', p: 'pwdpwdpwdpwdpwdpwdpwdpwd', f: 'F'.repeat(43), c: Array.from({ length: n }, (_, i) => [`192.168.1.${20 + i}`, 51000 + i, 'h', 2122260223 - i]) });
const SID = '0123456789abcdef';

test('an offer code round-trips with the card, the session and the description', () => {
  const text = encodeLink({ kind: 'o', card, sid: SID, d: desc('o') });
  assert.ok(text.startsWith(PREFIX));
  assert.ok(looksLikeLink(text));
  assert.ok(text.length < 1000, `small enough to scan easily (${text.length})`);
  const r = decodeLink(text, { expect: 'o' });
  assert.deepEqual(r.card, card);
  assert.equal(r.sid, SID);
  assert.equal(r.kind, 'o');
  assert.deepEqual(r.d, desc('o'));
});

test('an answer code is the other kind, and the wrong kind is explained', () => {
  const answer = encodeLink({ kind: 'a', card, sid: SID, d: desc('a') });
  assert.equal(decodeLink(answer, { expect: 'a' }).kind, 'a');
  assert.throws(() => decodeLink(answer, { expect: 'o' }), /other kind/);
  assert.throws(() => decodeLink(encodeLink({ kind: 'o', card, sid: SID, d: desc('o') }), { expect: 'a' }), /first code/);
});

test('only the best few candidates are kept, local addresses first', () => {
  const many = { ...desc('o', 0), c: [['84.1.1.1', 1, 's', 5], ['a.local', 2, 'h', 4], ['192.168.1.2', 3, 'h', 3], ['10.0.0.2', 4, 'h', 2], ['10.0.0.3', 5, 'h', 1], ['10.0.0.4', 6, 'h', 0]] };
  const t = trimDescription(many).c;
  assert.equal(t.length, 4);
  assert.ok(t.every((c) => c[2] === 'h'));
});

test('anything that is not a good code is refused with a plain message', () => {
  const good = encodeLink({ kind: 'o', card, sid: SID, d: desc('o') });
  assert.throws(() => decodeLink('https://example.com'), /not a Rope code/);
  assert.throws(() => decodeLink(null), /not a Rope code/);
  assert.throws(() => decodeLink(`${PREFIX}!!!`), /damaged/);
  assert.throws(() => decodeLink(`${PREFIX}${btoa('{"k":"x"}')}`), /not a Rope code/);
  assert.throws(() => decodeLink(encodeLink({ kind: 'o', card: { ...card, e: '' }, sid: SID, d: desc('o') })), /no contact/);
  assert.throws(() => decodeLink(encodeLink({ kind: 'o', card, sid: 'zz', d: desc('o') })), /damaged/);
  assert.throws(() => decodeLink(encodeLink({ kind: 'o', card, sid: SID, d: desc('a') })), /damaged/, 'description kind must match');
  assert.throws(() => decodeLink(encodeLink({ kind: 'o', card, sid: SID, d: { ...desc('o'), u: '' } })), /damaged/);
  assert.ok(decodeLink(good));
});

test('a code expires after a few minutes', () => {
  const t0 = 1_700_000_000_000;
  const text = encodeLink({ kind: 'o', card, sid: SID, d: desc('o'), now: t0 });
  assert.ok(decodeLink(text, { now: t0 + MAX_AGE_MS - 1000 }));
  assert.throws(() => decodeLink(text, { now: t0 + MAX_AGE_MS + 1000 }), /expired/);
  assert.throws(() => decodeLink(text, { now: t0 - MAX_AGE_MS - 1000 }), /expired/, 'from the future');
});

test('a code that would not fit in one QR is refused when made', () => {
  const huge = { ...card, n: 'x'.repeat(40) };
  assert.ok(encodeLink({ kind: 'o', card: huge, sid: SID, d: desc('o', 4) }).length < MAX_TEXT);
});

test('a link made by scanning can choose who offers and how long an attempt may take', () => {
  const a = new PeerLink({ myId: 'zzz', theirId: 'aaa', signal() {}, onMessage() {}, offerer: true, attemptMs: 300_000 });
  assert.equal(a.offerer, true);
  assert.equal(a.attemptMs, 300_000);
  const b = new PeerLink({ myId: 'zzz', theirId: 'aaa', signal() {}, onMessage() {} });
  assert.equal(b.offerer, false, 'by default the lower id offers');
  assert.equal(b.attemptMs, 45_000);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldSendPosition, theyCanSeeMe, seeingThem, canRemoveContact,
  applyPairMessage, adminPayload, isStale, STALE_MS,
} from '../public/social.js';

const now = 1_000_000_000_000;
const pos = (ts = now, lat = 59.9, lon = 10.7) => ({ t: 'pos', ts, lat, lon, acc: 5 });

test('I send my position only when sharing, or to an admin', () => {
  assert.equal(shouldSendPosition({ visible: true }, {}), true);
  assert.equal(shouldSendPosition({ visible: false }, {}), false);
  assert.equal(shouldSendPosition({ visible: false }, { adminOverMe: true }), true);
  assert.equal(theyCanSeeMe({ visible: false }, { adminOverMe: true }), true);
});

test('hidden contacts are not shown, but an admin sees them anyway', () => {
  assert.equal(seeingThem({ theirVisible: false }), false);
  assert.equal(seeingThem({ theirVisible: false, youAdminThem: true }), true);
  assert.deepEqual(applyPairMessage({ theirVisible: false }, pos(), { now }), {});
  const shown = applyPairMessage({ theirVisible: false, youAdminThem: true }, pos(), { now });
  assert.equal(shown.pos.lat, 59.9);
});

test('turning sharing off clears the position unless I am their admin', () => {
  const c = { theirVisible: true, pos: { lat: 1, lon: 1, ts: now } };
  assert.deepEqual(applyPairMessage(c, { t: 'vis', v: false }), { theirVisible: false, pos: null });
  assert.deepEqual(applyPairMessage({ ...c, youAdminThem: true }, { t: 'vis', v: false }), { theirVisible: false });
});

test('replayed, stale, and invalid positions are ignored', () => {
  const c = { theirVisible: true, pos: { lat: 1, lon: 1, ts: now } };
  assert.deepEqual(applyPairMessage(c, pos(now), { now }), {}); // replay
  assert.deepEqual(applyPairMessage(c, pos(now - 1), { now }), {}); // older
  assert.deepEqual(applyPairMessage({ theirVisible: true }, pos(now - 3_600_000), { now }), {}); // far-off clock
  assert.deepEqual(applyPairMessage({ theirVisible: true }, pos(now, 120, 0), { now }), {}); // bad latitude
  assert.equal(applyPairMessage(c, pos(now + 1000), { now }).pos.ts, now + 1000);
});

test('an admin grant is applied only when its signature was verified', () => {
  const grant = { ...adminPayload(true, now), sig: 'x' };
  assert.deepEqual(applyPairMessage({}, grant, { adminVerified: false }), {});
  assert.deepEqual(applyPairMessage({}, grant, { adminVerified: true }), { adminOverMe: true, adminTs: now });
});

test('a stale or replayed grant cannot undo a newer one', () => {
  const c = { adminOverMe: true, adminTs: now };
  assert.deepEqual(applyPairMessage(c, adminPayload(false, now - 5), { adminVerified: true }), {});
  assert.deepEqual(applyPairMessage(c, adminPayload(false, now), { adminVerified: true }), {});
  assert.deepEqual(applyPairMessage(c, adminPayload(false, now + 1), { adminVerified: true }), { adminOverMe: false, adminTs: now + 1 });
});

test('the subject cannot remove a contact that holds an admin grant', () => {
  assert.equal(canRemoveContact({ adminOverMe: true }), false);
  assert.equal(canRemoveContact({ adminOverMe: false }), true);
});

test('positions go stale after five minutes', () => {
  assert.equal(isStale({ ts: now }, now + STALE_MS - 1), false);
  assert.equal(isStale({ ts: now }, now + STALE_MS + 1), true);
  assert.equal(isStale(null), true);
});

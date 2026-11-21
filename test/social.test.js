import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldSendPosition, theyCanSeeMe, seeingThem, canRemoveContact,
  applyPairMessage, adminPayload, adminAnswerPayload, migrateAdmin, isStale, STALE_MS,
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
  const off = { t: 'vis', v: false, ts: now };
  assert.deepEqual(applyPairMessage(c, off, { now }), { theirVisible: false, pos: null, hw: { vis: now } });
  assert.deepEqual(applyPairMessage({ ...c, youAdminThem: true }, off, { now }), { theirVisible: false, hw: { vis: now } });
});

test('replayed, stale, and invalid positions are ignored', () => {
  const c = { theirVisible: true, pos: { lat: 1, lon: 1, ts: now } };
  assert.deepEqual(applyPairMessage(c, pos(now), { now }), {}); // replay
  assert.deepEqual(applyPairMessage(c, pos(now - 1), { now }), {}); // older
  assert.deepEqual(applyPairMessage({ theirVisible: true }, pos(now - 3_600_000), { now }), {}); // far-off clock
  assert.deepEqual(applyPairMessage({ theirVisible: true }, pos(now, 120, 0), { now }), {}); // bad latitude
  assert.equal(applyPairMessage(c, pos(now + 1000), { now }).pos.ts, now + 1000);
});

test('an admin request only asks: rights come with my approval', () => {
  const req = { ...adminPayload(true, now), sig: 'x' };
  assert.deepEqual(applyPairMessage({}, req, { adminVerified: false, now }), {});
  assert.deepEqual(applyPairMessage({}, req, { adminVerified: true, now }), { adminAsk: now });
  // answered (approved or declined) requests set adminTs, so the same request replayed is ignored
  assert.deepEqual(applyPairMessage({ adminTs: now }, req, { adminVerified: true, now }), {});
  // already my admin: nothing to ask
  assert.deepEqual(applyPairMessage({ adminOverMe: true, adminTs: now - 9 }, req, { adminVerified: true, now }), {});
});

test('an admin can release me; old releases are ignored', () => {
  const c = { adminOverMe: true, adminTs: now };
  assert.deepEqual(applyPairMessage(c, adminPayload(false, now - 5), { adminVerified: true, now }), {});
  assert.deepEqual(applyPairMessage(c, adminPayload(false, now), { adminVerified: true, now }), {});
  assert.deepEqual(applyPairMessage(c, adminPayload(false, now + 1), { adminVerified: true, now }), { adminOverMe: false, adminAsk: null, adminTs: now + 1 });
});

test('my request becomes admin rights only with their signed yes to that very request', () => {
  const c = { adminReq: { ts: now - 1000, sig: 's' } };
  const yes = { ...adminAnswerPayload(true, now - 1000), sig: 'x' };
  assert.deepEqual(applyPairMessage(c, yes, { adminVerified: false, now }), {});
  assert.deepEqual(applyPairMessage(c, { ...yes, req: now - 2000 }, { adminVerified: true, now }), {});
  assert.deepEqual(applyPairMessage(c, yes, { adminVerified: true, now }), { youAdminThem: true, adminReq: null });
  assert.deepEqual(applyPairMessage(c, { ...adminAnswerPayload(false, now - 1000), sig: 'x' }, { adminVerified: true, now }),
    { youAdminThem: false, adminReq: null, adminDeclined: now - 1000 });
  assert.deepEqual(applyPairMessage({}, yes, { adminVerified: true, now }), {}); // nothing asked
});

test('grants from before consent was required must be approved again', () => {
  assert.deepEqual(migrateAdmin({ adminOverMe: true, adminTs: 5 }), { adminConsent: 2, adminOverMe: false, adminAsk: 5 });
  assert.deepEqual(migrateAdmin({ youAdminThem: true }), { adminConsent: 2, youAdminThem: false, adminReask: true });
  assert.deepEqual(migrateAdmin({ adminConsent: 2, adminOverMe: true }), {});
});

test('replayed visibility and positions are rejected, also after a reload', () => {
  const vis = { t: 'vis', v: false, ts: now - 1000 };
  const p1 = applyPairMessage({ theirVisible: true }, vis, { now });
  assert.equal(p1.hw.vis, now - 1000);
  assert.deepEqual(applyPairMessage({ hw: p1.hw }, vis, { now }), {});
  assert.deepEqual(applyPairMessage({}, { t: 'vis', v: true }, { now }), {}); // no timestamp
  const pos = { t: 'pos', lat: 59.9, lon: 10.7, ts: now - 2000 };
  const c = { theirVisible: true, hw: { pos: now - 1000 } }; // pos itself is not kept across reloads, hw is
  assert.deepEqual(applyPairMessage(c, pos, { now }), {});
  assert.equal(applyPairMessage({ theirVisible: true }, pos, { now }).pos.ts, now - 2000);
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

// Pure rules for visibility, admin grants and incoming messages. No I/O, so it is unit tested.
//
// Contact fields used here:
//   theirVisible  the contact says they are sharing their position
//   youAdminThem  I hold admin rights over them (I see them even if they hide)
//   adminOverMe   they are my admin: they asked (signed) and I approved (signed)
//   adminAsk      ts of their signed request to become my admin, waiting for my answer
//   adminReq      { ts, sig } my own signed request to become their admin, waiting for their answer
//   hw            { [type]: ts } newest message seen per type (replay protection, kept across reloads)
//   pos           { lat, lon, acc, ts } last position received
//   zones, zonesTs  the zones my admin set for me (kept while they are my admin) and the time of that set
//   zonesOut      { ts, zones, sig } the set I last sent to them as their admin, kept to re-send

import { fromWire } from './zones.js';

export const STALE_MS = 5 * 60 * 1000;
export const MAX_SKEW_MS = 10 * 60 * 1000;

/** My client sends my position to a contact only if I share, or they are my admin. */
export function shouldSendPosition(me, contact) {
  return Boolean(me.visible || contact.adminOverMe);
}

/** Whether this contact can currently see me. */
export function theyCanSeeMe(me, contact) {
  return Boolean(me.visible || contact.adminOverMe);
}

/** Whether I'm entitled to see this contact's position. */
export function seeingThem(contact) {
  return Boolean(contact.theirVisible || contact.youAdminThem);
}

/** The subject cannot drop an admin's rights, or the contact, while a grant is in force. */
export function canRemoveContact(contact) {
  return !contact.adminOverMe;
}

const validCoord = (lat, lon) =>
  Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/**
 * Applies a decrypted pair-channel message to a contact and returns the changed fields.
 * `adminVerified` must be true only when the admin signature was checked by the caller.
 */
export function applyPairMessage(contact, msg, { now = Date.now(), adminVerified = false } = {}) {
  if (!msg || typeof msg !== 'object') return {};
  switch (msg.t) {
    case 'pos': {
      if (!seeingThem(contact)) return {}; // they should not be sending; don't show it
      const lat = Number(msg.lat);
      const lon = Number(msg.lon);
      const ts = Number(msg.ts);
      if (!validCoord(lat, lon) || !Number.isFinite(ts)) return {};
      if (Math.abs(now - ts) > MAX_SKEW_MS) return {};
      if (contact.pos && ts <= contact.pos.ts) return {}; // replayed or out-of-order
      if (!fresh(contact, { ...msg, t: 'pos' }, now)) return {}; // older than one seen before a reload
      return { pos: { lat, lon, acc: Number.isFinite(msg.acc) ? msg.acc : null, ts }, hw: { ...contact.hw, pos: ts } };
    }
    case 'vis': {
      if (!fresh(contact, msg, now)) return {};
      const theirVisible = msg.v === true;
      const patch = theirVisible || contact.youAdminThem ? { theirVisible } : { theirVisible, pos: null };
      return { ...patch, hw: { ...contact.hw, vis: Number(msg.ts) } };
    }
    case 'admin': {
      // A request (on) or a release (off) from someone who wants to be, or is, my admin.
      // A request never gives rights by itself: it waits for my approval.
      if (!adminVerified) return {};
      const ts = Number(msg.ts);
      // No age limit: a request is re-sent until answered, perhaps days later. Replays are caught by
      // adminTs, which is set to the request's time when I approve or decline it.
      if (!Number.isFinite(ts)) return {};
      if (contact.adminTs && ts <= contact.adminTs) return {}; // already answered, stale or replayed
      if (contact.adminAsk && ts <= contact.adminAsk) return {};
      if (msg.on !== true) return { adminOverMe: false, adminAsk: null, adminTs: ts, zones: [] }; // their zones go with their rights (zonesTs stays: an old set cannot be replayed later)
      return contact.adminOverMe ? {} : { adminAsk: ts };
    }
    case 'adminok': {
      // Their answer to my request; signed by them over the request's timestamp.
      if (!adminVerified || !contact.adminReq || Number(msg.req) !== contact.adminReq.ts) return {};
      return msg.ok === true ? { youAdminThem: true, adminReq: null } : { youAdminThem: false, adminReq: null, adminDeclined: Number(msg.req) };
    }
    case 'zones': {
      // Zones set by my admin. Only accepted from someone who is my admin right now, with a valid
      // signature, newer than the set I already hold. There is no age limit: it is re-sent until it arrives.
      if (!adminVerified || !contact.adminOverMe) return {};
      const ts = Number(msg.ts);
      if (!Number.isFinite(ts) || ts <= (contact.zonesTs ?? 0)) return {};
      const zones = fromWire(msg.zones);
      if (!zones) return {};
      return { zones, zonesTs: ts };
    }
    default:
      return {};
  }
}

/** The part of an admin request or release that the requester signs. */
export function adminPayload(on, ts) {
  return { t: 'admin', on: Boolean(on), ts };
}

/** The part of an answer to an admin request that the subject signs. */
export function adminAnswerPayload(ok, req) {
  return { t: 'adminok', ok: Boolean(ok), req };
}

// Replay protection: a message must be recent and newer than the last one of its type, which is
// remembered across reloads (contact.hw), so the relay can't replay old ciphertext to us.
function fresh(contact, msg, now) {
  const ts = Number(msg.ts);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) return false;
  return !(contact.hw?.[msg.t] >= ts);
}

/**
 * Contacts saved by versions where admin rights didn't need consent: a grant I never approved
 * becomes a request for me to answer, and my own unconfirmed grant becomes a pending request.
 */
export function migrateAdmin(contact) {
  if (contact.adminConsent === 2) return {};
  const patch = { adminConsent: 2 };
  if (contact.adminOverMe) Object.assign(patch, { adminOverMe: false, adminAsk: contact.adminTs ?? Date.now() });
  if (contact.youAdminThem === true) Object.assign(patch, { youAdminThem: false, adminReask: true });
  return patch;
}

export function isStale(pos, now = Date.now()) {
  return !pos || now - pos.ts > STALE_MS;
}

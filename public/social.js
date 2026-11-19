// Pure rules for visibility, admin grants and incoming messages. No I/O, so it is unit tested.
//
// Contact fields used here:
//   theirVisible  the contact says they are sharing their position
//   youAdminThem  I hold admin rights over them (I see them even if they hide)
//   adminOverMe   they hold a verified, signed admin grant over me
//   pos           { lat, lon, acc, ts } last position received

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
      return { pos: { lat, lon, acc: Number.isFinite(msg.acc) ? msg.acc : null, ts } };
    }
    case 'vis': {
      const theirVisible = msg.v === true;
      return theirVisible || contact.youAdminThem ? { theirVisible } : { theirVisible, pos: null };
    }
    case 'admin': {
      if (!adminVerified) return {};
      const ts = Number(msg.ts);
      if (contact.adminTs && ts <= contact.adminTs) return {}; // stale or replayed grant
      return { adminOverMe: msg.on === true, adminTs: ts };
    }
    default:
      return {};
  }
}

/** The part of an admin message that is signed. */
export function adminPayload(on, ts) {
  return { t: 'admin', on: Boolean(on), ts };
}

export function isStale(pos, now = Date.now()) {
  return !pos || now - pos.ts > STALE_MS;
}

// Connecting two phones with QR codes only, no rendezvous server. Pure, so it is unit tested.
//
// Two phones that are close can pair by showing each other two codes:
//
//   1. the first phone shows an OFFER code: its identity card + a WebRTC offer, and the second scans it
//   2. the second phone shows an ANSWER code: its identity card + the WebRTC answer, and the first scans it
//
// Each phone has now seen the other's card by camera (so the keys are authentic: nobody can sit between
// two phones that are looked at in person) and the WebRTC handshake is complete, so the direct link opens
// over the local network (Wi-Fi, a hotspot) with no server in between. The contact's key for the
// encrypted channel is derived from the two cards, exactly as with any other pairing, so later the
// relay, if there is one, can carry the same conversation.
//
// A code is:   ROPE1.<base64url of JSON { k: 'o' | 'a', t, sid, c: card, d: compact description }>
// The compact description is the same one PeerLink exchanges over the relay (see p2p.js).

import { validCompact } from './p2p.js';

export const PREFIX = 'ROPE1.';
export const MAX_AGE_MS = 10 * 60 * 1000;   // a code is only good for a few minutes
export const MAX_TEXT = 2800;               // what one QR code holds at its lowest error correction
const MAX_CANDIDATES = 4;                   // enough for a local link; fewer makes the code simpler to scan

const b64 = {
  enc: (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => decodeURIComponent(escape(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')))),
};

/** Keeps the best few candidates: addresses on the local network first, then public ones. */
export function trimDescription(d) {
  const c = [...(d.c ?? [])].sort((a, b) => (a[2] === 'h' ? 0 : 1) - (b[2] === 'h' ? 0 : 1)).slice(0, MAX_CANDIDATES);
  return { ...d, c };
}

/** The text for the QR code. kind 'o' = offer (first phone), 'a' = answer (second phone). */
export function encodeLink({ kind, card, sid, d, now = Date.now() }) {
  const body = { k: kind, t: now, sid, c: { n: card.n, e: card.e, s: card.s }, d: trimDescription(d) };
  const text = PREFIX + b64.enc(JSON.stringify(body));
  if (text.length > MAX_TEXT) throw new Error('The connection details are too large for one code.');
  return text;
}

/** Does this scanned text look like one of our codes? (Cheap, to ignore other QR codes at once.) */
export const looksLikeLink = (text) => typeof text === 'string' && text.startsWith(PREFIX);

/**
 * Reads and checks a scanned code. Returns { kind, sid, card, d } or throws an Error whose message can be
 * shown to the person. `expect` ('o' or 'a') is the kind that is wanted at this step.
 */
export function decodeLink(text, { expect, now = Date.now() } = {}) {
  if (!looksLikeLink(text)) throw new Error('That is not a Rope code.');
  let body;
  try { body = JSON.parse(b64.dec(text.slice(PREFIX.length))); } catch { throw new Error('That Rope code is damaged. Try scanning again.'); }
  if (!body || (body.k !== 'o' && body.k !== 'a')) throw new Error('That is not a Rope code.');
  if (expect && body.k !== expect) {
    throw new Error(expect === 'o' ? 'That is the other kind of code. Scan the first code they show.' : 'That is the first code. Scan the answer code instead.');
  }
  const c = body.c;
  if (!c || typeof c.n !== 'string' || !c.n || typeof c.e !== 'string' || !c.e || typeof c.s !== 'string' || !c.s) throw new Error('That code has no contact in it.');
  if (typeof body.sid !== 'string' || !/^[0-9a-f]{8,32}$/.test(body.sid)) throw new Error('That Rope code is damaged. Try scanning again.');
  if (!validCompact(body.d) || body.d.t !== body.k) throw new Error('That Rope code is damaged. Try scanning again.');
  const age = now - Number(body.t);
  if (!Number.isFinite(age) || age > MAX_AGE_MS || age < -MAX_AGE_MS) throw new Error('That code has expired. Ask them to show a new one.');
  return { kind: body.k, sid: body.sid, card: { v: 1, n: c.n.slice(0, 40), e: c.e, s: c.s }, d: body.d };
}

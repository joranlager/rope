// Pairing with a short number, made safe by a PAKE (password-authenticated key exchange).
//
// The code, e.g. 37-4821-9305, is 10 digits: the first 2 pick a meeting topic on the relay
// ("nameplate", as in magic-wormhole/BeamBridge), the other 8 are the password. It is shown as
// digits and as a QR code, so it can be scanned screen-to-camera or read out over the phone.
//
// The PAKE is CPace on ristretto255 (draft-irtf-cfrg-cpace), using the audited @noble/curves:
//   g  = hash_to_ristretto255(password, nameplate, session id)       (a secret generator)
//   Y  = y*g with a fresh random scalar y on each side, sent in the clear
//   K  = y*Y_other  -> the same on both sides only if both used the same password
//   ISK = SHA-512(transcript, K) -> a MAC key for key confirmation and an AES key for the cards
// The relay sees only Y values, MACs and ciphertext. It can't test passwords offline: each guess
// needs a live exchange with the person showing the code, and the code is burnt after
// MAX_ATTEMPTS tries, after the first success, or after CODE_TTL_MS.
//
// Messages on the topic (JSON):
//   joiner -> host  p1 { s, Y }                 s = random session id chosen by the joiner
//   host -> joiner  p2 { s, Y, m }              m = MAC proving the host knows the password
//   joiner -> host  p3 { s, m, c }              m = MAC from the joiner, c = sealed joiner card
//   host -> joiner  p4 { s, c }                 c = sealed host card

import { ristretto255, ristretto255_hasher, ed25519 } from './vendor/noble.js';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 3;
const MAX_MSG_AGE_S = 120;
const enc = new TextEncoder();
const Point = ristretto255.Point;
const ORDER = ed25519.CURVE.n;

const b64 = {
  enc: (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
};
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

// ---------- the code ----------

/** A fresh code: { code: '37-4821-9305', nameplate: '37', password: '48219305' }. */
export function newCode() {
  for (;;) {
    const r = crypto.getRandomValues(new Uint32Array(2));
    const d = ((BigInt(r[0]) << 32n | BigInt(r[1])) % 10_000_000_000n).toString().padStart(10, '0');
    const pw = d.slice(2);
    if (/^(\d)\1+$/.test(pw) || '0123456789012345'.includes(pw) || '9876543210987654'.includes(pw)) continue;
    return parseCode(d);
  }
}

/** What people type or a QR holds ("rope:37-4821-9305", spaces, dashes) -> code object or null. */
export function parseCode(text) {
  const s = String(text ?? '').trim().replace(/^rope:(pair:)?/i, '');
  if (!/^[\d\s.-]+$/.test(s)) return null;
  const d = s.replace(/\D/g, '');
  if (d.length !== 10) return null;
  return { code: `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6)}`, nameplate: d.slice(0, 2), password: d.slice(2) };
}

/** The text put in the QR code. */
export const qrText = (c) => `ROPE:${c.code}`; // upper case: fits QR alphanumeric mode (smaller code)

/** Meeting topic on the relay. Public by design: it carries nothing that helps guess the password. */
export const pairTopic = (c) => `rope-pake-v1-${c.nameplate}`;

// ---------- CPace ----------

function lv(...parts) {
  // length-prefixed concatenation, so field boundaries can't be shifted
  const bytes = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p));
  const out = new Uint8Array(bytes.reduce((n, b) => n + 2 + b.length, 0));
  let i = 0;
  for (const b of bytes) {
    out[i++] = b.length >> 8; out[i++] = b.length & 255;
    out.set(b, i); i += b.length;
  }
  return out;
}

function randomScalar() {
  const b = rand(64);
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
  return (n % (ORDER - 1n)) + 1n; // never zero
}

function generator(c, sid) {
  return ristretto255_hasher.hashToCurve(lv('rope-cpace-v1', c.password, c.nameplate, sid), { DST: 'rope-cpace-v1-generator' });
}

function decodePoint(s) {
  let P;
  try { P = Point.fromBytes(b64.dec(s)); } catch { return null; }
  return P.is0() ? null : P;
}

/** One side's ephemeral share for a session. */
function share(c, sid) {
  const y = randomScalar();
  const Y = generator(c, sid).multiply(y);
  return { y, Y: b64.enc(Y.toBytes()) };
}

/** Session keys from my scalar and their share: { mac, aes } CryptoKeys, or null for a bad point. */
async function sessionKeys(y, theirY, sid, joinerY, hostY) {
  const P = decodePoint(theirY);
  if (!P) return null;
  const K = P.multiply(y);
  if (K.is0()) return null;
  const isk = new Uint8Array(await crypto.subtle.digest('SHA-512', lv('rope-cpace-v1-isk', sid, joinerY, hostY, K.toBytes())));
  const base = await crypto.subtle.importKey('raw', isk, 'HKDF', false, ['deriveKey']);
  const hkdf = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) });
  return {
    mac: await crypto.subtle.deriveKey(hkdf('rope pake confirm'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']),
    aes: await crypto.subtle.deriveKey(hkdf('rope pake cards'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
  };
}

const confirmData = (role, sid, joinerY, hostY) => lv('rope-cpace-v1-confirm', role, sid, joinerY, hostY);
const mac = async (keys, data) => b64.enc(new Uint8Array(await crypto.subtle.sign('HMAC', keys.mac, data)));
const macOk = async (keys, data, m) => {
  try { return await crypto.subtle.verify('HMAC', keys.mac, b64.dec(m), data); } catch { return false; }
};

async function sealCard(keys, card) {
  const iv = rand(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keys.aes, enc.encode(JSON.stringify(card))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return b64.enc(out);
}
async function openCard(keys, c) {
  try {
    const b = b64.dec(c);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, keys.aes, b.slice(12));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch { return null; }
}

const stamped = (send) => (obj) => send({ ...obj, ts: Math.floor(Date.now() / 1000) });
const fresh = (msg) => Math.abs(Date.now() / 1000 - Number(msg?.ts)) <= MAX_MSG_AGE_S;
const validSid = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{16,32}$/.test(s);

/**
 * The person showing the code. send(obj) posts to the topic.
 * Resolves `done` with the joiner's card; rejects it after MAX_ATTEMPTS wrong tries.
 */
export class PakeHost {
  constructor({ code, card, send, maxAttempts = MAX_ATTEMPTS }) {
    Object.assign(this, { code, card, send: stamped(send), maxAttempts });
    this.attempts = 0;
    this.sessions = new Map(); // sid -> { y, joinerY, hostY, keys }
    this.over = false;
    this.done = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  }

  async handle(msg) {
    if (this.over || !msg || !validSid(msg.s) || !fresh(msg)) return;
    if (msg.t === 'p1' && typeof msg.Y === 'string' && !this.sessions.has(msg.s)) {
      // Every p1 is one guess at the password: count it, and spend the code after too many.
      if (++this.attempts > this.maxAttempts) return this.#fail('Too many tries with this code. Get a new one.');
      const { y, Y } = share(this.code, msg.s);
      const keys = await sessionKeys(y, msg.Y, msg.s, msg.Y, Y);
      if (!keys) return;
      this.sessions.set(msg.s, { joinerY: msg.Y, hostY: Y, keys });
      await this.send({ t: 'p2', s: msg.s, Y, m: await mac(keys, confirmData('host', msg.s, msg.Y, Y)) });
    } else if (msg.t === 'p3' && this.sessions.has(msg.s)) {
      const ses = this.sessions.get(msg.s);
      this.sessions.delete(msg.s);
      if (!(await macOk(ses.keys, confirmData('joiner', msg.s, ses.joinerY, ses.hostY), msg.m))) {
        if (this.attempts >= this.maxAttempts) this.#fail('Too many tries with this code. Get a new one.');
        return;
      }
      const card = await openCard(ses.keys, msg.c);
      if (!card) return;
      this.over = true; // the code is spent
      await this.send({ t: 'p4', s: msg.s, c: await sealCard(ses.keys, this.card) });
      this.resolve(card);
    }
  }

  cancel(reason = 'Cancelled') { this.#fail(reason); }

  #fail(reason) {
    if (this.over) return;
    this.over = true;
    this.reject(new Error(reason));
  }
}

/** The person entering the code. Call start(), feed messages to handle(); `done` gives the host's card. */
export class PakeJoiner {
  constructor({ code, card, send }) {
    Object.assign(this, { code, card, send: stamped(send) });
    this.wrongAnswers = 0; // answers from someone else on the same nameplate, or a wrong code
    this.sid = b64.enc(rand(16));
    this.over = false;
    this.done = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  }

  async start() {
    const { y, Y } = share(this.code, this.sid);
    this.y = y;
    this.Y = Y;
    await this.send({ t: 'p1', s: this.sid, Y });
  }

  async handle(msg) {
    if (this.over || !msg || msg.s !== this.sid || !fresh(msg)) return;
    if (msg.t === 'p2' && !this.keys && typeof msg.Y === 'string') {
      const keys = await sessionKeys(this.y, msg.Y, this.sid, this.Y, msg.Y);
      if (!keys || !(await macOk(keys, confirmData('host', this.sid, this.Y, msg.Y), msg.m))) {
        // Not proof of a wrong code: someone else may be pairing on the same nameplate right now.
        // Keep waiting for an answer that proves the password; the caller times out.
        this.wrongAnswers++;
        this.onWrongAnswer?.();
        return;
      }
      this.keys = keys;
      this.hostY = msg.Y;
      await this.send({ t: 'p3', s: this.sid, m: await mac(keys, confirmData('joiner', this.sid, this.Y, msg.Y)), c: await sealCard(keys, this.card) });
    } else if (msg.t === 'p4' && this.keys) {
      const card = await openCard(this.keys, msg.c);
      if (!card) return;
      this.over = true;
      this.resolve(card);
    }
  }

  cancel(reason = 'Cancelled') { this.#fail(reason); }

  #fail(reason) {
    if (this.over) return;
    this.over = true;
    this.reject(new Error(reason));
  }
}

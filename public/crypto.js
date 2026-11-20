// Identity, pairing and message encryption. Runs entirely in the browser (WebCrypto).
//
// Identity: an ECDH P-256 key (pairing) and an ECDSA P-256 key (signing admin grants).
// Pairing:  ECDH between two identities gives a per-contact secret. HKDF turns it into
//           an AES-GCM key and a transport topic. Both parties derive the same values.
// Signing:  admin grants are signed with the admin's ECDSA key, so the subject can't forge them.

const enc = new TextEncoder();
const dec = new TextDecoder();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };

export const b64u = {
  enc(bytes) {
    let s = '';
    const a = new Uint8Array(bytes);
    for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};

async function sha256b64u(bytes) {
  return b64u.enc(await crypto.subtle.digest('SHA-256', bytes));
}

/** Short, human-checkable identifier derived from the ECDH public key. */
export async function fingerprint(ecdhPubB64) {
  return (await sha256b64u(b64u.dec(ecdhPubB64))).slice(0, 16);
}

export async function newIdentity(name) {
  const ecdh = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const ecdsa = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const ecdhPub = b64u.enc(await crypto.subtle.exportKey('raw', ecdh.publicKey));
  const ecdsaPub = b64u.enc(await crypto.subtle.exportKey('raw', ecdsa.publicKey));
  return {
    name: String(name).trim().slice(0, 40),
    id: await fingerprint(ecdhPub),
    ecdhPub,
    ecdsaPub,
    ecdhPriv: await crypto.subtle.exportKey('jwk', ecdh.privateKey),
    ecdsaPriv: await crypto.subtle.exportKey('jwk', ecdsa.privateKey),
  };
}

/** Imports the stored private keys for use. */
export async function loadKeys(identity) {
  return {
    ecdh: await crypto.subtle.importKey('jwk', identity.ecdhPriv, ECDH, false, ['deriveBits']),
    ecdsa: await crypto.subtle.importKey('jwk', identity.ecdsaPriv, ECDSA, false, ['sign']),
  };
}

/** The public, shareable part of an identity. */
export function cardOf(identity) {
  return { v: 1, n: identity.name, e: identity.ecdhPub, s: identity.ecdsaPub };
}

export function encodeCard(card) {
  return b64u.enc(enc.encode(JSON.stringify(card)));
}

export function decodeCard(code) {
  let card;
  try {
    card = JSON.parse(dec.decode(b64u.dec(String(code).trim())));
  } catch {
    throw new Error('Not a valid contact code');
  }
  if (card?.v !== 1 || typeof card.n !== 'string' || !card.n || typeof card.e !== 'string' || typeof card.s !== 'string') {
    throw new Error('Not a valid contact code');
  }
  return { v: 1, n: card.n.slice(0, 40), e: card.e, s: card.s };
}

/** Rendezvous topic where requests for this public key are posted. */
export async function inboxTopic(ecdhPubB64, prefix = 'rope-inbox-') {
  return prefix + (await sha256b64u(enc.encode('inbox|' + ecdhPubB64))).slice(0, 40);
}

/** Shared secret (32 bytes, base64url) between my identity and a contact's ECDH public key. */
export async function deriveSecret(myEcdhPriv, theirEcdhPubB64) {
  const theirs = await crypto.subtle.importKey('raw', b64u.dec(theirEcdhPubB64), ECDH, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, myEcdhPriv, 256);
  return b64u.enc(bits);
}

/** From a stored per-contact secret: AES key for messages and the transport topic. */
export async function channelFromSecret(secretB64) {
  const base = await crypto.subtle.importKey('raw', b64u.dec(secretB64), 'HKDF', false, ['deriveKey', 'deriveBits']);
  const aes = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('rope msg v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const topicBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('rope topic v1') },
    base,
    128,
  );
  return { aes, topic: 'rope-' + b64u.enc(topicBits) };
}

export async function seal(aes, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return b64u.enc(out);
}

/** Returns the decrypted object, or null if the message wasn't sealed with this key. */
export async function open(aes, text) {
  try {
    const b = b64u.dec(text);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, aes, b.slice(12));
    return JSON.parse(dec.decode(pt));
  } catch {
    return null;
  }
}

async function importVerifyKey(sPubB64) {
  return crypto.subtle.importKey('raw', b64u.dec(sPubB64), ECDSA, false, ['verify']);
}

export async function signObj(ecdsaPriv, obj) {
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, ecdsaPriv, enc.encode(JSON.stringify(obj)));
  return b64u.enc(sig);
}

export async function verifyObj(sPubB64, obj, sigB64) {
  try {
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      await importVerifyKey(sPubB64),
      b64u.dec(sigB64),
      enc.encode(JSON.stringify(obj)),
    );
  } catch {
    return false;
  }
}

// ---------- pairing with a short one-time code (after BeamBridge) ----------
//
// One person gets a code like 37-48219305 (10 digits) and tells it to the other. The code alone
// leads both to the same rendezvous topic and AES key, and over it they swap their contact cards.
// Topic and key come from a deliberately slow key derivation (PBKDF2, 600 000 rounds), so the
// rendezvous server, which sees the topic name, can't try all 10^10 codes while the code is live
// (it works once, for 10 minutes). Unlike BeamBridge's PAKE this is not proof against unlimited
// offline guessing, but nothing secret is left once pairing is over: the cards are public keys.

export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
export const PAIR_KDF_ROUNDS = 600_000;

/** A fresh code: 10 random digits shown as NN-NNNNNNNN. Skips trivially guessable ones. */
export function newPairCode() {
  for (;;) {
    const r = crypto.getRandomValues(new Uint32Array(2));
    const n = (BigInt(r[0]) << 32n | BigInt(r[1])) % 10_000_000_000n;
    const d = n.toString().padStart(10, '0');
    if (/^(\d)\1+$/.test(d) || '01234567890123456789'.includes(d) || '98765432109876543210'.includes(d)) continue;
    return `${d.slice(0, 2)}-${d.slice(2)}`;
  }
}

/** Accepts what people type (spaces, dashes, a sentence around it); returns NN-NNNNNNNN or null. */
export function normalizePairCode(text) {
  const s = String(text ?? '').trim();
  if (!/^[\d\s-]+$/.test(s)) return null;
  const d = s.replace(/\D/g, '');
  return d.length === 10 ? `${d.slice(0, 2)}-${d.slice(2)}` : null;
}

/** The rendezvous topic and AES key for a pairing code. */
export async function pairChannel(code, rounds = PAIR_KDF_ROUNDS) {
  const digits = String(code).replace(/\D/g, '');
  const pw = await crypto.subtle.importKey('raw', enc.encode(digits), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('rope pairing code v1'), iterations: rounds }, pw, 256);
  const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const aes = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('rope pair msg v1') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const topicBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('rope pair topic v1') }, base, 128);
  return { aes, topic: 'rope-pair-' + b64u.enc(topicBits) };
}

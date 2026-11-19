import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newIdentity, loadKeys, cardOf, encodeCard, decodeCard, fingerprint, inboxTopic,
  deriveSecret, channelFromSecret, seal, open, signObj, verifyObj,
} from '../public/crypto.js';

async function pair() {
  const a = await newIdentity('Parent');
  const b = await newIdentity('Kid');
  const ka = await loadKeys(a);
  const kb = await loadKeys(b);
  return { a, b, ka, kb };
}

test('cards round-trip and reject garbage', async () => {
  const a = await newIdentity('Ann');
  const card = decodeCard(encodeCard(cardOf(a)));
  assert.equal(card.n, 'Ann');
  assert.equal(card.e, a.ecdhPub);
  assert.equal(await fingerprint(card.e), a.id);
  assert.throws(() => decodeCard('not a card'), /valid contact code/);
  assert.throws(() => decodeCard(encodeCard({ v: 2, n: 'x' })), /valid contact code/);
});

test('both sides derive the same secret, topic and key', async () => {
  const { a, b, ka, kb } = await pair();
  const sa = await deriveSecret(ka.ecdh, b.ecdhPub);
  const sb = await deriveSecret(kb.ecdh, a.ecdhPub);
  assert.equal(sa, sb);
  const ca = await channelFromSecret(sa);
  const cb = await channelFromSecret(sb);
  assert.equal(ca.topic, cb.topic);
  const sealed = await seal(ca.aes, { t: 'pos', lat: 59.9, lon: 10.7 });
  assert.deepEqual(await open(cb.aes, sealed), { t: 'pos', lat: 59.9, lon: 10.7 });
});

test('a third party cannot read or forge messages', async () => {
  const { a, b, ka } = await pair();
  const c = await newIdentity('Stranger');
  const kc = await loadKeys(c);
  const ab = await channelFromSecret(await deriveSecret(ka.ecdh, b.ecdhPub));
  const cb = await channelFromSecret(await deriveSecret(kc.ecdh, b.ecdhPub));
  assert.notEqual(ab.topic, cb.topic);
  const sealed = await seal(ab.aes, { t: 'pos', lat: 1, lon: 2 });
  assert.equal(await open(cb.aes, sealed), null);
  assert.equal(await open(ab.aes, sealed.slice(0, -4) + 'AAAA'), null); // tampering is detected
  assert.ok(a.id !== c.id);
});

test('admin signatures verify for the admin and fail for anyone else', async () => {
  const { a, b, ka, kb } = await pair();
  const grant = { t: 'admin', on: true, ts: 1 };
  const sig = await signObj(ka.ecdsa, grant);
  assert.equal(await verifyObj(a.ecdsaPub, grant, sig), true);
  assert.equal(await verifyObj(a.ecdsaPub, { ...grant, on: false }, sig), false); // altered
  // The subject holds the shared channel key but not the admin's signing key.
  const forged = await signObj(kb.ecdsa, { t: 'admin', on: false, ts: 2 });
  assert.equal(await verifyObj(a.ecdsaPub, { t: 'admin', on: false, ts: 2 }, forged), false);
  assert.equal(await verifyObj(b.ecdsaPub, { t: 'admin', on: false, ts: 2 }, forged), true); // only valid as the subject
});

test('inbox topics are stable per key and differ between users', async () => {
  const a = await newIdentity('A');
  const b = await newIdentity('B');
  assert.equal(await inboxTopic(a.ecdhPub), await inboxTopic(a.ecdhPub));
  assert.notEqual(await inboxTopic(a.ecdhPub), await inboxTopic(b.ecdhPub));
});

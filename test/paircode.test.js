import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newPairCode, normalizePairCode, pairChannel, seal, open } from '../public/crypto.js';

test('new codes look like NN-NNNNNNNN and differ', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const c = newPairCode();
    assert.match(c, /^\d{2}-\d{8}$/);
    seen.add(c);
  }
  assert.ok(seen.size > 195);
});

test('typed codes are normalised; anything else is not a code', () => {
  assert.equal(normalizePairCode('37-48219305'), '37-48219305');
  assert.equal(normalizePairCode(' 37 4821 9305 '), '37-48219305');
  assert.equal(normalizePairCode('3748219305'), '37-48219305');
  for (const bad of ['', '37-4821930', '37-482193051', 'https://x/#c=3748219305', 'abc', null]) assert.equal(normalizePairCode(bad), null);
});

test('the same code gives the same topic and key; another code does not', async () => {
  const a = await pairChannel('37-48219305', 1000);
  const b = await pairChannel('3748219305', 1000);
  const c = await pairChannel('37-48219306', 1000);
  assert.equal(a.topic, b.topic);
  assert.notEqual(a.topic, c.topic);
  assert.match(a.topic, /^rope-pair-[A-Za-z0-9_-]{22}$/);
  const msg = await seal(a.aes, { t: 'pair-hello', card: 'x' });
  assert.deepEqual(await open(b.aes, msg), { t: 'pair-hello', card: 'x' });
  assert.equal(await open(c.aes, msg), null);
});

test('the full key derivation is slow on purpose but fine for a phone', async () => {
  const t = Date.now();
  await pairChannel('12-34567890');
  const ms = Date.now() - t;
  assert.ok(ms > 20, `too fast: ${ms} ms`);
});

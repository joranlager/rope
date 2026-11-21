import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newCode, parseCode, qrText, pairTopic, PakeHost, PakeJoiner } from '../public/pake.js';

test('codes: 10 digits shown NN-NNNN-NNNN, parsed from typing and QR text', () => {
  const c = newCode();
  assert.match(c.code, /^\d{2}-\d{4}-\d{4}$/);
  assert.deepEqual(parseCode(c.code), c);
  assert.deepEqual(parseCode(qrText(c)), c);
  assert.deepEqual(parseCode(' 37 4821 9305 '), { code: '37-4821-9305', nameplate: '37', password: '48219305' });
  for (const bad of ['', '37-4821-930', 'abc', 'https://x', '37-4821-93051']) assert.equal(parseCode(bad), null);
  assert.equal(pairTopic(parseCode('37-4821-9305')), 'rope-pake-v1-37');
});

// A relay in memory: everything posted is delivered to every listener (including the sender, like ntfy).
function bus() {
  const listeners = [];
  const log = [];
  return {
    log,
    listen: (fn) => listeners.push(fn),
    send: async (obj) => { log.push(obj); const copy = JSON.parse(JSON.stringify(obj)); for (const l of listeners) await l(copy); },
  };
}

test('same code: both get the other card; the relay sees no card', async () => {
  const c = parseCode('37-4821-9305');
  const b = bus();
  const host = new PakeHost({ code: c, card: { n: 'Anna Host!' }, send: b.send });
  const joiner = new PakeJoiner({ code: parseCode('3748219305'), card: { n: 'Bo Joiner!' }, send: b.send });
  b.listen((m) => host.handle(m));
  b.listen((m) => joiner.handle(m));
  await joiner.start();
  assert.deepEqual(await host.done, { n: 'Bo Joiner!' });
  assert.deepEqual(await joiner.done, { n: 'Anna Host!' });
  assert.deepEqual(b.log.map((m) => m.t), ['p1', 'p2', 'p3', 'p4']);
  // '!' and ' ' never occur in base64url, so finding them means a card leaked in clear text
  assert.ok(!/Host!|Joiner!/.test(JSON.stringify(b.log)), 'cards are encrypted');
});

test('wrong code: no card either way, and the host spends the code after 3 tries', async () => {
  const b = bus();
  const host = new PakeHost({ code: parseCode('37-4821-9305'), card: { n: 'Anna' }, send: b.send });
  b.listen((m) => host.handle(m));
  const failed = host.done.catch((e) => e.message);
  for (const guess of ['37-0000-0001', '37-0000-0002', '37-0000-0003', '37-4821-9305']) {
    const j = new PakeJoiner({ code: parseCode(guess), card: { n: 'Mallory' }, send: b.send });
    b.listen((m) => j.handle(m));
    await j.start();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(j.keys, undefined, `${guess} must not get session keys`);
    assert.ok(guess !== '37-4821-9305' || j.over === false);
  }
  assert.match(await failed, /Too many tries/);
  assert.equal(b.log.filter((m) => m.t === 'p4').length, 0);
});

test('an old message (replayed by the relay) is ignored', async () => {
  const b = bus();
  const host = new PakeHost({ code: parseCode('37-4821-9305'), card: {}, send: b.send });
  await host.handle({ t: 'p1', s: 'A'.repeat(22), Y: 'x', ts: Math.floor(Date.now() / 1000) - 600 });
  assert.equal(host.attempts, 0);
});

test('the joiner ignores an answer from another pairing on the same nameplate', async () => {
  const b = bus();
  const other = new PakeHost({ code: parseCode('37-1111-2222'), card: { n: 'Other' }, send: b.send });
  const host = new PakeHost({ code: parseCode('37-4821-9305'), card: { n: 'Anna' }, send: b.send });
  const joiner = new PakeJoiner({ code: parseCode('37-4821-9305'), card: { n: 'Bo' }, send: b.send });
  b.listen((m) => other.handle(m));
  b.listen((m) => host.handle(m));
  b.listen((m) => joiner.handle(m));
  await joiner.start();
  assert.deepEqual(await joiner.done, { n: 'Anna' });
  assert.equal(joiner.wrongAnswers, 1);
});

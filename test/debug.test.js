import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tapCounter, ago, DebugLog } from '../public/debug.js';

test('four taps within 1.5 s toggle; slower taps do not', () => {
  const tap = tapCounter();
  assert.deepEqual([0, 300, 600].map((t) => tap(t)), [false, false, false]);
  assert.equal(tap(900), true);
  assert.equal(tap(1000), false); // counting starts over
  const slow = tapCounter();
  assert.deepEqual([0, 600, 1200, 1800, 2400].map((t) => slow(t)), [false, false, false, false, false]);
});

test('ago reads in s, min and h', () => {
  assert.equal(ago(0, 1000), '-');
  assert.equal(ago(1000, 6000), '5 s');
  assert.equal(ago(0 + 1, 1 + 10 * 60_000), '10 min');
  assert.equal(ago(1, 1 + 3 * 3_600_000), '3 h');
});

test('the log collapses repeats, counts problems and keeps a bounded tail', () => {
  const log = new DebugLog(3);
  log.add('warn', 'relay', 'x');
  log.add('warn', 'relay', 'x');
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].repeat, 2);
  log.add('error', 'p2p', 'a'); log.add('info', 'app', 'b'); log.add('info', 'app', 'c');
  assert.equal(log.entries.length, 3);
  assert.deepEqual(log.counts, { warn: 2, error: 1 });
  assert.match(log.text(), /INFO {2}app: c$/);
});

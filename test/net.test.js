import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Relay, RelayError } from '../public/net.js';

const res = (status) => ({ ok: status >= 200 && status < 300, status });
function fakeFetch(outcomes) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const o = outcomes.shift();
    if (o instanceof Error) throw o;
    return res(o);
  };
  fn.calls = calls;
  return fn;
}

test('publish retries a dropped connection and succeeds', async () => {
  const f = fakeFetch([new TypeError('Failed to fetch'), 200]);
  await new Relay('https://r.example/', { fetchImpl: f, delays: [0, 0] }).publish('t', 'x');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, 'https://r.example/t');
});

test('publish gives up after the retries with kind offline', async () => {
  const f = fakeFetch([new TypeError('a'), new TypeError('b'), new TypeError('c')]);
  await assert.rejects(new Relay('https://r', { fetchImpl: f, delays: [0, 0] }).publish('t', 'x'),
    (e) => e instanceof RelayError && e.kind === 'offline');
  assert.equal(f.calls.length, 3);
});

test('publish retries 429 and 5xx, reports rate limit', async () => {
  const f = fakeFetch([503, 429, 429]);
  await assert.rejects(new Relay('https://r', { fetchImpl: f, delays: [0, 0] }).publish('t', 'x'), (e) => e.kind === 'rate');
  assert.equal(f.calls.length, 3);
});

test('publish does not retry a 4xx other than 429', async () => {
  const f = fakeFetch([400, 200]);
  await assert.rejects(new Relay('https://r', { fetchImpl: f, delays: [0, 0] }).publish('t', 'x'), (e) => e.kind === 'server');
  assert.equal(f.calls.length, 1);
});

class FakeES {
  static all = [];
  constructor(url) { this.url = url; this.readyState = 1; FakeES.all.push(this); }
  close() { this.readyState = 2; }
}

test('reconnect reopens closed streams from the last message id', () => {
  FakeES.all = [];
  const got = [];
  const r = new Relay('https://r', { EventSourceImpl: FakeES });
  r.subscribe('top', (m) => got.push(m), '5m');
  const es = FakeES.all[0];
  assert.equal(es.url, 'https://r/top/sse?since=5m');
  es.onmessage({ data: JSON.stringify({ event: 'message', id: 'abc', message: 'hi', time: 1 }) });
  assert.deepEqual(got, ['hi']);
  r.reconnect(); // still open: nothing happens
  assert.equal(FakeES.all.length, 1);
  es.readyState = 2; // browser gave up
  r.reconnect();
  assert.equal(FakeES.all.length, 2);
  assert.equal(FakeES.all[1].url, 'https://r/top/sse?since=abc');
  FakeES.all[1].onmessage({ data: JSON.stringify({ event: 'message', id: 'd', message: 'again', time: 2 }) });
  assert.deepEqual(got, ['hi', 'again']);
  r.closeAll();
});

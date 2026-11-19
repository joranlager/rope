import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeDesc, buildSdp, candidateLines, isOfferer, validCompact } from '../public/p2p.js';

const FP = 'sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
const offerSdp = [
  'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
  'a=candidate:1 1 udp 2122260223 192.168.1.20 51000 typ host generation 0 network-id 1',
  'a=candidate:2 1 udp 1686052607 84.10.20.30 40000 typ srflx raddr 192.168.1.20 rport 51000 generation 0',
  'a=candidate:3 1 tcp 1518280447 192.168.1.20 9 typ host tcptype active generation 0',
  'a=candidate:4 1 udp 2122194687 abcd.local 51001 typ host generation 0',
  'a=ice-ufrag:Ab12', 'a=ice-pwd:pwdpwdpwdpwdpwdpwdpwdpwd', 'a=ice-options:trickle',
  `a=fingerprint:${FP}`, 'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', '',
].join('\r\n');

test('encodeDesc keeps ICE credentials, fingerprint and UDP candidates only', () => {
  const o = encodeDesc({ type: 'offer', sdp: offerSdp });
  assert.equal(o.t, 'o');
  assert.equal(o.u, 'Ab12');
  assert.equal(o.p, 'pwdpwdpwdpwdpwdpwdpwdpwd');
  assert.equal(o.s, undefined); // actpass is the default for an offer
  assert.deepEqual(o.c, [
    ['192.168.1.20', 51000, 'h', 2122260223],
    ['84.10.20.30', 40000, 's', 1686052607],
    ['abcd.local', 51001, 'h', 2122194687],
  ]);
  assert.ok(validCompact(o));
  assert.ok(JSON.stringify(o).length < 260, 'compact');
});

test('buildSdp round-trips the fields WebRTC needs', () => {
  const o = encodeDesc({ type: 'offer', sdp: offerSdp });
  const sdp = buildSdp(o);
  assert.match(sdp, /a=ice-ufrag:Ab12\r\n/);
  assert.match(sdp, /a=ice-pwd:pwdpwdpwdpwdpwdpwdpwdpwd\r\n/);
  assert.ok(sdp.includes(`a=fingerprint:${FP}\r\n`));
  assert.match(sdp, /a=setup:actpass\r\n/);
  assert.match(sdp, /a=candidate:2 1 udp 1686052607 84\.10\.20\.30 40000 typ srflx raddr 0\.0\.0\.0 rport 0 generation 0/);
  assert.match(sdp, /a=end-of-candidates\r\n$/);
  // and again: encode(build(o)) == o
  assert.deepEqual(encodeDesc({ type: 'offer', sdp }), o);
});

test('an answer keeps a non-default setup role', () => {
  const sdp = offerSdp.replace('a=setup:actpass', 'a=setup:passive');
  const o = encodeDesc({ type: 'answer', sdp });
  assert.equal(o.t, 'a');
  assert.equal(o.s, 'passive');
  assert.match(buildSdp(o), /a=setup:passive/);
});

test('candidateLines marks public ones as srflx', () => {
  const lines = candidateLines({ c: [['1.2.3.4', 5, 's', 9], ['10.0.0.1', 6, 'h', 8]] });
  assert.deepEqual(lines, ['1 1 udp 9 1.2.3.4 5 typ srflx raddr 0.0.0.0 rport 0', '2 1 udp 8 10.0.0.1 6 typ host']);
});

test('exactly one side of a pair offers', () => {
  assert.equal(isOfferer('aaa', 'bbb'), true);
  assert.equal(isOfferer('bbb', 'aaa'), false);
});

test('validCompact rejects junk', () => {
  for (const bad of [null, 'x', {}, { t: 'o', u: 'a', p: 'b', f: 'c' }, { t: 'x', u: 'a', p: 'b', f: 'c', c: [] }]) {
    assert.equal(validCompact(bad), false);
  }
});

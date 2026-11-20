// Direct, peer-to-peer link to one contact over a WebRTC data channel, after OneChat's serverless
// connect: the offer and answer are squeezed into compact codes (ICE ufrag/pwd, DTLS fingerprint,
// candidates), the SDP is rebuilt from a template on the other side, and the peer's public (srflx)
// candidates are re-added every few seconds so both NATs keep their hole open until the checks meet.
//
// Rope needs no QR swapping: the codes travel over the contact's encrypted pair channel on the
// rendezvous server (a few messages per connection). Once the channel is open, positions go
// directly between the phones and the rendezvous server is only the fallback.
//
// The DTLS fingerprint arrives AES-GCM sealed with the contact's key, so only that contact can
// complete the handshake: the direct channel is as authentic as the pair channel.

export const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const GATHER_MS = 4_000;          // non-trickle: wait this long at most for candidates
const ATTEMPT_MS = 45_000;        // give an attempt this long to open
const PUNCH_EVERY_MS = 4_000;     // re-add the peer's public candidates this often
const RETRY_MIN_MS = 20_000;      // next attempt after a failure, doubling…
const RETRY_MAX_MS = 5 * 60_000;  // …up to this
const KICK_GAP_MS = 10_000;       // ignore kicks closer together than this
const DISCONNECT_GRACE_MS = 8_000;
export const SIGNAL_MAX_AGE_MS = 60_000; // the relay replays recent messages; older signals are dead

/** The lower id makes the offers, so the two sides never offer at once. */
export const isOfferer = (myId, theirId) => myId < theirId;

const b64ToHex = (b64) => {
  const s = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Array.from(s, (ch) => ch.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()).join(':');
};
const hexToB64 = (hex) => btoa(String.fromCharCode(...hex.replace(/:/g, '').match(/../g).map((h) => parseInt(h, 16)))).replace(/=+$/, '');

/** RTCSessionDescription -> compact object (OneChat code v2 layout). */
export function encodeDesc(desc) {
  const sdp = desc.sdp;
  const pick = (re) => sdp.match(re)?.[1].trim() ?? '';
  const t = desc.type === 'offer' ? 'o' : 'a';
  const [alg, fp] = pick(/a=fingerprint:(.+)/).split(' ');
  const c = [];
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith('a=candidate:')) continue;
    const p = line.slice(12).split(' '); // foundation comp proto prio ip port typ type ...
    if (p[2]?.toLowerCase() !== 'udp' || p[1] !== '1') continue;
    const kind = p[7] === 'host' ? 'h' : p[7] === 'srflx' ? 's' : '';
    if (kind) c.push([p[4], +p[5], kind, +p[3]]);
  }
  const o = { t, u: pick(/a=ice-ufrag:(.+)/), p: pick(/a=ice-pwd:(.+)/), f: hexToB64(fp ?? ''), c };
  if (alg && alg.toLowerCase() !== 'sha-256') o.a = alg;
  const setup = pick(/a=setup:(.+)/);
  if (setup && setup !== (t === 'o' ? 'actpass' : 'active')) o.s = setup;
  return o;
}

/** Candidate lines (without "a=candidate:") for a compact object. */
export function candidateLines(o) {
  return (o.c ?? []).map(([ip, port, kind, prio], i) =>
    `${i + 1} 1 udp ${prio} ${ip} ${port} typ ${kind === 's' ? 'srflx raddr 0.0.0.0 rport 0' : 'host'}`);
}

/** Compact object -> a data-channel-only SDP the browser accepts. */
export function buildSdp(o) {
  const lines = [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${o.u}`,
    `a=ice-pwd:${o.p}`,
    `a=fingerprint:${o.a ?? 'sha-256'} ${b64ToHex(o.f)}`,
    `a=setup:${o.s ?? (o.t === 'o' ? 'actpass' : 'active')}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    ...candidateLines(o).map((c) => `a=candidate:${c} generation 0`),
    'a=end-of-candidates',
  ];
  return lines.join('\r\n') + '\r\n';
}

/** "2 host, 1 public" — for logs. */
export function describeCandidates(o) {
  const n = (k) => (o?.c ?? []).filter((c) => c[2] === k).length;
  return `${n('h')} host, ${n('s')} public`;
}

export function validCompact(o) {
  return Boolean(o && typeof o === 'object' && (o.t === 'o' || o.t === 'a') &&
    typeof o.u === 'string' && o.u && typeof o.p === 'string' && o.p && typeof o.f === 'string' && o.f &&
    Array.isArray(o.c) && o.c.length <= 30);
}

const sessionId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

function waitGathering(pc, ms) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = () => { pc.removeEventListener('icegatheringstatechange', check); clearTimeout(timer); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const timer = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

/**
 * One contact's direct link.
 *  signal(obj)      sends { t:'rtc', k, sid, d? } over the pair channel (caller seals, stamps ts/fr)
 *  onMessage(text)  a message received over the data channel
 *  onChange(open)   the link opened or closed
 */
export class PeerLink {
  constructor({ myId, theirId, signal, onMessage, onChange, RTC = globalThis.RTCPeerConnection, iceServers = ICE_SERVERS, log = () => {} }) {
    Object.assign(this, { myId, theirId, signal, onMessage, onChange, RTC, iceServers, log });
    this.retryAt = 0;
    this.attempts = 0;
    this.lastError = '';
    this.offerer = isOfferer(myId, theirId);
    this.pc = null;
    this.dc = null;
    this.sid = null;
    this.backoff = RETRY_MIN_MS;
    this.lastStart = 0;
    this.timers = new Set();
    this.retryTimer = null;
    this.closed = false;
    this.wasOpen = false;
  }

  get open() { return this.dc?.readyState === 'open'; }

  /** Send a text over the direct channel. False if it isn't open (use the relay instead). */
  send(text) {
    if (!this.open) return false;
    try { this.dc.send(text); return true; } catch { return false; }
  }

  /** Try to connect now (start-up, network back, page visible), unless open or just tried. */
  kick() {
    if (this.closed || !this.RTC || this.open || Date.now() - this.lastStart < KICK_GAP_MS) return;
    this.#start();
  }

  #clearRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAt = 0;
  }

  #start() {
    this.#clearRetry();
    this.lastStart = Date.now();
    this.attempts++;
    this.log('info', this.offerer ? `attempt ${this.attempts}: making an offer` : `attempt ${this.attempts}: asking them for an offer`);
    if (this.offerer) this.#offer();
    else {
      this.signal({ t: 'rtc', k: 'req' }); // ask the offerer for a fresh offer
      this.#schedule();                    // and ask again later if none comes
    }
  }

  #after(ms, fn) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
    return t;
  }

  #schedule() {
    if (this.closed || this.retryTimer) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, RETRY_MAX_MS);
    this.retryAt = Date.now() + wait;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.retryAt = 0; this.kick(); }, wait);
  }

  #teardown() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const pc = this.pc;
    this.pc = null;
    this.dc = null;
    this.sid = null;
    try { pc?.close(); } catch { /* already closed */ }
    if (this.wasOpen) { this.wasOpen = false; this.onChange?.(false); }
  }

  #fail(pc, why) {
    if (pc !== this.pc) return; // an older attempt
    this.lastError = why;
    this.log(this.wasOpen ? 'warn' : 'error', `${this.wasOpen ? 'direct link lost' : 'direct link failed'}: ${why}`);
    this.#teardown();
    this.#schedule();
  }

  #newPc() {
    this.#teardown();
    const pc = new this.RTC({ iceServers: this.iceServers });
    this.pc = pc;
    let grace = null;
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (pc === this.pc) this.log(s === 'failed' ? 'error' : 'info', `ICE ${s}`);
      if (s === 'failed' || s === 'closed') this.#fail(pc, `ICE ${s}`);
      else if (s === 'disconnected') grace = this.#after(DISCONNECT_GRACE_MS, () => { if (pc.iceConnectionState === 'disconnected') this.#fail(pc, 'ICE disconnected for 8 s'); });
      else if (grace) { clearTimeout(grace); this.timers.delete(grace); grace = null; }
    };
    pc.ondatachannel = (e) => this.#useChannel(pc, e.channel);
    this.#after(ATTEMPT_MS, () => { if (pc === this.pc && !this.open) this.#fail(pc, `not open after ${ATTEMPT_MS / 1000} s`); });
    return pc;
  }

  #useChannel(pc, dc) {
    if (pc !== this.pc) return;
    this.dc = dc;
    dc.onopen = () => {
      if (pc !== this.pc || this.wasOpen) return; // stale, or already handled
      this.#clearRetry();
      this.backoff = RETRY_MIN_MS;
      this.wasOpen = true;
      this.lastError = '';
      this.log('info', 'direct link open');
      this.onChange?.(true);
    };
    dc.onmessage = (e) => { if (typeof e.data === 'string') this.onMessage(e.data); };
    dc.onclose = () => this.#fail(pc, 'data channel closed');
    if (dc.readyState === 'open') dc.onopen();
  }

  // Keep re-adding the peer's public candidates, so our NAT keeps sending checks (and stays open
  // towards them) until theirs arrive. A fresh foundation each round stops it being dropped as a duplicate.
  #punch(pc, remote) {
    const srflx = candidateLines(remote).filter((c) => c.includes(' typ srflx '));
    if (!srflx.length) return;
    let round = 0;
    const tick = () => {
      if (pc !== this.pc || this.open) return;
      round++;
      for (const c of srflx) {
        const parts = c.split(' ');
        parts[0] = `${parts[0]}r${round}`.slice(-32);
        pc.addIceCandidate({ candidate: `candidate:${parts.join(' ')}`, sdpMid: '0', sdpMLineIndex: 0 }).catch(() => {});
      }
      this.#after(PUNCH_EVERY_MS, tick);
    };
    this.#after(PUNCH_EVERY_MS, tick);
  }

  async #offer() {
    try {
      const pc = this.#newPc();
      const sid = sessionId();
      this.sid = sid;
      this.#useChannel(pc, pc.createDataChannel('rope', { ordered: true }));
      await pc.setLocalDescription(await pc.createOffer());
      await waitGathering(pc, GATHER_MS);
      if (pc !== this.pc) return;
      const d = encodeDesc(pc.localDescription);
      this.log('info', `offer sent (${describeCandidates(d)})`);
      this.signal({ t: 'rtc', k: 'o', sid, d });
    } catch (err) {
      this.#fail(this.pc, `offer: ${err?.message ?? err}`);
    }
  }

  async #answer(sid, remote) {
    try {
      const pc = this.#newPc();
      this.sid = sid;
      await pc.setRemoteDescription({ type: 'offer', sdp: buildSdp(remote) });
      await pc.setLocalDescription(await pc.createAnswer());
      await waitGathering(pc, GATHER_MS);
      if (pc !== this.pc) return;
      const d = encodeDesc(pc.localDescription);
      this.log('info', `answer sent (${describeCandidates(d)})`);
      this.signal({ t: 'rtc', k: 'a', sid, d });
      this.#punch(pc, remote);
    } catch (err) {
      this.#fail(this.pc, `answer: ${err?.message ?? err}`);
    }
  }

  /** A signal from the contact, already decrypted, checked for age and not an echo of my own. */
  async onSignal(msg) {
    if (this.closed || !this.RTC || !msg || typeof msg.sid !== 'string' && msg.k !== 'req') return;
    this.log('info', `signal in: ${{ req: 'request', o: 'offer', a: 'answer' }[msg.k] ?? msg.k}${msg.d ? ` (${describeCandidates(msg.d)})` : ''}`);
    if (msg.k === 'req') {
      // The answerer only asks when it has no link, so if ours still looks open it is dead on their
      // side: offer afresh at once. Otherwise offer unless an attempt has only just started.
      if (this.offerer && (this.open || Date.now() - this.lastStart >= KICK_GAP_MS)) this.#start();
      return;
    }
    if (!validCompact(msg.d)) return;
    if (msg.k === 'o' && !this.offerer && msg.d.t === 'o') {
      if (msg.sid === this.sid) return; // the same offer again (replay)
      this.lastStart = Date.now();
      this.#clearRetry();
      await this.#answer(msg.sid, msg.d);
    } else if (msg.k === 'a' && this.offerer && msg.d.t === 'a' && msg.sid === this.sid && this.pc?.signalingState === 'have-local-offer') {
      const pc = this.pc;
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp: buildSdp(msg.d) });
        this.#punch(pc, msg.d);
      } catch (err) {
        this.#fail(pc, `their answer: ${err?.message ?? err}`);
      }
    }
  }

  /** For the debug overlay. */
  status() {
    const pc = this.pc;
    return {
      state: this.open ? 'open' : pc ? 'connecting' : this.retryAt ? 'waiting' : 'idle',
      role: this.offerer ? 'offerer' : 'answerer',
      ice: pc?.iceConnectionState ?? '-',
      signaling: pc?.signalingState ?? '-',
      attempts: this.attempts,
      retryInMs: this.retryAt ? Math.max(0, this.retryAt - Date.now()) : 0,
      lastError: this.lastError,
    };
  }

  /** The candidate pair in use: e.g. { local: 'srflx 84.1.2.3:4000 udp', remote: 'host …', rttMs }. */
  async route() {
    const pc = this.pc;
    if (!pc?.getStats) return null;
    try {
      const stats = await pc.getStats();
      let pair = null;
      stats.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
      });
      if (!pair) stats.forEach((r) => { if (!pair && r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
      if (!pair) return null;
      const cand = (id) => {
        const c = stats.get(id);
        return c ? `${c.candidateType} ${c.address || c.ip || '(hidden)'}:${c.port} ${c.protocol ?? ''}`.trim() : '?';
      };
      return {
        local: cand(pair.localCandidateId),
        remote: cand(pair.remoteCandidateId),
        rttMs: Number.isFinite(pair.currentRoundTripTime) ? Math.round(pair.currentRoundTripTime * 1000) : null,
      };
    } catch {
      return null;
    }
  }

  close() {
    this.closed = true;
    this.#clearRetry();
    this.#teardown();
  }
}

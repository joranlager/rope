// Transport: publish/subscribe over an ntfy server (https://ntfy.sh by default, or your own).
// The server only ever sees topic names and ciphertext (or public cards on inbox topics).

export const DEFAULT_RELAY = 'https://ntfy.sh';

export class Relay {
  constructor(base = DEFAULT_RELAY) {
    this.base = base.replace(/\/$/, '');
    this.sources = new Map(); // topic -> EventSource
  }

  async publish(topic, text) {
    const res = await fetch(`${this.base}/${topic}`, { method: 'POST', body: text });
    if (!res.ok) throw new Error(`Relay refused message (${res.status})`);
  }

  /** onMessage(text, unixSeconds). Reconnects automatically; `since` replays recent messages. */
  subscribe(topic, onMessage, since = '5m') {
    if (this.sources.has(topic)) return;
    const es = new EventSource(`${this.base}/${topic}/sse?since=${since}`);
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.event === 'message' && typeof data.message === 'string') onMessage(data.message, data.time);
      } catch {
        /* ignore malformed events */
      }
    };
    this.sources.set(topic, es);
  }

  unsubscribe(topic) {
    this.sources.get(topic)?.close();
    this.sources.delete(topic);
  }

  closeAll() {
    for (const es of this.sources.values()) es.close();
    this.sources.clear();
  }
}

// Minimal MQTT 3.1.1 client over WebSocket (browser and Node 24).
const TYPE_NAMES = {
  1: 'CONNECT', 2: 'CONNACK', 3: 'PUBLISH', 4: 'PUBACK', 8: 'SUBSCRIBE', 9: 'SUBACK',
  12: 'PINGREQ', 13: 'PINGRESP', 14: 'DISCONNECT',
};
const enc = new TextEncoder();
const dec = new TextDecoder();

export const topics = {
  action: (id) => `devcrpc/action/${id}`,
  attr: (id) => `devcrpc/attr/${id}`,
  report: (id) => `devsrpc/attr/${id}`,
};

export function cleanPayload(nowSec) {
  return { id: nowSec, method: 'action', from: 'remote', params: { did: '0', sid: 2, aid: 1, in: [] } };
}
export function manualPayload(on, nowSec) {
  return { id: nowSec, method: 'set_properties', from: 'remote', params: [{ did: '0', sid: 2, pid: 3, value: on ? 1 : 0 }] };
}

// Returns [{pid, value}] for every entry of a properties_changed report.
export function parseReport(payload) {
  let p = payload;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { return []; } }
  if (!p || p.method !== 'properties_changed' || !Array.isArray(p.params)) return [];
  return p.params.filter((x) => x && x.pid !== undefined).map((x) => ({ pid: x.pid, value: x.value }));
}

// ---- packet encoding / decoding (exported for tests) ----
export function encodeRemainingLength(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
}
function u16(n) { return [(n >> 8) & 0xff, n & 0xff]; }
function str(s) { const b = enc.encode(s); return [...u16(b.length), ...b]; }
function packet(firstByte, body) {
  return Uint8Array.from([firstByte, ...encodeRemainingLength(body.length), ...body]);
}

export function encodeConnect(clientId, keepalive = 60) {
  return packet(0x10, [...str('MQTT'), 4, 0x02, ...u16(keepalive), ...str(clientId)]);
}
export function encodeSubscribe(packetId, topic) {
  return packet(0x82, [...u16(packetId), ...str(topic), 0]);
}
export function encodePublish(topic, payloadStr) {
  return packet(0x30, [...str(topic), ...enc.encode(payloadStr)]);
}
export const PINGREQ = Uint8Array.from([0xc0, 0x00]);
export const DISCONNECT = Uint8Array.from([0xe0, 0x00]);

// Reassembles frames from arbitrary chunks. push() -> [{type, flags, body}]
export class FrameReader {
  constructor() { this.buf = new Uint8Array(0); }
  push(chunk) {
    const c = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const m = new Uint8Array(this.buf.length + c.length);
    m.set(this.buf); m.set(c, this.buf.length);
    this.buf = m;
    const frames = [];
    for (;;) {
      if (this.buf.length < 2) break;
      let len = 0, mult = 1, i = 1, done = false;
      while (i < this.buf.length && i <= 4) {
        const b = this.buf[i++];
        len += (b & 0x7f) * mult;
        mult *= 128;
        if (!(b & 0x80)) { done = true; break; }
      }
      if (!done) {
        if (i > 4) throw new Error('bad remaining length');
        break; // length bytes incomplete
      }
      if (this.buf.length < i + len) break;
      frames.push({ type: this.buf[0] >> 4, flags: this.buf[0] & 0x0f, body: this.buf.slice(i, i + len) });
      this.buf = this.buf.slice(i + len);
    }
    return frames;
  }
}

// -> {topic, payload (JSON-parsed when possible, else string)}
export function parsePublish(frame) {
  const b = frame.body;
  const tl = (b[0] << 8) | b[1];
  const topic = dec.decode(b.slice(2, 2 + tl));
  let pos = 2 + tl;
  if (((frame.flags >> 1) & 3) > 0) pos += 2; // packet id for QoS 1/2
  const text = dec.decode(b.slice(pos));
  let payload = text;
  try { payload = JSON.parse(text); } catch { /* keep string */ }
  return { topic, payload };
}

function randomClientId() {
  const a = new Uint8Array(5);
  globalThis.crypto.getRandomValues(a);
  return 'pc' + Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');
}

const CONNECT_TIMEOUT_MS = 12000;

export class MqttClient extends EventTarget {
  constructor({ url, token, WebSocketImpl } = {}) {
    super();
    this.url = url;
    this.token = token;
    this.WS = WebSocketImpl || globalThis.WebSocket;
    this.ws = null;
    this.reader = new FrameReader();
    this.nextId = 1;
    this.pending = new Map(); // packetId -> resolve
    this.connected = false;
    this.pingTimer = null;
    this.connAck = null;
  }

  _emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }

  _send(bytes, type, topic) {
    this.ws.send(bytes);
    this._emit('frame', { dir: 'out', type: type || TYPE_NAMES[bytes[0] >> 4], topic });
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); this._teardown(); } };
      const timer = setTimeout(() => fail({ code: 'timeout' }), CONNECT_TIMEOUT_MS);
      this.connAck = (rc) => {
        if (settled) return;
        if (rc !== 0) return fail({ code: rc });
        settled = true; clearTimeout(timer);
        this.connected = true;
        this.pingTimer = setInterval(() => { try { this._send(PINGREQ); } catch { /* closing */ } }, 30000);
        resolve();
      };
      let ws;
      try {
        ws = new this.WS(this.url + '?token=' + encodeURIComponent(this.token), 'mqtt');
      } catch { return fail({ code: 'ws' }); }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.addEventListener('open', () => this._send(encodeConnect(randomClientId(), 60)));
      ws.addEventListener('message', (ev) => this._onData(ev.data, fail));
      ws.addEventListener('error', () => fail({ code: 'ws' }));
      ws.addEventListener('close', () => {
        const was = this.connected;
        this._teardown();
        fail({ code: 'closed' });
        if (was) this._emit('close', {});
      });
    });
  }

  _onData(data, fail) {
    let frames;
    try { frames = this.reader.push(data); } catch { fail({ code: 'protocol' }); return; }
    for (const f of frames) {
      const name = TYPE_NAMES[f.type] || 'T' + f.type;
      if (f.type === 3) {
        const m = parsePublish(f);
        this._emit('frame', { dir: 'in', type: name, topic: m.topic });
        this._emit('message', m);
        continue;
      }
      this._emit('frame', { dir: 'in', type: name });
      if (f.type === 2 && this.connAck) this.connAck(f.body[1]);
      else if (f.type === 9) {
        const id = (f.body[0] << 8) | f.body[1];
        const res = this.pending.get(id);
        if (res) { this.pending.delete(id); res(f.body[2]); }
      }
    }
  }

  // Resolves with the granted QoS byte (0x80 = refused).
  subscribe(topic) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject({ code: 'timeout' }); }, CONNECT_TIMEOUT_MS);
      this.pending.set(id, (rc) => { clearTimeout(timer); resolve(rc); });
      this._send(encodeSubscribe(id, topic), 'SUBSCRIBE', topic);
    });
  }

  publish(topic, obj) {
    this._send(encodePublish(topic, JSON.stringify(obj)), 'PUBLISH', topic);
  }

  _teardown() {
    this.connected = false;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  close() {
    try { if (this.ws && this.connected) this.ws.send(DISCONNECT); } catch { /* ignore */ }
    this._teardown();
    try { if (this.ws) this.ws.close(); } catch { /* ignore */ }
  }
}

// Connect, publish once, wait 500 ms, disconnect. Rejects on CONNACK != 0 or after 12 s.
export async function publishOnce({ url, token, WebSocketImpl }, topic, obj) {
  const c = new MqttClient({ url, token, WebSocketImpl });
  await c.connect();
  try {
    c.publish(topic, obj);
    await new Promise((r) => setTimeout(r, 500));
  } finally {
    c.close();
  }
}

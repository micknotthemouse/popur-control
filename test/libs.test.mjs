import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { md5Hex } from '../docs/lib/md5.js';
import { normalizeInfo, parseDevices, binState } from '../docs/lib/normalize.js';
import { deviceKey, redact, maskEmail } from '../docs/lib/privacy.js';
import { makeSetupCode } from '../docs/lib/handoff.js';
import { CONFIG, applyOverrides } from '../docs/lib/config.js';
import { parseNdjson } from '../docs/lib/history.js';
import { PopurApi, ApiError } from '../docs/lib/api.js';
import {
  MqttClient, FrameReader, encodeConnect, encodeSubscribe, encodePublish, encodeRemainingLength,
  parsePublish, parseReport, cleanPayload, manualPayload, topics, publishOnce,
} from '../docs/lib/mqtt.js';

test('md5 matches node:crypto', () => {
  const samples = ['', 'a', 'abc', 'hunter2', 'pässwörd ✓ 猫', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'long '.repeat(1000)];
  for (const s of samples) {
    assert.equal(md5Hex(s), crypto.createHash('md5').update(s, 'utf8').digest('hex'), JSON.stringify(s.slice(0, 20)));
  }
});

test('mqtt packet encode / remaining length', () => {
  assert.deepEqual(encodeRemainingLength(0), [0]);
  assert.deepEqual(encodeRemainingLength(127), [127]);
  assert.deepEqual(encodeRemainingLength(128), [0x80, 1]);
  assert.deepEqual(encodeRemainingLength(16383), [0xff, 0x7f]);
  assert.deepEqual(encodeRemainingLength(16384), [0x80, 0x80, 1]);
  const c = encodeConnect('pcabc', 60);
  assert.deepEqual([...c.slice(0, 2)], [0x10, c.length - 2]);
  assert.deepEqual([...c.slice(2, 12)], [0, 4, 77, 81, 84, 84, 4, 2, 0, 60]);
  const s = encodeSubscribe(7, 'a/b');
  assert.deepEqual([...s], [0x82, 8, 0, 7, 0, 3, 97, 47, 98, 0]);
});

test('mqtt publish round trip incl. 2-byte remaining length', () => {
  const big = { text: 'é'.repeat(300) };
  const pkt = encodePublish('devsrpc/attr/42', JSON.stringify(big));
  assert.ok(pkt[1] & 0x80, 'multi-byte length');
  const frames = new FrameReader().push(pkt);
  assert.equal(frames.length, 1);
  const m = parsePublish(frames[0]);
  assert.equal(m.topic, 'devsrpc/attr/42');
  assert.deepEqual(m.payload, big);
});

test('mqtt reader: fragmented and coalesced frames', () => {
  const a = encodePublish('t/a', '{"n":1}');
  const b = encodePublish('t/b', '{"n":2}');
  const all = Uint8Array.from([...a, ...b]);
  const r = new FrameReader();
  assert.equal(r.push(all).length, 2);
  const r2 = new FrameReader();
  let got = [];
  for (const byte of all) got = got.concat(r2.push(Uint8Array.of(byte)));
  assert.deepEqual(got.map((f) => parsePublish(f).topic), ['t/a', 't/b']);
  // split in the middle of a multi-byte length header
  const big = encodePublish('t/c', 'z'.repeat(500));
  const r3 = new FrameReader();
  assert.equal(r3.push(big.slice(0, 2)).length, 0);
  assert.equal(r3.push(big.slice(2)).length, 1);
});

test('mqtt reader: QoS1 publish skips packet id', () => {
  const topic = Buffer.from('t/q');
  const payload = Buffer.from('{"ok":true}');
  const body = Buffer.concat([Buffer.from([0, topic.length]), topic, Buffer.from([0, 9]), payload]);
  const pkt = Uint8Array.from([0x32, body.length, ...body]);
  const f = new FrameReader().push(pkt)[0];
  assert.deepEqual(parsePublish(f), { topic: 't/q', payload: { ok: true } });
});

test('payloads and parseReport', () => {
  assert.deepEqual(cleanPayload(5), { id: 5, method: 'action', from: 'remote', params: { did: '0', sid: 2, aid: 1, in: [] } });
  assert.deepEqual(manualPayload(true, 5).params, [{ did: '0', sid: 2, pid: 3, value: 1 }]);
  assert.equal(manualPayload(false, 5).params[0].value, 0);
  assert.equal(topics.action('x'), 'devcrpc/action/x');
  assert.equal(topics.report('x'), 'devsrpc/attr/x');
  const rep = { method: 'properties_changed', params: [{ pid: 2, value: 3 }, { sid: 2, pid: 8, value: 11 }] };
  assert.deepEqual(parseReport(rep), [{ pid: 2, value: 3 }, { pid: 8, value: 11 }]);
  assert.deepEqual(parseReport(JSON.stringify(rep)).length, 2);
  assert.deepEqual(parseReport({ method: 'other' }), []);
  assert.deepEqual(parseReport(null), []);
});

// Fake broker-side WebSocket for client tests.
function makeFakeWs(script) {
  const instances = [];
  class FakeWS extends EventTarget {
    constructor(url, proto) {
      super();
      this.url = url; this.proto = proto; this.sent = [];
      instances.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(bytes) { this.sent.push(Uint8Array.from(bytes)); script(this, Uint8Array.from(bytes)); }
    deliver(bytes) { const ev = new Event('message'); ev.data = Uint8Array.from(bytes).buffer; this.dispatchEvent(ev); }
    close() { this.dispatchEvent(new Event('close')); }
  }
  return { FakeWS, instances };
}
const connack = (rc) => [0x20, 2, 0, rc];

test('MqttClient connect, subscribe, receive, publish', async () => {
  const { FakeWS, instances } = makeFakeWs((ws, bytes) => {
    const type = bytes[0] >> 4;
    if (type === 1) ws.deliver(connack(0));
    if (type === 8) {
      ws.deliver([0x90, 3, bytes[2], bytes[3], 0]);
      const msg = encodePublish('devsrpc/attr/d1', JSON.stringify({ method: 'properties_changed', params: [{ pid: 2, value: 3 }] }));
      ws.deliver(msg.slice(0, 5)); ws.deliver(msg.slice(5)); // fragmented
    }
  });
  const c = new MqttClient({ url: 'ws://x/mqtt', token: 'a b', WebSocketImpl: FakeWS });
  const events = [];
  c.addEventListener('frame', (e) => events.push(e.detail));
  const got = new Promise((res) => c.addEventListener('message', (e) => res(e.detail)));
  await c.connect();
  assert.equal(instances[0].url, 'ws://x/mqtt?token=a%20b');
  assert.equal(instances[0].proto, 'mqtt');
  const connectPkt = instances[0].sent[0];
  assert.match(new TextDecoder().decode(connectPkt.slice(14)), /^pc[0-9a-f]{10}$/);
  assert.equal(await c.subscribe('devsrpc/attr/d1'), 0);
  const m = await got;
  assert.equal(m.topic, 'devsrpc/attr/d1');
  assert.deepEqual(parseReport(m.payload), [{ pid: 2, value: 3 }]);
  c.publish('devcrpc/action/d1', cleanPayload(9));
  assert.ok(events.some((e) => e.dir === 'out' && e.type === 'PUBLISH' && e.topic === 'devcrpc/action/d1'));
  assert.ok(events.some((e) => e.dir === 'in' && e.type === 'CONNACK'));
  c.close();
});

test('MqttClient SUBACK 0x80 and CONNACK refusal', async () => {
  const f1 = makeFakeWs((ws, b) => {
    if (b[0] >> 4 === 1) ws.deliver(connack(0));
    if (b[0] >> 4 === 8) ws.deliver([0x90, 3, b[2], b[3], 0x80]);
  });
  const c = new MqttClient({ url: 'ws://x', token: 't', WebSocketImpl: f1.FakeWS });
  await c.connect();
  assert.equal(await c.subscribe('#'), 0x80);
  c.close();
  const f2 = makeFakeWs((ws, b) => { if (b[0] >> 4 === 1) ws.deliver(connack(5)); });
  await assert.rejects(new MqttClient({ url: 'ws://x', token: 't', WebSocketImpl: f2.FakeWS }).connect(), { code: 5 });
});

test('publishOnce sends one publish then DISCONNECT', async () => {
  const f = makeFakeWs((ws, b) => { if (b[0] >> 4 === 1) ws.deliver(connack(0)); });
  await publishOnce({ url: 'ws://x', token: 't', WebSocketImpl: f.FakeWS }, 'devcrpc/action/d', cleanPayload(1));
  const sent = f.instances[0].sent;
  assert.equal(sent[1][0], 0x30);
  assert.deepEqual([...sent[2]], [0xe0, 0]);
});

test('normalizeInfo variants', () => {
  assert.deepEqual(normalizeInfo({ worknum: '3', lastworknum: 120, rubbish: '2', isonline: '1', manualmode: 0 }),
    { w: 3, lw: 120, r: 2, on: 1, m: 0 });
  assert.deepEqual(normalizeInfo({}), { w: null, lw: null, r: null, on: null, m: null });
  assert.deepEqual(normalizeInfo(null), { w: null, lw: null, r: null, on: null, m: null });
  assert.equal(normalizeInfo({ worknum: 'abc' }).w, null);
  assert.equal(normalizeInfo({ isonline: 1 }).on, 1);
  assert.equal(normalizeInfo({ isonline: '0' }).on, 0);
});

test('parseDevices shapes', () => {
  assert.deepEqual(parseDevices({ devicelist: [{ devid: 'a', name: 'Box', model: 'LB02K' }] }), [{ devid: 'a', name: 'Box', model: 'LB02K' }]);
  assert.equal(parseDevices({ devices: [{ _id: 'b' }] })[0].devid, 'b');
  assert.equal(parseDevices({ deviceList: [{ did: 7, nickname: 'N' }] })[0].devid, '7');
  assert.equal(parseDevices({ list: [{ devid: 'c' }, {}, null] }).length, 1);
  assert.deepEqual(parseDevices(null), []);
  assert.deepEqual(parseDevices({ other: 1 }), []);
});

test('binState', () => {
  assert.equal(binState(2), 'full');
  assert.equal(binState('2'), 'full');
  assert.equal(binState(0), 'ok');
  assert.equal(binState(1), 'ok');
  assert.equal(binState(null), 'unclear');
  assert.equal(binState(undefined), 'unclear');
  assert.equal(binState('x'), 'unclear');
});

test('deviceKey determinism and email normalisation', async () => {
  const a = await deviceKey('Me@Example.com', 'dev1');
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(a, await deviceKey('  me@example.COM ', 'dev1'));
  assert.notEqual(a, await deviceKey('me@example.com', 'dev2'));
  const expect = crypto.createHash('sha256').update('popur-control:v1:me@example.com:dev1').digest('hex').slice(0, 12);
  assert.equal(a, expect);
});

test('redact and maskEmail', () => {
  const out = redact({ worknum: 3, devid: 'abc', nested: { token: 'zzz', note: 'secret1', n: 5 }, list: [{ mac: '1' }, 'secret1'] }, ['secret1']);
  assert.equal(out.worknum, 3);
  assert.equal(out.devid, '•••');
  assert.equal(out.nested.token, '•••');
  assert.equal(out.nested.note, '•••');
  assert.equal(out.nested.n, 5);
  assert.equal(out.list[0].mac, '•••');
  assert.equal(out.list[1], '•••');
  assert.equal(maskEmail('mick@example.com'), 'm•••@example.com');
  assert.equal(maskEmail(''), '');
});

test('makeSetupCode decrypts with matching private key', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const code = await makeSetupCode('me@example.com', 'abc123', spki, 1700000000);
  assert.ok(code.startsWith('POPUR1.'));
  const b64u = code.slice(7);
  assert.match(b64u, /^[A-Za-z0-9_-]+$/);
  const pt = crypto.privateDecrypt({ key: privateKey, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
    Buffer.from(b64u, 'base64url'));
  assert.deepEqual(JSON.parse(pt.toString()), { v: 1, e: 'me@example.com', h: 'abc123', t: 1700000000 });
});

test('embedded handoff SPKI is a valid RSA-OAEP key', async () => {
  const code = await makeSetupCode('a@b.c', 'h', CONFIG.HANDOFF_SPKI, 1);
  assert.ok(code.length > 300);
});

test('applyOverrides honoured on localhost only', () => {
  const search = '?api=http://localhost:8787&wss=ws://localhost:8787/mqtt&data=http://localhost:8787/data/';
  const local = applyOverrides({ hostname: 'localhost', search });
  assert.equal(local.API, 'http://localhost:8787');
  assert.equal(local.WSS, 'ws://localhost:8787/mqtt');
  assert.equal(local.DATA, 'http://localhost:8787/data/');
  assert.equal(applyOverrides({ hostname: '127.0.0.1', search }).API, 'http://localhost:8787');
  const prod = applyOverrides({ hostname: 'micknotthemouse.github.io', search });
  assert.equal(prod.API, 'https://cloud.popur.com.cn');
  assert.equal(prod.WSS, CONFIG.WSS);
  assert.equal(prod.DATA, CONFIG.DATA);
  assert.equal(CONFIG.API, 'https://cloud.popur.com.cn');
});

test('parseNdjson skips bad lines', () => {
  const out = parseNdjson('{"t":2}\nnot json\n\n{"t":1}\n"str"\n');
  assert.deepEqual(out, [{ t: 2 }, { t: 1 }]);
});

// ---- api.js with an injected fetch ----
function fakeFetch(handler) {
  return async (url, init) => {
    const r = await handler(url, init);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => { if (r.body === undefined) throw new Error('no json'); return r.body; } };
  };
}

test('PopurApi login and authed calls', async () => {
  const seen = [];
  const api = new PopurApi({ base: 'http://m/', fetchImpl: fakeFetch((url, init) => {
    seen.push([url, init]);
    if (url.endsWith('/uapi/auth')) return { status: 200, body: { code: 200, data: { token: 'T', user: { _id: 'u1', defaulthomeid: 'h1' } } } };
    if (url.endsWith('/uapi/home_details/h1')) return { status: 200, body: { code: 200, data: { devicelist: [{ devid: 'd1', name: 'Box' }] } } };
    if (url.endsWith('/uapi/deviceinfo/info/d1')) return { status: 200, body: { code: 200, data: { worknum: '4', rubbish: 2 } } };
    if (url.endsWith('/uapi/user')) return { status: 200, body: { code: 200, data: { x: 1 } } };
    return { status: 404 };
  }) });
  const s = await api.login('me@x.com', 'md5');
  assert.deepEqual(s, { token: 'T', homeId: 'h1', userId: 'u1' });
  assert.deepEqual(JSON.parse(seen[0][1].body), { param: 'me@x.com', password: 'md5', type: '2' });
  assert.equal(seen[0][0], 'http://m/uapi/auth');
  const h = await api.homeDetails();
  assert.equal(h.devices[0].devid, 'd1');
  assert.equal(seen[1][1].headers.Authorization, 'Bearer T');
  assert.ok(!('User-Agent' in seen[1][1].headers));
  const info = await api.deviceInfo('d1');
  assert.equal(info.reading.r, 2);
  assert.equal(info.reading.w, 4);
  assert.ok(info.t > 1.7e9);
  assert.deepEqual(await api.user(), { x: 1 });
});

test('PopurApi error kinds', async () => {
  const mk = (r) => { const a = new PopurApi({ base: 'http://m', fetchImpl: fakeFetch(r) }); a.token = 't'; a.homeId = 'h'; return a; };
  const kind = async (p) => { try { await p; return 'none'; } catch (e) { assert.ok(e instanceof ApiError); return e.kind + ':' + e.code; } };
  assert.equal(await kind(mk(() => ({ status: 401, body: { code: 400 } })).deviceInfo('d')), 'auth:400');
  assert.equal(await kind(mk(() => ({ status: 200, body: { code: 20001 } })).deviceInfo('d')), 'auth:20001');
  assert.equal(await kind(mk(() => ({ status: 200, body: { code: 401 } })).deviceInfo('d')), 'auth:401');
  assert.equal(await kind(mk(() => ({ status: 500 })).deviceInfo('d')), 'http:null');
  assert.equal(await kind(mk(() => ({ status: 200, body: { code: 200 } })).deviceInfo('d')), 'shape:200');
  assert.equal(await kind(mk(() => { throw new Error('boom'); }).deviceInfo('d')), 'network:null');
  assert.equal(await kind(mk(() => ({ status: 200, body: { code: 1004 } })).login('a', 'b')), 'login:1004');
  assert.equal(await kind(mk(() => ({ status: 200, body: { code: 200, data: { token: 'x' } } })).login('a', 'b')), 'shape:200');
});

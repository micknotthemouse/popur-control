import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock } from './mock-server.mjs';
import { makeHistory, DK } from './fixtures/make-history.mjs';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mock;
test.before(async () => { mock = await startMock({ port: 0, cleanMs: 400 }); });
test.after(async () => { await mock.close(); });

async function post(p, body) {
  const r = await fetch(mock.url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}
async function get(p, token) {
  const r = await fetch(mock.url + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: r.status, json: await r.json() };
}
async function login() {
  const r = await post('/uapi/auth', { param: 'cat@example.com', password: md5('meow123'), type: '2' });
  return r.json.data.token;
}
const scenario = (name, o = {}) => post('/__scenario', { name, ...o });

// --- tiny MQTT helpers (hand-written bytes) ---
const str = (s) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]); };
const pkt = (first, body) => Buffer.concat([Buffer.from([first, body.length]), body]); // bodies here are < 128 bytes unless varint below
function pkt2(first, body) {
  const out = []; let n = body.length;
  do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; out.push(b); } while (n);
  return Buffer.concat([Buffer.from([first, ...out]), body]);
}
const connect = () => pkt(0x10, Buffer.concat([str('MQTT'), Buffer.from([4, 2, 0, 60]), str('selftest')]));
const subscribe = (topic) => pkt(0x82, Buffer.concat([Buffer.from([0, 1]), str(topic), Buffer.from([0])]));
const publish = (topic, obj) => pkt2(0x30, Buffer.concat([str(topic), Buffer.from(JSON.stringify(obj))]));

function openWs(token) {
  const ws = new WebSocket(mock.url.replace('http', 'ws') + '/mqtt?token=' + encodeURIComponent(token), 'mqtt');
  ws.binaryType = 'arraybuffer';
  const packets = []; const waiters = [];
  let buf = Buffer.alloc(0);
  ws.onmessage = (e) => {
    buf = Buffer.concat([buf, Buffer.from(e.data)]);
    while (buf.length >= 2) {
      const len = buf[1]; // all server packets in these tests are < 128 bytes
      if (buf.length < 2 + len) break;
      const p = { type: buf[0] >> 4, body: buf.subarray(2, 2 + len) };
      buf = buf.subarray(2 + len);
      packets.push(p); waiters.splice(0).forEach((w) => w());
    }
  };
  const next = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
      const i = packets.findIndex(pred);
      if (i >= 0) return packets.splice(i, 1)[0];
      if (Date.now() > end) throw new Error('timeout waiting for packet');
      await new Promise((r) => { waiters.push(r); setTimeout(r, 100); });
    }
  };
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  return { ws, next, opened };
}
const reportOf = (p) => {
  const tl = (p.body[0] << 8) | p.body[1];
  return JSON.parse(p.body.subarray(2 + tl).toString()).params[0];
};

test('login ok, wrong password, and 401 without token', async () => {
  await scenario('normal');
  const ok = await post('/uapi/auth', { param: 'cat@example.com', password: md5('meow123'), type: '2' });
  assert.equal(ok.json.code, 200);
  assert.equal(ok.json.data.user._id, 'u_test_123');
  assert.equal(ok.json.data.user.defaulthomeid, 'h_test_456');
  const bad = await post('/uapi/auth', { param: 'cat@example.com', password: md5('nope'), type: '2' });
  assert.equal(bad.status, 200);
  assert.equal(bad.json.code, 10003);
  const noTok = await get('/uapi/user');
  assert.equal(noTok.status, 401);
  assert.equal(noTok.json.code, 400);
});

test('CORS preflight and deviceinfo fields', async () => {
  const pre = await fetch(mock.url + '/uapi/auth', { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  const tok = await login();
  const home = await get('/uapi/home_details/h_test_456', tok);
  assert.equal(home.json.data.devicelist[0].devid, 'dev_test_789');
  const info = (await get('/uapi/deviceinfo/info/dev_test_789', tok)).json.data;
  for (const k of ['rubbish', 'worknum', 'lastworknum', 'manualmode', 'isonline', 'firmware', 'mac', 'ssid', 'sandlevel', 'catweight', 'errcode']) assert.ok(k in info, k);
  assert.equal(info.worknum, 3);
  assert.equal(info.lastworknum, 1452);
  assert.equal((await get('/uapi/user', tok)).json.data.email, 'cat@example.com');
});

test('scenario switching', async () => {
  const tok = await login();
  await scenario('binFull');
  assert.equal((await get('/uapi/deviceinfo/info/dev_test_789', tok)).json.data.rubbish, 2);
  await scenario('offline');
  assert.equal((await get('/uapi/deviceinfo/info/dev_test_789', tok)).json.data.isonline, '0');
  await scenario('twoDevices');
  assert.equal((await get('/uapi/home_details/h_test_456', tok)).json.data.devicelist.length, 2);
  await scenario('normal', { worknum: 9 });
  assert.equal((await get('/uapi/deviceinfo/info/dev_test_789', tok)).json.data.worknum, 9);
  await scenario('tokenExpired');
  assert.equal((await get('/uapi/user', tok)).status, 401);
  const fresh = await login();
  assert.equal((await get('/uapi/user', fresh)).status, 200);
  await scenario('loginFail');
  const r = await post('/uapi/auth', { param: 'cat@example.com', password: md5('meow123'), type: '2' });
  assert.equal(r.json.code, 10003);
  await scenario('server500');
  assert.equal((await get('/uapi/user', fresh)).status, 500);
  await scenario('normal');
});

test('websocket rejects a bad token', async () => {
  const r = await fetch(mock.url + '/mqtt?token=bad', { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' } }).catch(() => null);
  // fetch may refuse upgrade headers; fall back to the WebSocket client
  if (r) assert.equal(r.status, 401);
  const { ws, opened } = openWs('bad');
  await assert.rejects(opened);
  try { ws.close(); } catch { /* ignore */ }
});

test('MQTT clean cycle over WebSocket updates worknum and logs publishes', async () => {
  await scenario('normal');
  await post('/__log/clear', {});
  const tok = await login();
  const { ws, next, opened } = openWs(tok);
  await opened;
  assert.equal(ws.protocol, 'mqtt');
  ws.send(connect());
  assert.equal((await next((p) => p.type === 2)).body[1], 0);
  ws.send(subscribe('devsrpc/attr/dev_test_789'));
  assert.equal((await next((p) => p.type === 9)).body[2], 0);
  ws.send(publish('devcrpc/action/dev_test_789', { id: 1, method: 'action', from: 'remote', params: { did: '0', sid: 2, aid: 1, in: [] } }));
  const first = reportOf(await next((p) => p.type === 3));
  assert.equal(first.pid, 2); assert.equal(first.value, 1);
  const w = reportOf(await next((p) => p.type === 3));
  assert.equal(w.pid, 8); assert.equal(w.value, 4);
  const last = reportOf(await next((p) => p.type === 3));
  assert.equal(last.pid, 2); assert.equal(last.value, 0);
  ws.send(Buffer.from([0xc0, 0]));
  await next((p) => p.type === 13);
  const info = (await get('/uapi/deviceinfo/info/dev_test_789', tok)).json.data;
  assert.equal(info.worknum, 4); assert.equal(info.lastworknum, 1453);
  const log = await (await fetch(mock.url + '/__log')).json();
  assert.ok(log.some((e) => e.kind === 'mqtt' && e.dir === 'publish' && e.topic === 'devcrpc/action/dev_test_789'));
  assert.ok(log.some((e) => e.kind === 'mqtt' && e.dir === 'subscribe'));
  ws.send(Buffer.from([0xe0, 0]));
  ws.close();
});

test('subscribeRefused returns 0x80 and cleanSilent ignores the command', async () => {
  const tok = await login();
  await scenario('subscribeRefused');
  let c = openWs(tok); await c.opened;
  c.ws.send(connect()); await c.next((p) => p.type === 2);
  c.ws.send(subscribe('devsrpc/attr/dev_test_789'));
  assert.equal((await c.next((p) => p.type === 9)).body[2], 0x80);
  c.ws.close();
  await scenario('cleanSilent');
  c = openWs(tok); await c.opened;
  c.ws.send(connect()); await c.next((p) => p.type === 2);
  c.ws.send(subscribe('devsrpc/attr/dev_test_789')); await c.next((p) => p.type === 9);
  c.ws.send(publish('devcrpc/action/dev_test_789', { params: { sid: 2, aid: 1 } }));
  await assert.rejects(c.next((p) => p.type === 3, 800));
  c.ws.close();
  await scenario('normal');
});

test('manual mode set_properties updates state', async () => {
  const tok = await login();
  const c = openWs(tok); await c.opened;
  c.ws.send(connect()); await c.next((p) => p.type === 2);
  c.ws.send(subscribe('devsrpc/attr/dev_test_789')); await c.next((p) => p.type === 9);
  c.ws.send(publish('devcrpc/attr/dev_test_789', { id: 1, method: 'set_properties', from: 'remote', params: [{ did: '0', sid: 2, pid: 3, value: 1 }] }));
  const r = reportOf(await c.next((p) => p.type === 3));
  assert.equal(r.pid, 3); assert.equal(r.value, 1);
  assert.equal((await get('/uapi/deviceinfo/info/dev_test_789', tok)).json.data.manualmode, '1');
  c.ws.close();
  await sleep(50);
});

test('static serving rewrites CSP, serves data dir, 404 when missing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-'));
  const docs = path.join(tmp, 'docs'); const data = path.join(tmp, 'data');
  fs.mkdirSync(docs); fs.mkdirSync(data);
  fs.writeFileSync(path.join(docs, 'index.html'), '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; connect-src \'self\' https://x.example; base-uri \'none\'">');
  fs.writeFileSync(path.join(docs, 'm.webmanifest'), '{}');
  fs.writeFileSync(path.join(data, 'a.json'), '{"a":1}');
  const m2 = await startMock({ port: 0, docsDir: docs, dataDir: data });
  try {
    const html = await (await fetch(m2.url + '/')).text();
    assert.ok(html.includes(`http://localhost:${m2.port} ws://localhost:${m2.port}`));
    assert.equal((await fetch(m2.url + '/m.webmanifest')).headers.get('content-type'), 'application/manifest+json');
    assert.equal((await fetch(m2.url + '/data/a.json')).status, 200);
    assert.equal((await fetch(m2.url + '/data/zzz.json')).status, 404);
    assert.equal((await fetch(m2.url + '/data/..%2findex.html')).status, 403); // traversal blocked
    assert.equal((await fetch(m2.url + '/')).headers.get('cache-control'), 'no-store');
  } finally { await m2.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('make-history writes valid files in every mode', () => {
  const now = 1760950000;
  for (const mode of ['full', 'empty', 'notsetup', 'stale', 'setup']) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
    try {
      makeHistory({ out, mode, days: 30, now });
      const sp = path.join(out, 'status', 'gha.json');
      if (mode === 'notsetup') { assert.ok(!fs.existsSync(sp)); continue; }
      const status = JSON.parse(fs.readFileSync(sp, 'utf8'));
      assert.equal(status.v, 1);
      const hd = path.join(out, 'history', DK);
      if (mode === 'setup') { assert.equal(status.run.err.kind, 'setup'); assert.ok(!fs.existsSync(hd)); continue; }
      if (mode === 'empty') { assert.ok(!fs.existsSync(hd)); assert.ok(now - status.run.t < 600); continue; }
      const rows = fs.readdirSync(hd).flatMap((f) => fs.readFileSync(path.join(hd, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
      assert.ok(rows.length > 100, 'enough lines');
      for (let i = 1; i < rows.length; i++) assert.ok(rows[i].t > rows[i - 1].t);
      if (mode === 'full') {
        assert.ok(now - status.run.t < 600);
        assert.ok(rows.some((r) => r.bf === 1) && rows.some((r) => r.m === 1));
        assert.ok(rows.some((r, i) => i && r.t - r.pv > 2 * 3600), 'has a gap line');
        const visitsPerDay = rows.filter((r, i) => i && r.w > rows[i - 1].w).length / 30;
        assert.ok(visitsPerDay > 2 && visitsPerDay < 9, `visits/day ${visitsPerDay}`);
      } else { assert.ok(now - status.run.t >= 7 * 3600); }
    } finally { fs.rmSync(out, { recursive: true, force: true }); }
  }
});

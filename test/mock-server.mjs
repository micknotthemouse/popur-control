// Mock Popur cloud: REST + MQTT 3.1.1 over WebSocket, plus static hosting of docs/ and a data dir.
// Zero dependencies. Independent of docs/lib/mqtt.js on purpose.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EMAIL = 'cat@example.com';
const PASS_MD5 = crypto.createHash('md5').update('meow123').digest('hex');
const USER_ID = 'u_test_123';
const HOME_ID = 'h_test_456';
const DEV1 = 'dev_test_789';
const DEV2 = 'dev_test_second';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.ndjson': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Origin, Content-Type, Authorization, lang, tz',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

function baseState() {
  return { rubbish: 0, worknum: 3, lastworknum: 1452, manualmode: '0', isonline: '1', cleanMs: 6000 };
}

export function startMock({ port = 0, dataDir = null, docsDir = path.join(ROOT, 'docs'), scenario = 'normal', cleanMs } = {}) {
  const tokens = new Set();
  const logEntries = [];
  const sockets = new Set();
  const timers = new Set();
  let scen = { name: 'normal' };
  let devs = {};
  let flags = {};
  let actualPort = port;

  const log = (e) => { logEntries.push({ t: Date.now(), ...e }); if (logEntries.length > 3000) logEntries.shift(); };

  function setScenario(name, overrides = {}) {
    for (const t of timers) { clearInterval(t); clearTimeout(t); }
    timers.clear();
    scen = { name };
    flags = { expireOnce: name === 'tokenExpired', evictAfterCall: name === 'evicted', firstInfo: true, flapN: 0 };
    devs = { [DEV1]: baseState(), [DEV2]: { ...baseState(), worknum: 1, lastworknum: 88 } };
    const d = devs[DEV1];
    if (cleanMs != null) { d.cleanMs = cleanMs; devs[DEV2].cleanMs = cleanMs; }
    if (name === 'binFull') d.rubbish = 2;
    if (name === 'offline') d.isonline = '0';
    if (name === 'manual') d.manualmode = '1';
    if (name === 'resetDrop') flags.dropAfterFirst = true;
    if (name === 'catInside') {
      const iv = setInterval(() => report(DEV1, [{ pid: 2, value: 3 }]), 2000);
      timers.add(iv);
    }
    for (const [k, v] of Object.entries(overrides)) if (k in d) d[k] = v;
    return scen;
  }

  // ---------- helpers ----------
  const has = (n) => scen.name === n;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function sendJson(res, status, obj, extra = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS, ...extra });
    res.end(body);
  }

  function bearer(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    return m ? m[1] : null;
  }

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const s = Buffer.concat(chunks).toString('utf8');
    try { return s ? JSON.parse(s) : {}; } catch { return {}; }
  }

  // ---------- REST ----------
  async function handleRest(req, res, url) {
    const p = url.pathname;
    const rec = (status) => log({ kind: 'rest', method: req.method, path: p, status });
    if (has('slow')) await sleep(3000);
    if (has('server500')) { rec(500); return sendJson(res, 500, { code: 500, msg: 'server error' }); }

    if (p === '/uapi/auth' && req.method === 'POST') {
      const b = await readBody(req);
      const ok = !has('loginFail') && b.param === EMAIL && b.password === PASS_MD5;
      if (!ok) { rec(200); return sendJson(res, 200, { code: 10003, msg: '账号或密码错误' }); }
      const token = crypto.randomBytes(24).toString('hex');
      tokens.add(token);
      rec(200);
      return sendJson(res, 200, { code: 200, msg: 'ok', data: { token, user: { _id: USER_ID, defaulthomeid: HOME_ID, email: EMAIL } } });
    }

    // authed routes
    const tok = bearer(req);
    if (flags.expireOnce && tok) {
      flags.expireOnce = false;
      tokens.clear();
      rec(401);
      return sendJson(res, 401, { code: 400, msg: '请求参数错误' });
    }
    if (!tok || !tokens.has(tok)) { rec(401); return sendJson(res, 401, { code: 400, msg: '请求参数错误' }); }
    if (flags.evictAfterCall) tokens.clear();

    let m;
    if (req.method === 'GET' && (m = /^\/uapi\/home_details\/([^/]+)$/.exec(p))) {
      const list = [{ devid: DEV1, name: 'Litter Box', model: 'LB02K' }];
      if (has('twoDevices')) list.push({ devid: DEV2, name: 'Upstairs Box', model: 'LB02K' });
      rec(200);
      return sendJson(res, 200, { code: 200, data: { devicelist: list } });
    }
    if (req.method === 'GET' && (m = /^\/uapi\/deviceinfo\/info\/([^/]+)$/.exec(p))) {
      const devid = decodeURIComponent(m[1]);
      const d = devs[devid];
      if (!d) { rec(200); return sendJson(res, 200, { code: 400, msg: '请求参数错误' }); }
      let rubbish = d.rubbish;
      let worknum = d.worknum;
      if (has('binFlap') && devid === DEV1) rubbish = flags.flapN++ % 2 === 0 ? 2 : 0;
      if (flags.dropAfterFirst && devid === DEV1) {
        if (flags.firstInfo) flags.firstInfo = false; else worknum = 0;
      }
      const data = {
        devid, rubbish, worknum, lastworknum: d.lastworknum, manualmode: d.manualmode, isonline: d.isonline,
        firmware: '1.0.8', mac: 'AA:BB:CC:DD:EE:FF', ssid: 'HomeWifi', sandlevel: 1, catweight: 4520, errcode: 0,
      };
      if (has('unknownFields')) Object.assign(data, { fanspeed: 2, nightmode: '0', zonecode: 8, status: 1, lastvisit: 1760950000 });
      rec(200);
      return sendJson(res, 200, { code: 200, data });
    }
    if (req.method === 'GET' && p === '/uapi/user') {
      rec(200);
      return sendJson(res, 200, { code: 200, data: { _id: USER_ID, email: EMAIL, nickname: 'Test' } });
    }
    rec(404);
    res.writeHead(404, { 'Content-Type': 'text/plain', ...CORS });
    res.end('404 page not found');
  }

  // ---------- control endpoints ----------
  async function handleControl(req, res, url) {
    if (url.pathname === '/__scenario' && req.method === 'POST') {
      const { name = 'normal', ...overrides } = await readBody(req);
      setScenario(name, overrides);
      return sendJson(res, 200, { ok: true, scenario: name });
    }
    if (url.pathname === '/__log' && req.method === 'GET') return sendJson(res, 200, logEntries);
    if (url.pathname === '/__log/clear' && req.method === 'POST') { logEntries.length = 0; return sendJson(res, 200, { ok: true }); }
    return sendJson(res, 404, { error: 'unknown control endpoint' });
  }

  // ---------- static ----------
  function safeJoin(base, rel) {
    const full = path.resolve(base, '.' + path.sep + rel);
    return full === path.resolve(base) || full.startsWith(path.resolve(base) + path.sep) ? full : null;
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    let base = docsDir;
    if (rel === '/data' || rel.startsWith('/data/')) {
      if (!dataDir) { res.writeHead(404, CORS); return res.end('no data'); }
      base = dataDir; rel = rel.slice('/data'.length);
    }
    let file = safeJoin(base, rel);
    if (!file) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Cache-Control': 'no-store', ...CORS });
      return res.end('not found');
    }
    const ext = path.extname(file).toLowerCase();
    let body = fs.readFileSync(file);
    if (base === docsDir && path.basename(file) === 'index.html') {
      const extra = `http://localhost:${actualPort} ws://localhost:${actualPort} http://127.0.0.1:${actualPort} ws://127.0.0.1:${actualPort}`;
      body = Buffer.from(body.toString('utf8').replace(/(connect-src[^;"]*)/, `$1 ${extra}`));
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store', ...CORS });
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'OPTIONS') { res.writeHead(204, { ...CORS, 'Access-Control-Max-Age': '600' }); return res.end(); }
      if (url.pathname.startsWith('/__')) return await handleControl(req, res, url);
      if (url.pathname.startsWith('/uapi/')) return await handleRest(req, res, url);
      return serveStatic(req, res, url);
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { code: 500, msg: String(e && e.message) });
    }
  });

  // ---------- WebSocket + MQTT ----------
  const conns = new Set(); // {socket, subs:Set<string>, wsBuf, mqttBuf, fragments}

  function wsFrame(opcode, payload) {
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    return Buffer.concat([head, payload]);
  }

  const send = (c, buf) => { if (!c.socket.destroyed) c.socket.write(wsFrame(0x2, buf)); };

  function varint(n) {
    const out = [];
    do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
    return Buffer.from(out);
  }

  function publishPacket(topic, payloadBuf) {
    const t = Buffer.from(topic);
    const tl = Buffer.alloc(2); tl.writeUInt16BE(t.length);
    const body = Buffer.concat([tl, t, payloadBuf]);
    return Buffer.concat([Buffer.from([0x30]), varint(body.length), body]);
  }

  function topicMatches(filter, topic) {
    if (filter === topic || filter === '#') return true;
    const f = filter.split('/'), t = topic.split('/');
    for (let i = 0; i < f.length; i++) {
      if (f[i] === '#') return true;
      if (i >= t.length) return false;
      if (f[i] !== '+' && f[i] !== t[i]) return false;
    }
    return f.length === t.length;
  }

  function route(topic, payloadBuf) {
    const pkt = publishPacket(topic, payloadBuf);
    for (const c of conns) if ([...c.subs].some((f) => topicMatches(f, topic))) send(c, pkt);
  }

  function report(devid, params) {
    const body = { method: 'properties_changed', params: params.map((p) => ({ did: '0', sid: 2, ...p })) };
    route(`devsrpc/attr/${devid}`, Buffer.from(JSON.stringify(body)));
  }

  function onDevicePublish(topic, payload) {
    let obj; try { obj = JSON.parse(payload.toString('utf8')); } catch { return; }
    let m;
    if ((m = /^devcrpc\/action\/(.+)$/.exec(topic))) {
      const devid = m[1], d = devs[devid];
      const p = obj && obj.params;
      if (!d || !p || p.aid !== 1 || has('cleanSilent')) return;
      report(devid, [{ pid: 2, value: 1 }]);
      const t = setTimeout(() => {
        timers.delete(t);
        d.worknum += 1; d.lastworknum += 1;
        report(devid, [{ pid: 8, value: d.worknum }]);
        report(devid, [{ pid: 2, value: 0 }]);
      }, d.cleanMs);
      timers.add(t);
    } else if ((m = /^devcrpc\/attr\/(.+)$/.exec(topic))) {
      const devid = m[1], d = devs[devid];
      const list = Array.isArray(obj && obj.params) ? obj.params : [];
      for (const p of list) {
        if (d && p.pid === 3) { d.manualmode = String(p.value) === '1' ? '1' : '0'; report(devid, [{ pid: 3, value: Number(p.value) }]); }
      }
    }
  }

  function handleMqtt(c, buf) {
    c.mqttBuf = Buffer.concat([c.mqttBuf, buf]);
    for (;;) {
      const b = c.mqttBuf;
      if (b.length < 2) return;
      let mult = 1, len = 0, i = 1, byte;
      do {
        if (i >= b.length) return;
        byte = b[i++]; len += (byte & 127) * mult; mult *= 128;
      } while (byte & 128);
      if (b.length < i + len) return;
      const type = b[0] >> 4, flagBits = b[0] & 15, body = b.subarray(i, i + len);
      c.mqttBuf = b.subarray(i + len);
      handlePacket(c, type, flagBits, body);
    }
  }

  function handlePacket(c, type, flagBits, body) {
    if (type === 1) { log({ kind: 'mqtt', dir: 'connect' }); send(c, Buffer.from([0x20, 2, 0, 0])); }
    else if (type === 8) {
      const id = body.subarray(0, 2); let o = 2; const codes = [];
      while (o + 2 <= body.length) {
        const tl = body.readUInt16BE(o); const topic = body.toString('utf8', o + 2, o + 2 + tl); o += 2 + tl + 1;
        const refused = has('subscribeRefused');
        log({ kind: 'mqtt', dir: 'subscribe', topic, granted: refused ? 0x80 : 0 });
        if (refused) codes.push(0x80); else { c.subs.add(topic); codes.push(0); }
      }
      send(c, Buffer.concat([Buffer.from([0x90, 2 + codes.length]), id, Buffer.from(codes)]));
    } else if (type === 10) {
      const id = body.subarray(0, 2); let o = 2;
      while (o + 2 <= body.length) { const tl = body.readUInt16BE(o); c.subs.delete(body.toString('utf8', o + 2, o + 2 + tl)); o += 2 + tl; }
      send(c, Buffer.concat([Buffer.from([0xb0, 2]), id]));
    } else if (type === 3) {
      const qos = (flagBits >> 1) & 3;
      const tl = body.readUInt16BE(0); const topic = body.toString('utf8', 2, 2 + tl);
      let o = 2 + tl; let id = null;
      if (qos > 0) { id = body.subarray(o, o + 2); o += 2; }
      const payload = body.subarray(o);
      log({ kind: 'mqtt', dir: 'publish', topic, payload: payload.toString('utf8') });
      if (qos === 1) send(c, Buffer.concat([Buffer.from([0x40, 2]), id]));
      route(topic, payload);
      onDevicePublish(topic, payload);
    } else if (type === 12) send(c, Buffer.from([0xd0, 0]));
    else if (type === 14) { log({ kind: 'mqtt', dir: 'disconnect' }); c.socket.end(); }
  }

  function handleWsData(c, data) {
    c.wsBuf = Buffer.concat([c.wsBuf, data]);
    for (;;) {
      const b = c.wsBuf;
      if (b.length < 2) return;
      const fin = !!(b[0] & 0x80), opcode = b[0] & 15, masked = !!(b[1] & 0x80);
      let len = b[1] & 127, o = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); o = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); o = 10; }
      const maskLen = masked ? 4 : 0;
      if (b.length < o + maskLen + len) return;
      const mask = masked ? b.subarray(o, o + 4) : null;
      const payload = Buffer.from(b.subarray(o + maskLen, o + maskLen + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      c.wsBuf = b.subarray(o + maskLen + len);
      if (opcode === 0x8) { c.socket.write(wsFrame(0x8, payload.subarray(0, 2))); c.socket.end(); return; }
      if (opcode === 0x9) { c.socket.write(wsFrame(0xa, payload)); continue; }
      if (opcode === 0xa) continue;
      if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
        c.frags.push(payload);
        if (fin) { const msg = Buffer.concat(c.frags); c.frags = []; handleMqtt(c, msg); }
      }
    }
  }

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://x');
    const tok = url.searchParams.get('token');
    if (url.pathname !== '/mqtt' || !tok || !tokens.has(tok)) {
      log({ kind: 'ws', status: 401 });
      const body = JSON.stringify({ code: 20001, msg: 'Token鉴权失败' });
      socket.end(`HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const wantsMqtt = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim()).includes('mqtt');
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`, ...(wantsMqtt ? ['Sec-WebSocket-Protocol: mqtt'] : []), '', ''].join('\r\n'));
    log({ kind: 'ws', status: 101 });
    const c = { socket, subs: new Set(), wsBuf: Buffer.alloc(0), mqttBuf: Buffer.alloc(0), frags: [] };
    conns.add(c); sockets.add(socket);
    socket.on('data', (d) => { try { handleWsData(c, d); } catch { socket.destroy(); } });
    const done = () => { conns.delete(c); sockets.delete(socket); };
    socket.on('close', done); socket.on('error', done);
  });

  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  setScenario(scenario);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      actualPort = server.address().port;
      resolve({
        url: `http://localhost:${actualPort}`,
        port: actualPort,
        setScenario: (name, o) => setScenario(name, o),
        log: () => logEntries.slice(),
        close: () => new Promise((r) => {
          for (const t of timers) { clearInterval(t); clearTimeout(t); }
          for (const s of sockets) s.destroy();
          server.close(() => r());
        }),
      });
    });
  });
}

// CLI: node test/mock-server.mjs --port 8787 --data test/.tmp/data [--scenario name] [--clean-ms 6000]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
  const dataDir = opt('data', null);
  const m = await startMock({
    port: Number(opt('port', 8787)),
    dataDir: dataDir ? path.resolve(dataDir) : null,
    scenario: opt('scenario', 'normal'),
    cleanMs: opt('clean-ms') != null ? Number(opt('clean-ms')) : undefined,
  });
  console.log(`mock listening on ${m.url}  (login ${EMAIL} / meow123)`);
}

// Collector tests: real git (bare remote + working clone), a mock Popur server and a mock GitHub API.
// Run: node --test test/collector.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deviceKey } from '../docs/lib/privacy.js';
import { shouldFailExit } from '../collector/collect.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COLLECT = path.join(ROOT, 'collector', 'collect.mjs');
const TMP = path.join(ROOT, 'test', '.tmp', 'collector');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const EMAIL = 'cat@example.com';
const PASSWORD = 'meow123';
const MD5 = crypto.createHash('md5').update(PASSWORD).digest('hex');
const USER_ID = 'u_test_123';
const HOME_ID = 'h_test_456';
const DEV_ID = 'dev_test_789';
const DEV_NAME = 'Litter Box';
const GH_TOKEN = 'ghs_fake_token_abc123';
const CACHE_KEY = crypto.randomBytes(32).toString('hex');
const T0 = Date.UTC(2026, 8, 21, 12, 0, 0) / 1000;
const MIN = 60;
const HOUR = 3600;
const DAY = 86400;

// ------------------------------------------------------------------ helpers

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commitId = ['-c', 'user.name=tester', '-c', 'user.email=tester@example.com'];

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

async function startPopur() {
  const S = {
    loginCalls: 0, authedCalls: 0, failLogin: false, valid: new Set(), issued: [], userAgents: new Set(),
    devices: [{ devid: DEV_ID, name: DEV_NAME, model: 'LB02K' }],
    info: { rubbish: 0, worknum: 3, lastworknum: 1452, manualmode: '0', isonline: '1', mac: 77, ssid: 12, firmware: 105, fw_ver: 7, volume: 5, delay: 30 },
  };
  const { srv, url } = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      S.userAgents.add(req.headers['user-agent']);
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'POST' && req.url === '/uapi/auth') {
        S.loginCalls += 1;
        const b = JSON.parse(body || '{}');
        if (S.failLogin || b.param !== EMAIL || b.password !== MD5 || b.type !== '2') return send(200, { code: 400, msg: 'bad' });
        const tok = 'tok_' + crypto.randomBytes(9).toString('hex');
        S.valid.add(tok);
        S.issued.push(tok);
        return send(200, { code: 200, data: { token: tok, user: { _id: USER_ID, defaulthomeid: HOME_ID } } });
      }
      const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (!S.valid.has(bearer)) return send(401, { code: 20001, msg: 'token rejected' });
      S.authedCalls += 1;
      if (req.url === `/uapi/home_details/${HOME_ID}`) {
        return send(200, { code: 200, data: { homename: 'Cat Home', devicelist: S.devices } });
      }
      const m = req.url.match(/^\/uapi\/deviceinfo\/info\/(.+)$/);
      if (m && S.devices.some((d) => d.devid === decodeURIComponent(m[1]))) return send(200, { code: 200, data: { ...S.info } });
      return send(404, { code: 404 });
    });
  });
  return { S, url, close: () => srv.close() };
}

async function startGithub() {
  const calls = [];
  const { srv, url } = await listen((req, res) => {
    calls.push({ method: req.method, path: req.url, auth: req.headers.authorization });
    res.writeHead(204);
    res.end();
  });
  return { calls, url, close: () => srv.close() };
}

let counter = 0;
// One isolated world: bare remote, working clone with a main commit, both mocks.
async function world() {
  const dir = path.join(TMP, `w${++counter}`);
  const bare = path.join(dir, 'bare.git');
  const work = path.join(dir, 'work');
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '--bare', '-b', 'main', bare]);
  git(['clone', '--quiet', bare, work]);
  git(['-C', work, 'checkout', '-B', 'main']);
  fs.writeFileSync(path.join(work, 'hello.txt'), 'main branch\n');
  git(['-C', work, 'add', '.']);
  git(['-C', work, ...commitId, 'commit', '--quiet', '-m', 'main']);
  git(['-C', work, 'push', '--quiet', 'origin', 'HEAD:main']);
  const popur = await startPopur();
  const gh = await startGithub();
  const w = {
    dir, bare, work, popur, S: popur.S, gh,
    outputs: [], // every stdout+stderr of every run, for the privacy grep
    dk: await deviceKey(EMAIL, DEV_ID),
    env: {
      POPUR_EMAIL: EMAIL, POPUR_PASSWORD: PASSWORD, POPUR_API: popur.url, GITHUB_API: gh.url,
      GITHUB_TOKEN: GH_TOKEN, GITHUB_REPOSITORY: 'o/r', COLLECT_RETRY_MS: '50',
    },
    close() { popur.close(); gh.close(); },
    // Runs the collector once at fake time `now`; overrides replace/remove env keys (undefined removes).
    run(now, overrides = {}) { return runCollector(w, now, overrides); },
    show(p) { try { return git(['-C', bare, 'show', `data:${p}`]); } catch { return null; } },
    files() { try { return git(['-C', bare, 'ls-tree', '-r', '--name-only', 'data']).split('\n').filter(Boolean); } catch { return []; } },
    status() { return JSON.parse(w.show('status/gha.json')); },
    lines(month = '2026-09', dk = w.dk) {
      const t = w.show(`history/${dk}/${month}.ndjson`);
      return t ? t.trim().split('\n').map((l) => JSON.parse(l)) : [];
    },
    commits() { try { return Number(git(['-C', bare, 'rev-list', '--count', 'data']).trim()); } catch { return 0; } },
  };
  return w;
}

function runCollector(w, now, overrides) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(POPUR_|COLLECT_|GITHUB_|GIT_)/.test(k)) env[k] = v;
  }
  Object.assign(env, w.env, { COLLECT_NOW: String(now) });
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k]; else env[k] = v;
  }
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [COLLECT], { cwd: w.work, env });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c) => { stdout += c; });
    p.stderr.on('data', (c) => { stderr += c; });
    p.on('error', reject);
    p.on('close', (code) => {
      w.outputs.push({ stdout, stderr });
      resolve({ code, stdout, stderr });
    });
  });
}

async function scenario(fn) {
  const w = await world();
  try { await fn(w); } finally { w.close(); }
}

const withoutMasks = (s) => s.split('\n').filter((l) => !l.startsWith('::add-mask::')).join('\n');

// ------------------------------------------------------------------ tests

test('secrets missing: setup error committed once, then no commit', async () => {
  await scenario(async (w) => {
    const env = { POPUR_EMAIL: undefined, POPUR_PASSWORD: undefined };
    const r1 = await w.run(T0, env);
    assert.equal(r1.code, 0);
    assert.match(r1.stdout, /committed/);
    const s = w.status();
    assert.equal(s.run.err.kind, 'setup');
    assert.equal(s.run.fails, 0);
    assert.deepEqual(w.files().sort(), ['README.md', 'status/gha.json']);
    assert.equal(w.commits(), 1);

    const r2 = await w.run(T0 + 15 * MIN, env);
    assert.equal(r2.code, 0);
    assert.match(r2.stdout, /no changes/);
    assert.equal(w.commits(), 1);
    assert.equal(w.S.loginCalls, 0);
  });
});

test('secrets missing: email without any password is also setup', async () => {
  await scenario(async (w) => {
    const r = await w.run(T0, { POPUR_PASSWORD: undefined });
    assert.equal(r.code, 0);
    assert.equal(w.status().run.err.kind, 'setup');
    assert.equal(w.S.loginCalls, 0);
  });
});

test('first run creates an orphan data branch with README, status and a baseline line', async () => {
  await scenario(async (w) => {
    const r = await w.run(T0);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /appended 1 lines/);
    assert.match(r.stdout, /committed/);
    assert.equal(w.commits(), 1);
    assert.throws(() => git(['-C', w.bare, 'merge-base', 'main', 'data']), 'data shares no history with main');
    assert.ok(w.files().includes('README.md'));
    assert.match(w.show('README.md'), /counts and timestamps only/);
    assert.deepEqual(w.files().filter((f) => f.startsWith('history/')), [`history/${w.dk}/2026-09.ndjson`]);
    const [line] = w.lines();
    assert.deepEqual(line, { t: T0, pv: null, w: 3, lw: 1452, r: 0, bf: 0, on: 1, m: 0 });
    const s = w.status();
    assert.equal(s.v, 1);
    assert.equal(s.src, 'gha');
    assert.equal(s.since, T0);
    assert.deepEqual({ ...s.run, err: s.run.err }, { t: T0, ok: T0, n: 1, fails: 0, err: null });
    assert.equal(s.devices[w.dk].pt, T0);
    assert.equal(w.S.loginCalls, 1);
    assert.ok(w.S.userAgents.has('com.cloudapp.popur.app'));
    assert.equal(s.insights.loginOk, true);
  });
});

test('unchanged run commits status only: pt advances, no new line', async () => {
  await scenario(async (w) => {
    await w.run(T0);
    const r = await w.run(T0 + 15 * MIN);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /appended 0 lines/);
    assert.equal(w.lines().length, 1);
    assert.equal(w.status().devices[w.dk].pt, T0 + 15 * MIN);
    assert.equal(w.status().run.n, 2);
    assert.equal(w.commits(), 2);
  });
});

test('a change appends a line whose pv is the previous poll time', async () => {
  await scenario(async (w) => {
    await w.run(T0);
    await w.run(T0 + 15 * MIN);
    w.S.info.worknum = 4;
    await w.run(T0 + 30 * MIN);
    const lines = w.lines();
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[1], { t: T0 + 30 * MIN, pv: T0 + 15 * MIN, w: 4, lw: 1452, r: 0, bf: 0, on: 1, m: 0 });
  });
});

test('gap over 2 h appends a marker line even when nothing changed', async () => {
  await scenario(async (w) => {
    await w.run(T0);
    await w.run(T0 + 2 * HOUR); // exactly 2 h: not a gap
    assert.equal(w.lines().length, 1);
    await w.run(T0 + 2 * HOUR + 2 * HOUR + MIN); // 2 h 1 min after previous poll
    const lines = w.lines();
    assert.equal(lines.length, 2);
    assert.equal(lines[1].pv, T0 + 2 * HOUR);
  });
});

test('6 h keepalive appends a line even when nothing changed', async () => {
  await scenario(async (w) => {
    const step = 105 * MIN; // under the 2 h gap threshold
    for (let i = 0; i < 4; i++) await w.run(T0 + i * step); // last run at 5 h 15 min
    assert.equal(w.lines().length, 1);
    await w.run(T0 + 4 * step); // 7 h after the last appended line
    const lines = w.lines();
    assert.equal(lines.length, 2);
    assert.equal(lines[1].pv, T0 + 3 * step);
  });
});

test('bin full is debounced: needs 2 consecutive r=2, carries until r != 2', async () => {
  await scenario(async (w) => {
    const seq = [2, 0, 2, 2, 2, 0];
    const expectBf = [0, 0, 0, 1, 1, 0];
    const expectLines = [1, 2, 3, 4, 4, 5];
    for (let i = 0; i < seq.length; i++) {
      w.S.info.rubbish = seq[i];
      await w.run(T0 + i * 15 * MIN);
      const s = w.status();
      assert.equal(s.devices[w.dk].last.bf, expectBf[i], `step ${i} bf`);
      assert.equal(w.lines().length, expectLines[i], `step ${i} lines`);
      if (i === 3) assert.equal(s.devices[w.dk].binFullSince, T0 + 3 * 15 * MIN);
      if (i === 4) assert.equal(s.devices[w.dk].binFullSince, T0 + 3 * 15 * MIN, 'binFullSince is kept while full');
      if (i === 5) assert.equal(s.devices[w.dk].binFullSince, null);
    }
    assert.deepEqual(w.lines().map((l) => l.bf), [0, 0, 0, 1, 0]);
  });
});

test('month rollover starts a new history file (UTC)', async () => {
  await scenario(async (w) => {
    const sep30 = Date.UTC(2026, 8, 30, 23, 50, 0) / 1000;
    await w.run(sep30);
    w.S.info.worknum = 4;
    await w.run(sep30 + 15 * MIN); // 2026-10-01T00:05Z
    assert.equal(w.lines('2026-09').length, 1);
    assert.equal(w.lines('2026-10').length, 1);
    assert.equal(w.lines('2026-10')[0].w, 4);
  });
});

test('token cache: first run logs in and saves session/gha.bin; second run reuses it', async () => {
  await scenario(async (w) => {
    const env = { POPUR_CACHE_KEY: CACHE_KEY };
    const r1 = await w.run(T0, env);
    assert.equal(r1.code, 0);
    assert.equal(w.S.loginCalls, 1);
    const bin1 = w.show('session/gha.bin');
    assert.ok(bin1 && bin1.trim().length > 40);
    assert.ok(!Buffer.from(bin1.trim(), 'base64').toString('latin1').includes(w.S.issued[0]), 'ciphertext does not hold the token in clear');

    const r2 = await w.run(T0 + 15 * MIN, env);
    assert.equal(r2.code, 0);
    assert.equal(w.S.loginCalls, 1, 'no second login');
    assert.match(r2.stdout, /cache: found/);
    const ins = w.status().insights;
    assert.equal(ins.cacheUsed, true);
    assert.deepEqual(Object.values(ins.logins), [1]);
    assert.equal(w.show('session/gha.bin'), bin1, 'cache untouched when it still works');
  });
});

test('token cache: a 401 on the cached token triggers re-login and rewrites the cache', async () => {
  await scenario(async (w) => {
    const env = { POPUR_CACHE_KEY: CACHE_KEY };
    await w.run(T0, env);
    const bin1 = w.show('session/gha.bin');
    w.S.valid.clear(); // server forgets every token
    const r = await w.run(T0 + 15 * MIN, env);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /cache: token rejected/);
    assert.equal(w.S.loginCalls, 2);
    assert.notEqual(w.show('session/gha.bin'), bin1);
    assert.equal(w.status().run.fails, 0);
    assert.equal(w.status().insights.cacheUsed, false);
    await w.run(T0 + 30 * MIN, env);
    assert.equal(w.S.loginCalls, 2, 'new cached token works');
  });
});

test('token cache: a wrong key or garbage cache falls back to login', async () => {
  await scenario(async (w) => {
    await w.run(T0, { POPUR_CACHE_KEY: CACHE_KEY });
    const other = crypto.randomBytes(32).toString('hex');
    const r = await w.run(T0 + 15 * MIN, { POPUR_CACHE_KEY: other });
    assert.equal(r.code, 0);
    assert.equal(w.S.loginCalls, 2);
  });
});

test('without POPUR_CACHE_KEY the collector logs in every run and writes no session file', async () => {
  await scenario(async (w) => {
    await w.run(T0);
    await w.run(T0 + 15 * MIN);
    assert.equal(w.S.loginCalls, 2);
    assert.ok(!w.files().some((f) => f.startsWith('session/')));
    assert.deepEqual(Object.values(w.status().insights.logins), [2]);
  });
});

test('POPUR_PASSWORD_MD5 alone is accepted', async () => {
  await scenario(async (w) => {
    const r = await w.run(T0, { POPUR_PASSWORD: undefined, POPUR_PASSWORD_MD5: MD5 });
    assert.equal(r.code, 0);
    assert.equal(w.lines().length, 1);
  });
});

test('login failure: fails++, err.kind login, exit 0 until fails==8, then exit 1', async () => {
  await scenario(async (w) => {
    await w.run(T0); // healthy baseline
    w.S.failLogin = true;
    for (let i = 1; i <= 8; i++) {
      const r = await w.run(T0 + i * 15 * MIN);
      const s = w.status();
      assert.equal(s.run.fails, i);
      assert.equal(s.run.err.kind, 'login');
      assert.equal(s.run.err.code, '400');
      assert.equal(s.run.ok, T0, 'ok keeps the last success');
      assert.equal(s.insights.loginOk, false);
      assert.equal(r.code, i === 8 ? 1 : 0, `run ${i} exit code`);
    }
    const r9 = await w.run(T0 + 9 * 15 * MIN);
    assert.equal(r9.code, 0);
    w.S.failLogin = false;
    const r10 = await w.run(T0 + 10 * 15 * MIN);
    assert.equal(r10.code, 0);
    const s = w.status();
    assert.equal(s.run.fails, 0);
    assert.equal(s.run.err, null);
  });
});

test('exit cadence helper: 8th failure, then every 96th', () => {
  const hits = [];
  for (let f = 1; f <= 300; f++) if (shouldFailExit(f)) hits.push(f);
  assert.deepEqual(hits, [8, 104, 200, 296]);
});

test('push conflict (another commit lands between fetch and push) is resolved by rebase', async () => {
  await scenario(async (w) => {
    await w.run(T0);
    const other = path.join(w.dir, 'other');
    git(['clone', '--quiet', w.bare, other]);
    const marker = path.join(w.dir, 'injected');
    const inject = path.join(w.dir, 'inject.mjs');
    fs.writeFileSync(inject, `
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const [, , other, marker] = process.argv;
if (fs.existsSync(marker)) process.exit(0);
fs.writeFileSync(marker, '1');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const g = (...a) => execFileSync('git', ['-C', other, '-c', 'user.name=o', '-c', 'user.email=o@example.com', ...a], { env, stdio: 'ignore' });
g('fetch', 'origin', 'data');
g('checkout', '-B', 'data', 'origin/data');
fs.writeFileSync(other + '/other.txt', 'x');
g('add', '.');
g('commit', '-m', 'other');
g('push', 'origin', 'data');
`);
    const slash = (p) => p.replace(/\\/g, '/');
    const hook = path.join(w.work, '.git', 'hooks', 'pre-push');
    fs.writeFileSync(hook, `#!/bin/sh\n"${slash(process.execPath)}" "${slash(inject)}" "${slash(other)}" "${slash(marker)}"\nexit 0\n`, { mode: 0o755 });

    w.S.info.worknum = 9;
    const r = await w.run(T0 + 15 * MIN);
    assert.equal(r.code, 0, r.stdout);
    assert.ok(fs.existsSync(marker), 'the competing push really happened');
    assert.match(r.stdout, /pushed/);
    assert.ok(w.files().includes('other.txt'), 'other commit kept');
    assert.equal(w.lines().length, 2, 'our line landed');
    assert.equal(w.status().devices[w.dk].pt, T0 + 15 * MIN);
    assert.equal(w.commits(), 3);
    assert.equal(git(['-C', w.bare, 'rev-list', '--merges', '--count', 'data']).trim(), '0');
  });
});

test('a push that keeps failing exits 1', async () => {
  await scenario(async (w) => {
    await w.run(T0);
    fs.writeFileSync(path.join(w.work, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    w.S.info.worknum = 8;
    const r = await w.run(T0 + 15 * MIN);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /push failed/);
    assert.equal(w.lines().length, 1, 'nothing reached the remote');
  });
});

test('keepalive PUT happens once per 30 days and records only the HTTP status', async () => {
  await scenario(async (w) => {
    await w.run(T0);
    assert.equal(w.gh.calls.length, 1);
    assert.deepEqual(w.gh.calls[0], { method: 'PUT', path: '/repos/o/r/actions/workflows/collect.yml/enable', auth: 'Bearer ' + GH_TOKEN });
    assert.deepEqual(w.status().keepalive, { t: T0, status: 204 });
    await w.run(T0 + 15 * MIN);
    await w.run(T0 + 29 * DAY);
    assert.equal(w.gh.calls.length, 1);
    await w.run(T0 + 30 * DAY + MIN);
    assert.equal(w.gh.calls.length, 2);
    assert.equal(w.status().keepalive.t, T0 + 30 * DAY + MIN);
  });
});

test('no keepalive without GITHUB_TOKEN', async () => {
  await scenario(async (w) => {
    await w.run(T0, { GITHUB_TOKEN: undefined });
    assert.equal(w.gh.calls.length, 0);
    assert.equal(w.status().keepalive, undefined);
  });
});

test('insights: fields, homeFields, rubbishSeen, small (identifiers and firmware excluded), logins', async () => {
  await scenario(async (w) => {
    await w.run(T0);
    w.S.info.rubbish = 2;
    w.S.info.mystery_key = 'text';
    w.S.info[DEV_ID] = 5; // a key that holds an identifier must be dropped
    await w.run(T0 + 15 * MIN);
    const ins = w.status().insights;
    assert.deepEqual(ins.fields, [...ins.fields].sort());
    for (const k of ['isonline', 'worknum', 'lastworknum', 'rubbish', 'manualmode', 'volume', 'mystery_key']) assert.ok(ins.fields.includes(k), k);
    assert.ok(!ins.fields.includes(DEV_ID));
    assert.deepEqual(ins.homeFields, ['devicelist', 'homename']);
    assert.deepEqual(ins.rubbishSeen, [0, 2]);
    assert.deepEqual(ins.small, { delay: 30, isonline: 1, manualmode: 0, rubbish: 2, volume: 5, worknum: 3 });
    for (const k of ['mac', 'ssid', 'firmware', 'fw_ver', 'lastworknum', 'mystery_key']) assert.ok(!(k in ins.small), `${k} excluded`);
    assert.deepEqual(ins.logins, { '2026-09-21': 2 });
    assert.equal(ins.loginOk, true);
    assert.equal(ins.cacheUsed, false);
  });
});

test('logins insight keeps only the last 14 UTC days', async () => {
  await scenario(async (w) => {
    await w.run(T0);
    await w.run(T0 + 13 * DAY);
    assert.equal(Object.keys(w.status().insights.logins).length, 2);
    await w.run(T0 + 14 * DAY);
    assert.deepEqual(Object.keys(w.status().insights.logins), ['2026-10-04', '2026-10-05']);
  });
});

test('privacy: no credential, token, identifier or device name reaches stdout, stderr or the data branch', async () => {
  await scenario(async (w) => {
    const sentinel = { PASS: PASSWORD, MD5, EMAIL, DEV_ID, HOME_ID, USER_ID, DEV_NAME, GH_TOKEN, CACHE_KEY };
    const env = { POPUR_CACHE_KEY: CACHE_KEY };
    await w.run(T0, env);
    w.S.info.rubbish = 2;
    await w.run(T0 + 15 * MIN, env);
    await w.run(T0 + 30 * MIN, env);
    w.S.valid.clear();
    w.S.info.worknum = 5;
    await w.run(T0 + 45 * MIN, env); // 401 -> re-login
    w.S.failLogin = true;
    w.S.valid.clear();
    await w.run(T0 + 60 * MIN, env); // login failure
    w.S.failLogin = false;
    await w.run(T0 + 75 * MIN, { POPUR_PASSWORD: undefined, POPUR_PASSWORD_MD5: MD5 });
    await w.run(T0 + 90 * MIN, { POPUR_EMAIL: undefined, POPUR_PASSWORD: undefined }); // setup path

    // masks were announced for every secret
    const allStdout = w.outputs.map((o) => o.stdout).join('\n');
    const masked = new Set(allStdout.split('\n').filter((l) => l.startsWith('::add-mask::')).map((l) => l.slice('::add-mask::'.length)));
    for (const v of [EMAIL, PASSWORD, MD5, GH_TOKEN, CACHE_KEY, USER_ID, HOME_ID, DEV_ID, ...w.S.issued]) {
      assert.ok(masked.has(v), 'masked: ' + v.slice(0, 6));
    }

    // everything except the add-mask lines (which are meant for the Actions runner) must be clean
    const visible = w.outputs.map((o) => withoutMasks(o.stdout) + '\n' + o.stderr).join('\n');
    const branch = [
      git(['-C', w.bare, 'log', 'data', '--format=%H%n%an%n%ae%n%cn%n%ce%n%s%n%b', '-p']),
      ...w.files().map((f) => f + '\n' + w.show(f)),
    ].join('\n');
    const needles = { ...sentinel };
    w.S.issued.forEach((t, i) => { needles['token' + i] = t; });
    for (const [name, v] of Object.entries(needles)) {
      assert.ok(!visible.includes(v), `${name} found in stdout/stderr`);
      assert.ok(!branch.includes(v), `${name} found on the data branch`);
    }
    assert.ok(w.S.issued.length >= 3);
    assert.ok(branch.length > 500, 'the grep had something to look at');
  });
});

// ------------------------------------------------------------------ laptop tools (offline)
// The tools live in tools/ with their own node_modules (libsodium-wrappers); skip if not installed.

const toolsReady = fs.existsSync(path.join(ROOT, 'tools', 'node_modules', 'libsodium-wrappers'));
const toolOpts = { skip: toolsReady ? false : 'run npm install in tools/ first' };

async function toolsWorld() {
  const { createRequire } = await import('node:module');
  const sodium = createRequire(path.join(ROOT, 'tools', 'package.json'))('libsodium-wrappers');
  await sodium.ready;
  const gh = await import('../tools/gh.mjs');
  const handoff = await import('../tools/receive-handoff.mjs');
  const { makeSetupCode } = await import('../docs/lib/handoff.js');

  const rsa = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const dir = path.join(TMP, `tools${++counter}`);
  fs.mkdirSync(dir, { recursive: true });
  const keyPath = path.join(dir, 'temp-handoff.pem');
  fs.writeFileSync(keyPath, rsa.privateKey);
  const spkiB64 = rsa.publicKey.toString('base64');

  // mock GitHub: records secrets (opened with the repo keypair) and dispatches
  const kp = sodium.crypto_box_keypair();
  const pubB64 = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const state = { existing: [], secrets: {}, dispatches: [], auths: new Set() };
  const { srv, url } = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      state.auths.add(req.headers.authorization);
      const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(o ? JSON.stringify(o) : ''); };
      if (req.method === 'GET' && req.url.startsWith('/repos/o/r/actions/secrets/public-key')) return send(200, { key_id: 'k1', key: pubB64 });
      if (req.method === 'GET' && req.url.startsWith('/repos/o/r/actions/secrets')) return send(200, { secrets: state.existing.map((name) => ({ name })) });
      const put = req.url.match(/^\/repos\/o\/r\/actions\/secrets\/([A-Z0-9_]+)$/);
      if (req.method === 'PUT' && put) {
        const b = JSON.parse(body);
        const sealed = sodium.from_base64(b.encrypted_value, sodium.base64_variants.ORIGINAL);
        state.secrets[put[1]] = sodium.to_string(sodium.crypto_box_seal_open(sealed, kp.publicKey, kp.privateKey));
        return send(b.key_id === 'k1' ? 201 : 422, { message: 'key_id' });
      }
      if (req.method === 'POST' && req.url === '/repos/o/r/actions/workflows/collect.yml/dispatches') {
        state.dispatches.push(JSON.parse(body));
        return send(204);
      }
      return send(404, { message: 'nope' });
    });
  });
  return { sodium, gh, handoff, makeSetupCode, keyPath, spkiB64, state, kp, apiBase: url, dir, close: () => srv.close() };
}

test('tools: sealed box round-trips (crypto_box_seal_open recovers the value)', toolOpts, async () => {
  const t = await toolsWorld();
  try {
    const b64 = t.sodium.to_base64(t.kp.publicKey, t.sodium.base64_variants.ORIGINAL);
    const sealed = await t.gh.sealBox(b64, 'secret-value-123');
    const opened = t.sodium.crypto_box_seal_open(t.sodium.from_base64(sealed, t.sodium.base64_variants.ORIGINAL), t.kp.publicKey, t.kp.privateKey);
    assert.equal(t.sodium.to_string(opened), 'secret-value-123');
  } finally { t.close(); }
});

test('tools: receive-handoff --dry-run decrypts and prints only field names and a masked email', toolOpts, async () => {
  const t = await toolsWorld();
  try {
    const now = Math.floor(Date.now() / 1000);
    const code = await t.makeSetupCode(EMAIL, MD5, t.spkiB64, now);
    const r = await new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'tools', 'receive-handoff.mjs'), code, '--dry-run'], {
        env: { ...process.env, HANDOFF_KEY_PATH: t.keyPath },
      });
      let out = '';
      p.stdout.on('data', (c) => { out += c; });
      p.stderr.on('data', (c) => { out += c; });
      p.on('close', (status) => resolve({ status, out }));
    });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /fields: v, e, h, t/);
    assert.ok(r.out.includes('c•••@example.com'), 'masked email');
    assert.ok(!r.out.includes(EMAIL) && !r.out.includes(MD5));
  } finally { t.close(); }
});

test('tools: receive-handoff sets the secrets (sealed), a cache key only if missing, then dispatches', toolOpts, async () => {
  const t = await toolsWorld();
  try {
    const now = Math.floor(Date.now() / 1000);
    const code = await t.makeSetupCode(EMAIL, MD5, t.spkiB64, now);
    const logs = [];
    const base = { repo: 'o/r', keyPath: t.keyPath, token: 'ghp_fake_token_zzz', apiBase: t.apiBase, log: (s) => logs.push(s) };

    const r1 = await t.handoff.receiveHandoff(code, base);
    assert.deepEqual(r1.set, ['POPUR_EMAIL', 'POPUR_PASSWORD_MD5', 'POPUR_CACHE_KEY']);
    assert.equal(t.state.secrets.POPUR_EMAIL, EMAIL);
    assert.equal(t.state.secrets.POPUR_PASSWORD_MD5, MD5);
    assert.match(t.state.secrets.POPUR_CACHE_KEY, /^[0-9a-f]{64}$/);
    assert.deepEqual(t.state.dispatches, [{ ref: 'main' }]);
    assert.deepEqual([...t.state.auths], ['Bearer ghp_fake_token_zzz']);

    // second hand-off: the cache key already exists, so it is kept
    const firstKey = t.state.secrets.POPUR_CACHE_KEY;
    t.state.existing = ['POPUR_EMAIL', 'POPUR_PASSWORD_MD5', 'POPUR_CACHE_KEY'];
    const r2 = await t.handoff.receiveHandoff(code, base);
    assert.deepEqual(r2.set, ['POPUR_EMAIL', 'POPUR_PASSWORD_MD5']);
    assert.equal(t.state.secrets.POPUR_CACHE_KEY, firstKey);
    assert.equal(t.state.dispatches.length, 2);

    const printed = logs.join('\n');
    for (const v of [EMAIL, MD5, firstKey, 'ghp_fake_token_zzz']) assert.ok(!printed.includes(v), 'value printed');
    assert.match(printed, /POPUR_EMAIL: HTTP 201/);
  } finally { t.close(); }
});

test('tools: receive-handoff rejects old, foreign-key and malformed codes', toolOpts, async () => {
  const t = await toolsWorld();
  try {
    const now = Math.floor(Date.now() / 1000);
    const opts = { repo: 'o/r', keyPath: t.keyPath, token: 'x', apiBase: t.apiBase, dryRun: true, log: () => {} };
    const old = await t.makeSetupCode(EMAIL, MD5, t.spkiB64, now - 8 * 86400);
    await assert.rejects(t.handoff.receiveHandoff(old, opts), /older than 7 days/);
    const fresh = await t.makeSetupCode(EMAIL, MD5, t.spkiB64, now);
    const otherKey = path.join(t.dir, 'other.pem');
    fs.writeFileSync(otherKey, crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey);
    await assert.rejects(t.handoff.receiveHandoff(fresh, { ...opts, keyPath: otherKey }), /could not decrypt/);
    await assert.rejects(t.handoff.receiveHandoff('hello', opts), /not a POPUR1/);
    await assert.rejects(t.handoff.receiveHandoff('POPUR1.!!!', opts), /malformed/);
    const badHash = await t.makeSetupCode(EMAIL, 'nothex', t.spkiB64, now);
    await assert.rejects(t.handoff.receiveHandoff(badHash, opts), /valid hash/);
    assert.equal(t.state.dispatches.length, 0);
  } finally { t.close(); }
});

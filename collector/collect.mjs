// Popur history collector. Runs in GitHub Actions every ~15 min, appends changes to the public
// orphan "data" branch. Everything written there is public: counts and timestamps only.
// stdout carries step names, HTTP codes and counts, never bodies, URLs, identifiers or stacks.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeInfo, parseDevices, SENSITIVE_KEY_RE } from '../docs/lib/normalize.js';
import { deviceKey } from '../docs/lib/privacy.js';
import { prepareStore, commitAll, pushStore } from './git.mjs';
import { isValidCacheKey, loadSession, saveSession } from './tokencache.mjs';

const POPUR_UA = 'com.cloudapp.popur.app';
const HTTP_TIMEOUT_MS = 15000;
const GAP_S = 2 * 3600;
const KEEPALIVE_LINE_S = 6 * 3600;
const KEEPALIVE_ENABLE_S = 30 * 86400;
const DAY_S = 86400;
// Extra keys never exposed through insights.small, on top of SENSITIVE_KEY_RE.
const SMALL_EXTRA_RE = /firm|fw|ota|upgrade|update|build/i;
const KEY_NAME_RE = /^[A-Za-z0-9_]{1,40}$/;

class CollectError extends Error {
  constructor(kind, code = null) {
    super(kind);
    this.name = 'CollectError';
    this.kind = kind; // setup | login | network | http | shape | auth (internal) | privacy
    this.code = code === null || code === undefined ? null : String(code);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- output / masking

function writeLine(s) {
  try { fs.writeSync(1, s + '\n'); } catch { process.stdout.write(s + '\n'); }
}
const say = (s) => writeLine(s);

const secretValues = new Set();
function mask(v) {
  if (v === undefined || v === null) return;
  const s = String(v);
  if (!s || secretValues.has(s)) return;
  secretValues.add(s);
  writeLine('::add-mask::' + s); // synchronous, so it is emitted before any request that uses the value
}

// Defence in depth: refuse to write any file whose text contains a known secret value.
function assertClean(text) {
  for (const s of secretValues) {
    if (s.length < 6) continue;
    // digits-only values (could be a timestamp fragment) are matched only as a JSON string
    const needle = /^\d+$/.test(s) ? '"' + s + '"' : s;
    if (text.includes(needle)) throw new CollectError('privacy');
  }
}

// ---------------------------------------------------------------- env

function readEnv() {
  const e = process.env;
  const val = (k) => (e[k] ? String(e[k]).trim() : '');
  const now = /^\d+$/.test(val('COLLECT_NOW')) ? Number(val('COLLECT_NOW')) : Math.floor(Date.now() / 1000);
  const retry = /^\d+$/.test(val('COLLECT_RETRY_MS')) ? Number(val('COLLECT_RETRY_MS')) : 5000;
  return {
    email: val('POPUR_EMAIL'),
    password: e.POPUR_PASSWORD || '',
    md5: val('POPUR_PASSWORD_MD5').toLowerCase(),
    cacheKey: val('POPUR_CACHE_KEY'),
    ghToken: val('GITHUB_TOKEN'),
    repo: val('GITHUB_REPOSITORY'),
    popurApi: (val('POPUR_API') || 'https://cloud.popur.com.cn').replace(/\/+$/, ''),
    ghApi: (val('GITHUB_API') || 'https://api.github.com').replace(/\/+$/, ''),
    store: val('COLLECT_STORE') || 'store',
    remote: val('COLLECT_REMOTE') || 'origin',
    now,
    retryMs: retry,
  };
}

// ---------------------------------------------------------------- HTTP

async function httpJson(url, init, retryMs) {
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      break;
    } catch {
      if (attempt === 0) await sleep(retryMs);
    }
  }
  if (!res) throw new CollectError('network');
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body };
}

const bodyCode = (body) => (body && typeof body === 'object' && body.code !== undefined ? body.code : null);

async function popurLogin(cfg, ctx) {
  say('step: login');
  ctx.logins += 1;
  const { status, body } = await httpJson(cfg.popurApi + '/uapi/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': POPUR_UA },
    body: JSON.stringify({ param: cfg.email, password: ctx.md5, type: '2' }),
  }, cfg.retryMs);
  say(`login: HTTP ${status}`);
  const code = bodyCode(body);
  if (status === 403) throw new CollectError('network', 403);
  if (status >= 500) throw new CollectError('http', status);
  if (code !== 200) {
    if (code === null && status >= 400) throw new CollectError('http', status);
    ctx.loginOk = false;
    throw new CollectError('login', code ?? status);
  }
  const d = body && body.data;
  if (!d || typeof d.token !== 'string' || !d.token || !d.user) throw new CollectError('shape', code);
  ctx.loginOk = true;
  const sess = { token: d.token, homeId: d.user.defaulthomeid ? String(d.user.defaulthomeid) : '' };
  mask(sess.token);
  mask(sess.homeId);
  mask(d.user._id);
  if (!sess.homeId) throw new CollectError('shape', code);
  return sess;
}

// Authenticated GET; returns body.data. kind 'auth' means "log in again".
async function popurGet(cfg, sess, apiPath, label) {
  const { status, body } = await httpJson(cfg.popurApi + apiPath, {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + sess.token, 'User-Agent': POPUR_UA },
  }, cfg.retryMs);
  say(`${label}: HTTP ${status}`);
  const code = bodyCode(body);
  if (status === 403) throw new CollectError('network', 403);
  if (status >= 500) throw new CollectError('http', status);
  if (status === 401 || code === 401 || code === 20001 || (code !== null && code !== 200)) {
    throw new CollectError('auth', code ?? status);
  }
  if (status >= 400) throw new CollectError('http', status);
  if (!body || body.data === undefined || body.data === null) throw new CollectError('shape', code);
  return body.data;
}

// ---------------------------------------------------------------- status model

function emptyInsights() {
  return { fields: [], homeFields: [], rubbishSeen: [], small: {}, logins: {}, loginOk: null, cacheUsed: false };
}

function freshStatus(now) {
  return {
    v: 1,
    src: 'gha',
    since: now,
    run: { t: now, ok: null, n: 0, fails: 0, err: null },
    devices: {},
    insights: emptyInsights(),
  };
}

function loadStatus(store) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(store, 'status', 'gha.json'), 'utf8'));
    if (s && s.v === 1 && s.run && s.devices) {
      s.insights = { ...emptyInsights(), ...(s.insights || {}) };
      return s;
    }
  } catch { /* missing or corrupt: start fresh */ }
  return null;
}

function writeText(store, rel, text, append = false) {
  assertClean(text);
  const file = path.join(store, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (append) fs.appendFileSync(file, text);
  else fs.writeFileSync(file, text);
}

const utcDay = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const utcMonth = (t) => new Date(t * 1000).toISOString().slice(0, 7);
const holdsSecret = (k) => [...secretValues].some((s) => s.length >= 6 && k.includes(s));
const cleanKeys = (obj) =>
  Object.keys(obj && typeof obj === 'object' ? obj : {}).filter((k) => KEY_NAME_RE.test(k) && !holdsSecret(k));
const mergeSorted = (a, b, cap) => [...new Set([...(a || []), ...b])].sort().slice(0, cap);

// ---------------------------------------------------------------- per-device logic

// Pure: advances one device's state with a new reading. Returns { dev, line } where line is the
// history line to append, or null.
export function stepDevice(dev, reading, t) {
  const prev = dev || { pt: null, last: null, binPending: 0, binFullSince: null };
  const prevBf = prev.last && prev.last.bf ? 1 : 0;
  let binPending = prev.binPending || 0;
  let bf;
  if (reading.r === 2) {
    binPending += 1;
    bf = binPending >= 2 || prevBf === 1 ? 1 : 0; // 2 consecutive polls to set; stays set until r != 2
  } else if (reading.r === null) {
    bf = prevBf; // no information: keep state
  } else {
    binPending = 0;
    bf = 0;
  }
  const binFullSince = bf ? (prevBf && prev.binFullSince ? prev.binFullSince : t) : null;

  const line = { t, pv: prev.pt, w: reading.w, lw: reading.lw, r: reading.r, bf, on: reading.on, m: reading.m };
  const last = prev.last;
  const changed = !!last && ['w', 'lw', 'r', 'bf', 'on', 'm'].some((k) => last[k] !== line[k]);
  const gap = prev.pt !== null && t - prev.pt > GAP_S;
  const keepalive = !!last && t - last.t >= KEEPALIVE_LINE_S;
  const append = !last || changed || gap || keepalive;

  return {
    dev: { pt: t, last: append ? line : last, binPending, binFullSince },
    line: append ? line : null,
  };
}

function smallInts(data, into) {
  for (const [k, v] of Object.entries(data && typeof data === 'object' ? data : {})) {
    if (!KEY_NAME_RE.test(k) || SENSITIVE_KEY_RE.test(k) || SMALL_EXTRA_RE.test(k) || holdsSecret(k)) continue;
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,3}$/.test(v) ? Number(v) : NaN;
    if (Number.isInteger(n) && n >= 0 && n <= 999) into[k] = n;
  }
}

// ---------------------------------------------------------------- data fetch

async function fetchAll(cfg, ctx, store) {
  const attempt = async (sess) => {
    const home = await popurGet(cfg, sess, '/uapi/home_details/' + encodeURIComponent(sess.homeId), 'home_details');
    const devices = parseDevices(home);
    for (const d of devices) mask(d.devid);
    const infos = [];
    let err = devices.length ? null : new CollectError('shape');
    for (const d of devices) {
      try {
        const raw = await popurGet(cfg, sess, '/uapi/deviceinfo/info/' + encodeURIComponent(d.devid), 'deviceinfo');
        infos.push({ devid: d.devid, raw });
      } catch (e) {
        if (e.kind === 'auth') throw e;
        err = err || e; // keep what parsed so far
      }
    }
    return { home, infos, err };
  };

  let sess = null;
  let cached = false;
  if (isValidCacheKey(cfg.cacheKey)) {
    const c = loadSession(store, cfg.cacheKey);
    if (c) {
      sess = { token: c.token, homeId: String(c.homeId || '') };
      cached = !!sess.homeId;
      if (cached) { mask(sess.token); mask(sess.homeId); }
      else sess = null;
    }
    say(cached ? 'cache: found' : 'cache: none');
  }
  const relabel = (e) => (e.kind === 'auth' ? new CollectError('login', e.code) : e);
  const loginAndSave = async () => {
    const s = await popurLogin(cfg, ctx);
    if (isValidCacheKey(cfg.cacheKey)) {
      saveSession(store, cfg.cacheKey, { token: s.token, homeId: s.homeId, t: cfg.now });
      say('cache: saved');
    }
    return s;
  };

  if (!sess) sess = await loginAndSave();
  try {
    const r = await attempt(sess);
    ctx.cacheUsed = cached;
    return r;
  } catch (e) {
    if (!(cached && e.kind === 'auth')) throw relabel(e);
  }
  say('cache: token rejected');
  sess = await loginAndSave();
  try { return await attempt(sess); } catch (e) { throw relabel(e); }
}

// ---------------------------------------------------------------- keepalive

async function maybeKeepalive(cfg, status) {
  const k = status.keepalive;
  if (!cfg.ghToken || !cfg.repo) return false;
  if (k && typeof k.t === 'number' && cfg.now - k.t < KEEPALIVE_ENABLE_S) return false;
  say('step: keepalive');
  let code = 0;
  try {
    const res = await fetch(`${cfg.ghApi}/repos/${cfg.repo}/actions/workflows/collect.yml/enable`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + cfg.ghToken,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'popur-control-collector',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    code = res.status;
  } catch { /* ignore, status stays 0 */ }
  say(`keepalive: HTTP ${code}`);
  status.keepalive = { t: cfg.now, status: code };
  return true;
}

// ---------------------------------------------------------------- README for the data branch

const DATA_README = `# Popur Control data branch

This branch is written automatically by the "Collect litter box history" workflow, about every 15 minutes.
It is public. It holds counts and timestamps only.

- \`status/gha.json\`: when the collector last ran, whether it worked, and the latest reading per box.
- \`history/<box key>/<YYYY-MM>.ndjson\`: one line each time something changed (clean counter, bin state, online, auto-clean paused), plus occasional keep-alive lines.
- \`session/gha.bin\`: an encrypted login session. Unreadable without a secret key that is not in this repository.

Boxes are named by a short one-way key. No email, password, device id, home id, device name or location is stored here.
Times are Unix seconds (UTC). Counts are approximate: the collector looks at the box every ~15 minutes.
`;

// ---------------------------------------------------------------- main

function prepareLogin(cfg) {
  let md5 = cfg.md5;
  if (!md5 && cfg.password) md5 = crypto.createHash('md5').update(cfg.password).digest('hex');
  return md5;
}

// Exit 1 when fails reaches 8 (~2 h), then on every 96th failure (~daily) so GitHub's failure email works as an alert.
export function shouldFailExit(fails) {
  return fails === 8 || (fails > 8 && (fails - 8) % 96 === 0);
}

async function run() {
  const cfg = readEnv();
  const ctx = { logins: 0, loginOk: null, cacheUsed: false, md5: '' };
  [cfg.email, cfg.password, cfg.md5, cfg.ghToken, cfg.cacheKey].forEach(mask);
  ctx.md5 = prepareLogin(cfg);
  mask(ctx.md5);

  say('step: prepare data branch');
  prepareStore({ store: cfg.store, remote: cfg.remote });
  const store = cfg.store;
  if (!fs.existsSync(path.join(store, 'README.md'))) writeText(store, 'README.md', DATA_README);

  const prior = loadStatus(store);
  const status = prior || freshStatus(cfg.now);
  const missing = !cfg.email || !ctx.md5;
  let exitCode = 0;
  let appended = 0;

  if (missing) {
    say('setup: credentials missing');
    const alreadySetup = prior && prior.run.err && prior.run.err.kind === 'setup';
    if (!alreadySetup) {
      status.run = { ...status.run, t: cfg.now, n: (status.run.n || 0) + 1, err: { t: cfg.now, kind: 'setup' } };
    }
    await maybeKeepalive(cfg, status);
  } else {
    const ins = status.insights;
    let result = null;
    let failure = null;
    try {
      result = await fetchAll(cfg, ctx, store);
      failure = result.err;
    } catch (e) {
      failure = e instanceof CollectError ? e : new CollectError('http');
      if (failure.kind === 'privacy') throw failure;
    }

    status.run.n = (status.run.n || 0) + 1;
    status.run.t = cfg.now;
    const logins = { ...ins.logins };
    if (ctx.logins) logins[utcDay(cfg.now)] = (logins[utcDay(cfg.now)] || 0) + ctx.logins;
    const cutoff = utcDay(cfg.now - 13 * DAY_S);
    ins.logins = Object.fromEntries(Object.entries(logins).filter(([d]) => d >= cutoff).sort());
    ins.cacheUsed = ctx.cacheUsed;
    if (ctx.loginOk !== null) ins.loginOk = ctx.loginOk;
    else if (result) ins.loginOk = true; // the cached token still works

    if (result) {
      ins.homeFields = mergeSorted(ins.homeFields, cleanKeys(result.home), 60);
      const small = { ...ins.small };
      const fields = [];
      const rubbish = [];
      for (const { devid, raw } of result.infos) {
        const dk = await deviceKey(cfg.email, devid);
        const reading = normalizeInfo(raw);
        const step = stepDevice(status.devices[dk], reading, cfg.now);
        status.devices[dk] = step.dev;
        if (step.line) {
          writeText(store, `history/${dk}/${utcMonth(step.line.t)}.ndjson`, JSON.stringify(step.line) + '\n', true);
          appended += 1;
        }
        fields.push(...cleanKeys(raw));
        if (reading.r !== null) rubbish.push(reading.r);
        smallInts(raw, small);
      }
      ins.fields = mergeSorted(ins.fields, fields, 80);
      ins.rubbishSeen = [...new Set([...(ins.rubbishSeen || []), ...rubbish])].sort((a, b) => a - b).slice(0, 20);
      ins.small = Object.fromEntries(Object.entries(small).sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, 60));
    }

    if (failure) {
      status.run.fails = (status.run.fails || 0) + 1;
      status.run.err = { t: cfg.now, kind: failure.kind, ...(failure.code ? { code: failure.code } : {}) };
      say(`run failed: ${failure.kind}${failure.code ? ' ' + failure.code : ''} (fails=${status.run.fails})`);
      if (shouldFailExit(status.run.fails)) exitCode = 1;
    } else {
      if (status.run.ok === null || status.run.ok === undefined) status.since = cfg.now;
      status.run.ok = cfg.now;
      status.run.fails = 0;
      status.run.err = null;
    }
    await maybeKeepalive(cfg, status);
  }

  say(`appended ${appended} lines`);
  writeText(store, 'status/gha.json', JSON.stringify(status, null, 1) + '\n'); // git decides if it changed

  const stamp = new Date(cfg.now * 1000).toISOString().slice(0, 16) + 'Z';
  if (commitAll({ store, message: `collect ${stamp}` })) {
    say('committed');
    const ok = await pushStore({ store, remote: cfg.remote, delayMs: cfg.retryMs });
    say(ok ? 'pushed' : 'push failed');
    if (!ok) exitCode = 1;
  } else {
    say('no changes');
  }
  return exitCode;
}

export async function main() {
  try {
    process.exitCode = await run();
  } catch (e) {
    const kind = e && e.kind ? ` kind=${e.kind}` : '';
    say(`error: ${(e && e.name) || 'Error'}${kind}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();

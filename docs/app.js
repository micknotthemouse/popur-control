// Popur control: single-screen app. Plain ES modules, no third-party code.
// Untrusted data (device names, API fields) is only ever rendered with textContent.
import { applyOverrides } from './lib/config.js';
import { md5Hex } from './lib/md5.js';
import { binState, SENSITIVE_KEY_RE } from './lib/normalize.js';
import { PopurApi } from './lib/api.js';
import { MqttClient, publishOnce, topics, cleanPayload, manualPayload, parseReport } from './lib/mqtt.js';
import { deviceKey, redact, maskEmail } from './lib/privacy.js';
import { makeSetupCode } from './lib/handoff.js';
import * as store from './lib/store.js';
import { loadHistory, loadStatus } from './lib/history.js';
import { derive, todayCount, dailySeries, hourProfile, stats, recentEvents } from './lib/derive.js';
import { renderBars, renderHours } from './lib/charts.js';

const APP_VERSION = '1.0.0';
const FRESH_S = 30 * 60; // a reading older than this is "last known"
const UNKNOWN_S = 6 * 3600; // older than this: "status unknown"
const RELOGIN_MAX_PER_HOUR = 3;
const CONFIRM_MS = 4000;
const HISTORY_MS = 5 * 60 * 1000;
const TOAST_MS = 6000;
const DONE_LINGER_MS = 8000;

// ---------- tiny helpers ----------
const $ = (id) => document.getElementById(id);
const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
const setHidden = (el, hidden) => { if (el.hasAttribute('hidden') !== hidden) el.toggleAttribute('hidden', hidden); };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const pad2 = (n) => String(n).padStart(2, '0');

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const hm = (sec) => new Date(sec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const dayName = (sec) => new Date(sec * 1000).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
function dayKeyOf(sec) {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// "just now", "12 min ago", "2 h ago", "3 d ago"
function ageText(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 45) return 'just now';
  if (s < 90) return '1 min ago';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function shortAge(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return ageText(s);
}

// ---------- icons (inline SVG, 24px grid) ----------
const ICONS = {
  gear: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4.5l8.5 14.5h-17L12 4.5Z"/><path d="M12 10.5v4"/><path d="M12 17v.1"/>',
  cat: '<path d="M5 9.500V4.500l3.500 2.500a8 8 0 0 1 7 0L19 4.500v5a7 7 0 0 1-14 0Z"/><path d="M9.500 11v.01M14.500 11v.01"/>',
  sparkle: '<path d="M12 3.500l1.900 5.100 5.100 1.900-5.100 1.900L12 17.500l-1.900-5.100L5 10.500l5.100-1.900L12 3.500Z"/><path d="M19 3v4M17 5h4"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  play: '<path d="M8 5.500l11 6.500-11 6.500v-13Z"/>',
  power: '<path d="M12 3v8"/><path d="M6.600 6.800a8 8 0 1 0 10.800 0"/>',
  refresh: '<path d="M19.500 12a7.500 7.500 0 1 1-2.200-5.300"/><path d="M19.500 4.500v4.200h-4.200"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>',
  'chevron-left': '<path d="M15 6l-6 6 6 6"/>',
  'chevron-right': '<path d="M9 6l6 6-6 6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  copy: '<rect x="8.500" y="8.500" width="11" height="11" rx="2.500"/><path d="M15.500 8.500V6.500a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  external: '<path d="M14 4.500h5.500V10M19.500 4.500L11 13M17.500 14v4a1.500 1.500 0 0 1-1.500 1.500H6A1.500 1.500 0 0 1 4.500 18V8A1.500 1.500 0 0 1 6 6.500h4"/>',
  user: '<circle cx="12" cy="8.500" r="3.500"/><path d="M5 20c.8-3.600 3.600-5.500 7-5.500s6.200 1.900 7 5.500"/>',
  signout: '<path d="M10 5H6.500A1.500 1.500 0 0 0 5 6.500v11A1.500 1.500 0 0 0 6.500 19H10M15 8l4 4-4 4M19 12H9.500"/>',
  clock: '<circle cx="12" cy="12" r="8.500"/><path d="M12 7.500V12l3 2"/>',
  flag: '<path d="M6 20.500V4.500M6 5h11l-2 4 2 4H6"/>',
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}
function iconSpan(name) {
  const s = h('span', { class: 'ico' });
  s.append(icon(name));
  return s;
}
function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('.ico[data-icon]')) {
    if (!el.firstChild) el.append(icon(el.dataset.icon));
  }
}

// The big bin graphic in the hero. mark: 'check' | 'alert' | 'question' | 'none'
function binSvg(mark) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '3.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const marks = {
    check: '<path d="M24.500 38.500l5.500 5.500 10-11.500"/>',
    alert: '<path d="M32 30v11"/><path d="M32 47.500v.2"/>',
    question: '<path d="M27 33.500a5 5 0 1 1 7.200 4.500c-1.500.8-2.200 1.800-2.200 3.500"/><path d="M32 47.500v.2"/>',
    none: '',
  };
  svg.innerHTML = '<path d="M12 20h40"/><path d="M26 20v-3.500a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2V20"/>' +
    '<path d="M16 20l2.500 30.500a4 4 0 0 0 4 3.500h19a4 4 0 0 0 4-3.500L48 20"/>' + (marks[mark] || '');
  return svg;
}

// ---------- state ----------
const S = {
  cfg: null,
  api: null,
  auth: null, // {email, token, homeId, userId, md5}
  keep: true,
  expired: false,
  evicted: false,
  devices: [],
  devid: null,
  dk: null,
  signedOutDk: null,
  name: null,
  live: null, // {reading, t, raw}
  homeRaw: null,
  pid2: null,
  pendingM: null,
  mqtt: { client: null, state: 'off', failures: 0, connectedAt: 0, timer: null, info: { msgs: 0, suback: null } },
  hist: { status: null, lines: [], notSetUp: false, error: false, loaded: false, derived: null, loadedAt: 0 },
  ui: { range: 7, selectedDay: null, theme: 'system', confirm: false, usageSig: '', heroIcon: '', lastBin: '', lastTone: '' },
  progress: null,
  apiError: null,
  backoffMs: 0,
  online: true,
  loading: true,
  loginBusy: false,
  log: [],
  binSeen: new Set(),
  fieldPrev: null,
  pollTimer: null,
  refreshing: null,
  histBusy: false,
  rechecking: false,
  toastTimer: null,
  confirmTimer: null,
  setupCode: null,
};

const effDk = () => S.dk || S.signedOutDk;

function logLine(kind, text) {
  S.log.push({ t: Date.now(), kind, text: scrub(String(text)) });
  if (S.log.length > 300) S.log.shift();
  if (diagOpen()) scheduleDiagRender();
}

// Strip account identifiers from anything written to the diagnostics log.
function scrub(text) {
  const secrets = [S.auth && S.auth.token, S.auth && S.auth.homeId, S.auth && S.auth.userId, S.devid, S.auth && S.auth.email, S.auth && S.auth.md5];
  let out = text;
  for (const s of secrets) if (s && String(s).length >= 4) out = out.split(String(s)).join('•••');
  return out;
}

// ---------- session and auth ----------
function setApiAuth() {
  S.api.token = S.auth ? S.auth.token : null;
  S.api.homeId = S.auth ? S.auth.homeId : null;
  S.api.userId = S.auth ? S.auth.userId : null;
}

function persistSession() {
  if (!S.auth) return;
  store.set('session', { email: S.auth.email, token: S.auth.token, homeId: S.auth.homeId, userId: S.auth.userId, devid: S.devid });
  store.set('email', S.auth.email);
  if (S.keep && S.auth.md5) store.set('cred', { email: S.auth.email, md5: S.auth.md5 });
  else store.del('cred');
}

async function doLogin(email, md5) {
  const r = await S.api.login(email, md5);
  S.auth = { email, token: r.token, homeId: r.homeId, userId: r.userId, md5 };
  persistSession();
  return r;
}

const relogins = () => (store.get('relogins', []) || []).filter((t) => nowSec() - t < 3600);

// Called when the token stops working. Returns true when a fresh token is in place.
async function silentRelogin() {
  if (!S.auth || !S.auth.md5) { expireSession(); return false; }
  const recent = relogins();
  if (recent.length >= RELOGIN_MAX_PER_HOUR) { setEvicted(); return false; }
  store.set('relogins', recent.concat(nowSec()));
  logLine('rest', 'Signing in again (token no longer accepted)');
  await doLogin(S.auth.email, S.auth.md5);
  setApiAuth();
  restartMqtt();
  return true;
}

async function withAuth(fn) {
  if (!S.api.token) {
    let ok = false;
    try { ok = await silentRelogin(); } catch (e) { if (e && e.kind === 'login') expireSession(true); throw e; }
    if (!ok) throw Object.assign(new Error('auth'), { kind: 'auth' });
  }
  try {
    return await fn();
  } catch (e) {
    if (!e || e.kind !== 'auth') throw e;
    let ok = false;
    try { ok = await silentRelogin(); } catch (e2) { if (e2 && e2.kind === 'login') expireSession(true); throw e2; }
    if (!ok) throw e;
    return fn();
  }
}

function expireSession(badCredentials = false) {
  S.auth = null;
  setApiAuth();
  store.del('session');
  if (badCredentials) store.del('cred');
  S.expired = true;
  stopMqtt();
  clearTimeout(S.pollTimer);
  S.live = null;
  S.pid2 = null;
}

function setEvicted() {
  S.evicted = true;
  stopMqtt();
  clearTimeout(S.pollTimer);
  logLine('rest', 'Stopped signing in again: too many sign-ins in the last hour');
}

function clearAccountData() {
  for (const k of ['session', 'cred', 'cache', 'relogins']) store.del(k);
  S.auth = null; S.devices = []; S.devid = null; S.dk = null; S.name = null; S.live = null; S.homeRaw = null;
  S.pid2 = null; S.progress = null; S.pendingM = null; S.fieldPrev = null; S.binSeen = new Set();
  setApiAuth();
}

// ---------- reading the box (REST) ----------
function refresh(opts = {}) {
  if (S.refreshing) return S.refreshing;
  S.refreshing = doRefresh(opts).catch(() => {}).finally(() => { S.refreshing = null; render(); });
  render();
  return S.refreshing;
}

async function doRefresh({ full = false } = {}) {
  if (!S.auth || S.evicted) return;
  try {
    if (full || !S.devid || !S.devices.length) await loadHome();
    if (!S.devid) { S.apiError = { kind: 'nodevice' }; return; }
    await loadReading();
    S.apiError = null;
    S.backoffMs = 0;
    S.loading = false;
    startMqtt();
  } catch (e) {
    S.loading = false;
    if (e && e.kind === 'auth') return; // expireSession / setEvicted already updated the UI
    S.backoffMs = S.backoffMs ? Math.min(S.backoffMs * 2, 120000) : 30000;
    S.apiError = { kind: (e && e.kind) || 'network', until: Date.now() + S.backoffMs };
    logLine('rest', `Request failed (${(e && e.kind) || 'error'}), retrying in ${Math.round(S.backoffMs / 1000)}s`);
  }
}

async function loadHome() {
  const t0 = Date.now();
  const { devices, raw } = await withAuth(() => S.api.homeDetails());
  logLine('rest', `GET home details ok, ${Date.now() - t0} ms, ${plural(devices.length, 'box', 'boxes')}`);
  S.homeRaw = raw;
  S.devices = devices;
  if (!devices.length) { S.devid = null; return; }
  if (!devices.some((d) => d.devid === S.devid)) S.devid = devices[0].devid;
  S.name = (devices.find((d) => d.devid === S.devid) || {}).name || null;
  await updateDk();
  persistSession();
  persistCache();
}

async function updateDk() {
  const dk = S.auth && S.devid ? await deviceKey(S.auth.email, S.devid) : null;
  if (dk !== S.dk) {
    S.dk = dk;
    if (dk) store.set('lastdk', dk);
    const c = dk ? store.get('hist:' + dk) : null;
    if (c && c.status) setHistory({ status: c.status, lines: c.lines || [], notSetUp: false }, true);
    loadHistoryNow();
  }
}

async function loadReading() {
  const t0 = Date.now();
  const r = await withAuth(() => S.api.deviceInfo(S.devid));
  logLine('rest', `GET box status ok, ${Date.now() - t0} ms`);
  const reading = r.reading;
  if (S.pendingM) {
    if (reading.m === S.pendingM.v) S.pendingM = null;
    else if (Date.now() < S.pendingM.until) reading.m = S.pendingM.v;
    else S.pendingM = null;
  }
  trackFieldChanges(r.raw);
  if (reading.r !== null) S.binSeen.add(reading.r);
  if (S.live && S.live.reading.w !== null && reading.w !== S.live.reading.w) S.wChangedAt = r.t;
  S.live = { reading, t: r.t, raw: r.raw };
  persistCache();
  evalProgress();
}

function persistCache() {
  store.set('cache', {
    devices: S.devices, devid: S.devid, name: S.name,
    live: S.live ? { reading: S.live.reading, t: S.live.t } : null,
  });
}

// Logs which fields changed between two box readings (values of private fields are never logged).
function trackFieldChanges(raw) {
  if (!raw || typeof raw !== 'object') return;
  const prev = S.fieldPrev;
  S.fieldPrev = raw;
  if (!prev) return;
  for (const k of Object.keys(raw)) {
    if (SENSITIVE_KEY_RE.test(k)) continue;
    const a = prev[k], b = raw[k];
    if (a === b || typeof b === 'object') continue;
    logLine('change', `${k}: ${String(a)} -> ${String(b)}`);
  }
}

// ---------- polling ----------
function progressActive() { return !!(S.progress && !S.progress.final); }

function schedulePoll() {
  clearTimeout(S.pollTimer);
  if (document.hidden || !S.auth || S.evicted) return;
  const base = progressActive() ? S.cfg.PROGRESS_POLL_MS : S.cfg.POLL_MS;
  const wait = S.backoffMs ? Math.max(S.backoffMs, 0) : base;
  S.pollTimer = setTimeout(async () => { await refresh(); schedulePoll(); }, wait);
}

// ---------- live updates (MQTT, an enhancement only) ----------
function startMqtt() {
  const m = S.mqtt;
  if (m.client || m.state === 'refused' || m.state === 'gave-up') return;
  if (!S.auth || !S.api.token || !S.devid || document.hidden || S.evicted) return;
  const c = new MqttClient({ url: S.cfg.WSS, token: S.api.token });
  m.client = c;
  m.state = 'connecting';
  c.addEventListener('frame', (e) => {
    const d = e.detail;
    logLine('mqtt', `${d.dir === 'out' ? 'sent' : 'got'} ${d.type}${d.topic ? ' ' + d.topic : ''}`);
  });
  c.addEventListener('message', onMqttMessage);
  c.addEventListener('close', () => onMqttClosed(c));
  c.connect()
    .then(() => c.subscribe(topics.report(S.devid)))
    .then((granted) => {
      m.info.suback = granted;
      if (granted === 0x80) {
        m.state = 'refused';
        logLine('mqtt', 'Live updates refused by the server; using polling only');
        c.close();
        m.client = null;
      } else {
        m.state = 'live';
        m.connectedAt = Date.now();
        m.failures = 0;
        logLine('mqtt', 'Live updates connected');
      }
      render();
    })
    .catch((err) => {
      logLine('mqtt', `Live connection failed (${(err && err.code) || 'error'})`);
      c.close();
      if (m.client === c) m.client = null;
      mqttFailed();
    });
}

function mqttFailed() {
  const m = S.mqtt;
  m.failures += 1;
  if (m.failures >= 3) { m.state = 'gave-up'; render(); return; }
  m.state = 'off';
  clearTimeout(m.timer);
  m.timer = setTimeout(startMqtt, Math.min(30000, 1000 * 2 ** m.failures));
  render();
}

function onMqttClosed(c) {
  const m = S.mqtt;
  if (m.client !== c) return;
  m.client = null;
  S.pid2 = null;
  const quick = Date.now() - m.connectedAt < 5000;
  m.state = 'off';
  if (quick) mqttFailed();
  else { clearTimeout(m.timer); m.timer = setTimeout(startMqtt, 1500); }
  render();
}

function stopMqtt() {
  const m = S.mqtt;
  clearTimeout(m.timer);
  if (m.client) { const c = m.client; m.client = null; try { c.close(); } catch { /* ignore */ } }
  if (m.state === 'live' || m.state === 'connecting') m.state = 'off';
  S.pid2 = null;
}
function restartMqtt() {
  const keep = S.mqtt.state === 'refused' || S.mqtt.state === 'gave-up';
  stopMqtt();
  if (!keep) startMqtt();
}

function onMqttMessage(ev) {
  const { payload } = ev.detail;
  S.mqtt.info.msgs += 1;
  let refreshSoon = false;
  for (const { pid, value } of parseReport(payload)) {
    logLine('mqtt', `report: item ${pid} = ${String(value).slice(0, 12)}`);
    const v = Number(value);
    if (pid === 2) S.pid2 = Number.isFinite(v) ? v : null;
    else if (pid === 6 && Number.isFinite(v)) { patchLive({ r: v }); S.binSeen.add(v); }
    else if (pid === 3) patchLive({ m: String(value) === '1' ? 1 : 0 });
    else if (pid === 8) refreshSoon = true;
  }
  evalProgress();
  render();
  if (refreshSoon) setTimeout(() => refresh(), 400);
}

function patchLive(fields) {
  const base = S.live ? S.live.reading : { w: null, lw: null, r: null, on: 1, m: null };
  S.live = { reading: { ...base, ...fields }, t: nowSec(), raw: S.live ? S.live.raw : null };
  if (fields.m !== undefined) S.pendingM = null;
}

// Publish on the open connection if there is one, otherwise connect, publish, disconnect.
async function publishCommand(topic, payload) {
  const attempt = async () => {
    const c = S.mqtt.client;
    if (c && c.connected) {
      c.publish(topic, payload);
      await sleep(500);
      if (!c.connected) throw { code: 'closed' };
      return;
    }
    await publishOnce({ url: S.cfg.WSS, token: S.api.token }, topic, payload);
  };
  try {
    await attempt();
  } catch (e) {
    // The token may have gone stale: a REST call re-signs in if needed, then try once more.
    await withAuth(() => S.api.deviceInfo(S.devid));
    await attempt();
  }
}

// ---------- start a clean + progress ----------
const STEP_ORDER = ['sending', 'sent', 'cleaning', 'done'];

async function startClean() {
  if (S.progress || !S.devid) return;
  S.progress = {
    step: 'sending', startedAt: Date.now(), baseW: S.live ? S.live.reading.w : null,
    sawClean: false, sent: false, final: false, outcome: null,
  };
  exitConfirm(true);
  render();
  schedulePoll();
  try {
    await publishCommand(topics.action(S.devid), cleanPayload(nowSec()));
    S.progress.sent = true;
    if (S.dk) store.pushCapped('appcleans:' + S.dk, { t: nowSec() }, 100);
    logLine('mqtt', 'Clean command sent');
  } catch (e) {
    finishProgress('error');
  }
  evalProgress();
  render();
}

function finishProgress(outcome) {
  const p = S.progress;
  if (!p || p.final) return;
  p.final = true;
  p.outcome = outcome;
  p.endedAt = Date.now();
  schedulePoll();
}

// Decide what the box has really told us. Never claims "Done" without the box saying so.
function evalProgress() {
  const p = S.progress;
  if (!p || p.final) return;
  const w = S.live ? S.live.reading.w : null;
  const counted = w !== null && p.baseW !== null && w > p.baseW;
  if (S.pid2 === 1) p.sawClean = true;
  const live = S.mqtt.state === 'live';
  if (p.sawClean && S.pid2 !== null && S.pid2 !== 1) { p.step = 'done'; finishProgress('done'); return; }
  if (counted && (!live || !p.sawClean)) { p.step = 'cleaning'; finishProgress('counted'); return; }
  if (p.sawClean || counted) p.step = 'cleaning';
  else if (p.sent) p.step = 'sent';
  if (Date.now() - p.startedAt > S.cfg.PROGRESS_MAX_MS) finishProgress(counted ? 'counted' : p.sawClean ? 'unfinished' : 'timeout');
}

const PROGRESS_COPY = {
  sending: ['Sending…', 'Sending the clean command to your box…', 'ok'],
  sent: ['Sent', 'Sent. Waiting for the box to start.', 'ok'],
  cleaning: ['Cleaning…', 'Cleaning is under way. This takes a couple of minutes.', 'ok'],
  done: ['Done', 'Done. The box says it has finished cleaning.', 'ok'],
  counted: ['Cleaning counted', 'Cleaning counted ✓ – the box finishes on its own.', 'ok'],
  timeout: ["Not confirmed", "Sent, but the box hasn't confirmed. It may still be cleaning – take a look.", 'warn'],
  unfinished: ['Not finished?', "The box started cleaning but hasn't said it finished. It may still be working – take a look.", 'warn'],
  error: ["Couldn't send", "Couldn't send the clean command, so nothing happened. Check your connection and try again.", 'warn'],
};

// ---------- pause auto-cleaning ----------
async function setPaused(on, { fromUndo = false } = {}) {
  if (!S.devid) return;
  const prev = S.live ? S.live.reading.m : null;
  S.pendingM = { v: on ? 1 : 0, until: Date.now() + 8000 };
  patchLive({ m: on ? 1 : 0 });
  S.pendingM = { v: on ? 1 : 0, until: Date.now() + 8000 };
  render();
  try {
    await publishCommand(topics.attr(S.devid), manualPayload(on, nowSec()));
    toast(on ? 'Auto-clean paused' : 'Auto-clean resumed', fromUndo ? null : { label: 'Undo', fn: () => setPaused(!on, { fromUndo: true }) });
    setTimeout(() => refresh(), 2000);
  } catch (e) {
    S.pendingM = null;
    patchLive({ m: prev });
    toast("Couldn't reach the box. Nothing changed.");
    render();
  }
}

// ---------- history ----------
function setHistory({ status, lines, notSetUp }, fromCache = false) {
  S.hist.status = status;
  S.hist.lines = lines;
  S.hist.notSetUp = notSetUp;
  S.hist.error = false;
  S.hist.loaded = true;
  S.hist.derived = derive(lines, { now: nowSec(), lwMode: S.cfg.LW_MODE });
  if (!fromCache) S.hist.loadedAt = Date.now();
}

async function loadHistoryNow() {
  if (S.histBusy) { S.histAgain = true; return; }
  S.histBusy = true;
  try {
    let dk = S.dk;
    let status = null, lines = [], notSetUp = false;
    if (!dk) {
      status = await loadStatus(S.cfg.DATA);
      if (status === null) notSetUp = true;
      else {
        const keys = Object.keys(status.devices || {});
        if (keys.length === 1) dk = keys[0];
      }
      S.signedOutDk = dk || null;
      if (dk) store.set('lastdk', dk);
    }
    if (dk) {
      const res = await loadHistory({ dataBase: S.cfg.DATA, dk, now: Date.now() });
      status = res.status; lines = res.lines; notSetUp = res.notSetUp;
      const cutoff = nowSec() - 45 * 86400;
      store.set('hist:' + dk, { status, lines: lines.filter((l) => l.t >= cutoff) });
    }
    setHistory({ status, lines, notSetUp });
  } catch (e) {
    S.hist.error = true;
    logLine('history', 'Could not load history');
  } finally {
    S.histBusy = false;
    if (!S.auth) S.loading = false;
    render();
    if (S.histAgain) { S.histAgain = false; loadHistoryNow(); }
  }
}

// ---------- view models ----------
function collectorDevice() {
  const st = S.hist.status;
  const k = effDk();
  return st && st.devices && k ? st.devices[k] || null : null;
}

// The freshest bin reading we know of: live REST/MQTT or the collector. Age always comes from the reading's own time.
function pickReading() {
  const c = [];
  if (S.live && S.live.reading && Number.isFinite(S.live.t)) {
    const r = S.live.reading;
    c.push({ src: 'live', r: r.r, on: r.on, m: r.m, t: S.live.t });
  }
  const dev = collectorDevice();
  if (dev && dev.last && Number.isFinite(Number(dev.pt))) {
    const l = dev.last;
    c.push({
      src: 'tracking', r: l.r ?? null, on: l.on ?? null, m: l.m ?? null, t: Number(dev.pt),
      fullSince: dev.binFullSince ? Number(dev.binFullSince) : null,
    });
  }
  c.sort((a, b) => b.t - a.t);
  return c[0] || null;
}

const histSetupNeeded = () => {
  if (!S.hist.loaded) return false;
  const st = S.hist.status;
  return S.hist.notSetUp || !!(st && st.run && st.run.err && st.run.err.kind === 'setup');
};

function trackingInfo(now) {
  if (!S.hist.loaded) return { level: 'loading' };
  if (histSetupNeeded()) return { level: 'setup' };
  const run = (S.hist.status && S.hist.status.run) || {};
  const ok = Number(run.ok) || 0;
  const checked = Number(run.t) || ok;
  const err = run.err && run.err.kind ? run.err : null;
  const base = { ok, checked, run, err };
  if (!ok) return { level: err ? 'problem' : 'on', ...base };
  const age = now - ok;
  if (age > UNKNOWN_S || (run.fails || 0) >= 8) return { level: 'stopped', ...base };
  if (age > 75 * 60) return { level: 'delayed', ...base };
  if (err) return { level: 'problem', ...base };
  return { level: 'on', ...base };
}

function lastCycleT() {
  const own = store.get('appcleans:' + effDk(), []) || [];
  const t1 = own.length ? own[own.length - 1].t : 0;
  const t2 = S.hist.derived ? stats(S.hist.derived, nowSec()).lastVisitT || 0 : 0;
  return Math.max(t1, t2);
}

function heroModel(now) {
  const rd = pickReading();
  if (!rd) {
    if (S.loading && (S.auth || !S.hist.loaded)) return { state: 'loading', mark: 'none' };
    return {
      state: 'none', mark: 'none', title: 'No box to show yet',
      sub: S.auth ? 'Waiting for your box to report in.' : 'Sign in to see your litter box.',
    };
  }
  const bs = binState(rd.r);
  const age = Math.max(0, now - rd.t);
  const ago = ageText(age);
  const offline = rd.on === 0;
  const red = rd.src === 'tracking' && trackingInfo(now).level === 'stopped';
  const srcNote = rd.src === 'tracking' ? `From tracking, ${ago}` : `Checked ${ago}`;

  if (bs === 'unclear') {
    return { state: 'unclear', mark: 'question', title: 'Bin status unclear', sub: "The box didn't send a bin reading.", dim: true };
  }
  if (bs === 'full') {
    if (age <= FRESH_S && !offline && !red) {
      const m = { state: 'full', mark: 'alert', title: 'Bin full – empty it', sub: srcNote };
      if (rd.fullSince) m.sub = `Full since ${hm(rd.fullSince)} · ${srcNote.toLowerCase()}`;
      const cyc = lastCycleT();
      if (cyc && now - cyc < 300) m.note = 'Sensors can misread right after a clean – rechecking';
      return m;
    }
    return {
      state: 'full', stale: true, mark: 'alert', title: `Bin was full · ${ago}`,
      sub: offline ? 'The box is offline – check power or Wi-Fi.' : rd.src === 'tracking' ? 'From tracking. Empty it when you can.' : 'Empty it when you can.',
    };
  }
  if (age > UNKNOWN_S || red) {
    return { state: 'unknown', mark: 'question', title: 'Bin status unknown', sub: `Last reading ${ago}`, dim: true };
  }
  if (offline || age > FRESH_S) {
    const when = age < 60 ? '' : ` · ${ago}`;
    return {
      state: 'stale', mark: 'check', title: `Last known: has room${when}`,
      sub: offline ? 'The box is offline – check power or Wi-Fi.' : rd.src === 'tracking' ? 'From tracking' : '', dim: true,
    };
  }
  return { state: 'ok', mark: 'check', title: 'Bin has room', sub: srcNote };
}

function pillModel() {
  if (!S.auth) return { text: S.evicted ? 'Signed out' : 'Not signed in', tone: 'neutral' };
  const rd = pickReading();
  if (rd && rd.on === 0) return { text: 'Offline', tone: 'neutral' };
  if (S.pid2 === 3) return { text: 'Cat inside', tone: 'accent' };
  if (progressActive() || S.pid2 === 1) return { text: 'Cleaning…', tone: 'accent', pulse: true };
  if (rd && rd.m === 1) return { text: 'Auto-clean paused', tone: 'warn' };
  if (!rd) return { text: 'Connecting…', tone: 'neutral' };
  return { text: 'Ready', tone: 'ok' };
}

function cleanGate() {
  if (S.evicted) return { enabled: false, reason: 'Sign in again to start a clean' };
  if (!S.auth) return { enabled: false, reason: 'Sign in to start a clean' };
  if (!S.online) return { enabled: false, reason: 'Your phone is offline' };
  if (!S.devid) return { enabled: false, reason: S.loading ? 'Loading your box…' : 'No box found yet' };
  const lv = S.live && S.live.reading;
  if (lv && lv.on === 0) return { enabled: false, reason: 'Box is offline – check power or Wi-Fi' };
  if (S.pid2 === 3) return { enabled: false, reason: 'Your cat is inside – wait until they leave' };
  if (S.pid2 === 1) return { enabled: false, reason: 'The box is cleaning right now' };
  const rd = pickReading();
  if (rd && binState(rd.r) === 'full') return { enabled: true, reason: 'Bin is full – cleaning may not finish', tone: 'warn' };
  return { enabled: true };
}

const appCleans = () => store.get('appcleans:' + effDk(), []) || [];

// ---------- rendering: header, banners, global ----------
function renderGlobal() {
  const rd = pickReading();
  const full = !!rd && binState(rd.r) === 'full';
  document.body.dataset.bin = full ? 'full' : 'ok';
  const title = full ? 'Bin full · Popur' : 'Popur';
  if (document.title !== title) document.title = title;

  const dark = S.ui.theme === 'dark' || (S.ui.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const color = full ? (dark ? '#7F1D1D' : '#B91C1C') : (dark ? '#0B0D10' : '#F5F6F8');
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) if (m.content !== color) m.content = color;

  if (full !== (S.ui.lastBin === 'full')) {
    S.ui.lastBin = full ? 'full' : 'ok';
    try {
      if (full && navigator.setAppBadge) navigator.setAppBadge(1).catch(() => {});
      else if (!full && navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
    } catch { /* badge is optional */ }
  }
  setHidden($('offline-banner'), S.online);
}

function renderHeader() {
  const now = nowSec();
  setText($('box-name'), S.name || (S.auth ? 'Litter box' : 'Popur'));
  setHidden($('device-btn'), S.devices.length < 2);

  const p = pillModel();
  const pill = $('status-pill');
  if (pill.dataset.tone !== p.tone) pill.dataset.tone = p.tone;
  pill.dataset.pulse = p.pulse ? '1' : '0';
  setText($('status-text'), p.text);
  setHidden($('live-dot'), S.mqtt.state !== 'live');

  let label;
  if (S.refreshing) label = 'Updating…';
  else if (S.auth) label = S.live ? `Updated ${shortAge(now - S.live.t)}` : 'Tap to refresh';
  else {
    const run = S.hist.status && S.hist.status.run;
    label = run && run.t ? `Tracking checked ${shortAge(now - run.t)}` : 'Tap to refresh';
  }
  setText($('updated-btn'), label);

  const banner = $('api-banner');
  const show = !!S.apiError && !!S.auth && !S.evicted;
  setHidden(banner, !show);
  if (show) {
    const secs = Math.max(1, Math.round((S.apiError.until - Date.now()) / 1000));
    setText($('api-banner-text'), S.apiError.kind === 'nodevice' ? 'No litter box found on this account.' : `Can't reach Popur – retrying in ${secs} s`);
  }
}

function renderLogin() {
  const showLogin = !S.auth && !S.evicted;
  setHidden($('login-card'), !showLogin);
  setHidden($('evicted-card'), !S.evicted);
  setText($('login-lead'), S.expired ? 'Your session ended. Please sign in again.' : 'Use the same email and password as the Popur app.');
  const em = $('login-email');
  if (!em.value && !em.dataset.touched) em.value = store.get('email', '') || '';
  $('login-submit').disabled = S.loginBusy;
  setText($('login-submit'), S.loginBusy ? 'Signing in…' : 'Sign in');
}

// ---------- rendering: hero ----------
function renderHero() {
  const now = nowSec();
  const m = heroModel(now);
  const el = $('bin-hero');
  if (el.dataset.state !== m.state) el.dataset.state = m.state;
  el.classList.toggle('is-stale', !!m.stale);
  el.dataset.dim = m.dim ? '1' : '0';
  const key = `${m.state}:${m.mark}`;
  if (S.ui.heroIcon !== key) {
    S.ui.heroIcon = key;
    const box = $('hero-icon');
    box.replaceChildren(binSvg(m.mark));
  }
  setText($('hero-title'), m.title || (m.state === 'loading' ? 'Checking the bin' : ''));
  setText($('hero-sub'), m.sub || '');
  setHidden($('hero-sub'), !m.sub);
  setText($('hero-note'), m.note || '');
  setHidden($('hero-note'), !m.note);
  if (m.note && !S.rechecking) {
    S.rechecking = true;
    setTimeout(() => refresh(), 15000);
    setTimeout(() => refresh(), 60000);
    setTimeout(() => { S.rechecking = false; }, 65000);
  }
  const chip = $('paused-chip');
  const rd = pickReading();
  setHidden(chip, !(S.auth && rd && rd.m === 1));
}

// ---------- rendering: today ----------
function renderToday() {
  const now = nowSec();
  const d = S.hist.derived;
  const setupNeeded = histSetupNeeded();
  const live = S.live && S.live.reading ? { t: S.live.t, w: S.live.reading.w } : null;
  const tc = todayCount(d || derive([], {}), live, now);
  const n = $('today-n');
  const st = d ? stats(d, now) : { lastVisitT: null, median14: null };

  if (tc.source === 'none') {
    setText(n, '–');
    setText($('today-label'), 'No data yet');
    setText($('today-note'), setupNeeded ? "History tracking isn't set up yet" : S.auth ? 'Waiting for the first reading' : 'Sign in or turn on tracking');
  } else if (tc.source === 'box') {
    setText(n, String(tc.n));
    setText($('today-label'), tc.n === 1 ? 'cleaning today' : 'cleanings today');
    setText($('today-note'), "from the box's own counter");
  } else {
    setText(n, String(tc.n));
    setText($('today-label'), tc.n === 1 ? 'visit today' : 'visits today');
    setText($('today-note'), 'counted from cleanings');
  }
  let lastT = st.lastVisitT;
  if (tc.source === 'history+live') lastT = Math.max(lastT || 0, S.wChangedAt || (d && d.lastLine ? d.lastLine.t : 0));
  setText($('today-last'), lastT ? `Last one ${ageText(now - lastT)}` : '');
  setText($('today-usual'), st.median14 !== null ? `Usually about ${Math.round(st.median14)} a day` : '');
}

// ---------- rendering: usage ----------
function eventRow(ev) {
  const t = ev.t;
  switch (ev.type) {
    case 'visit': {
      const [a, b] = ev.range || [t, t];
      return { icon: 'cat', title: ev.n > 1 ? `${ev.n} visits` : 'Visit', detail: b - a > 120 ? `${hm(a)} – ${hm(b)}` : '', tone: 'accent', t };
    }
    case 'binFull': return { icon: 'alert', title: 'Bin full', tone: 'danger', t };
    case 'binEmptied': return { icon: 'check', title: 'Bin emptied', tone: 'ok', t };
    case 'offline': return { icon: 'power', title: 'Box went offline', t };
    case 'online': return { icon: 'power', title: 'Box back online', t, tone: 'ok' };
    case 'paused': return { icon: 'pause', title: 'Auto-clean paused', t };
    case 'resumed': return { icon: 'play', title: 'Auto-clean resumed', t };
    case 'gap': {
      const [a, b] = ev.range || [t, t];
      return { icon: 'clock', title: 'Tracking gap', detail: `No readings ${hm(a)} – ${hm(b)}`, t };
    }
    case 'appClean': return { icon: 'sparkle', title: 'You started a clean', tone: 'accent', t };
    case 'trackingStarted': return { icon: 'flag', title: 'Tracking started', t };
    default: return { icon: 'check', title: 'Event', t };
  }
}

function eventNode(ev) {
  const r = eventRow(ev);
  return h('div', { class: 'ev', 'data-tone': r.tone || '' },
    h('span', { class: 'ev-ico' }, iconSpan(r.icon)),
    h('div', { class: 'ev-text' }, h('p', { class: 'ev-title', text: r.title }), r.detail ? h('p', { class: 'ev-detail', text: r.detail }) : null),
    h('span', { class: 'ev-time', text: hm(r.t) }));
}

function dayHeading(key, now) {
  if (key === dayKeyOf(now)) return 'Today';
  if (key === dayKeyOf(now - 86400)) return 'Yesterday';
  const [y, m, d] = key.split('-').map(Number);
  return dayName(new Date(y, m - 1, d, 12).getTime() / 1000);
}

function renderActivity(derived, now) {
  const host = $('activity');
  const events = recentEvents(derived, appCleans(), 20);
  if (!events.length) {
    host.replaceChildren(h('p', { class: 'empty-note', text: 'Nothing yet. Visits and bin changes will show up here.' }));
    return;
  }
  const groups = [];
  for (const ev of events) {
    const key = dayKeyOf(ev.t);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) { g = { key, items: [] }; groups.push(g); }
    g.items.push(ev);
  }
  host.replaceChildren(...groups.map((g) => h('div', { class: 'ev-day' },
    h('h4', { class: 'ev-day-title', text: dayHeading(g.key, now) }),
    ...g.items.map(eventNode))));
}

function selectDay(date) {
  S.ui.selectedDay = S.ui.selectedDay === date ? null : date;
  S.ui.usageSig = '';
  renderUsage();
}

function renderDayPanel(series, derived, now) {
  const panel = $('day-panel');
  const idx = series.findIndex((s) => s.date === S.ui.selectedDay);
  if (idx < 0) { setHidden(panel, true); return; }
  const s = series[idx];
  setHidden(panel, false);
  setText($('day-name'), s.isToday ? `Today, ${s.label}` : s.label);
  let sum;
  if (s.noData) sum = 'No data for this day';
  else {
    sum = plural(s.visits, 'visit', 'visits');
    if (s.partial) sum += ' · day not fully tracked';
    if (s.manual) sum += ' · auto-clean was paused';
  }
  setText($('day-sum'), sum);
  $('day-prev').disabled = idx === 0;
  $('day-next').disabled = idx === series.length - 1;
  const evs = recentEvents(derived, appCleans(), 5000).filter((e) => dayKeyOf(e.t) === s.date);
  const box = $('day-events');
  if (!evs.length) box.replaceChildren(h('p', { class: 'empty-note', text: s.noData ? '' : 'Nothing recorded on this day.' }));
  else box.replaceChildren(...evs.map(eventNode));
  void now;
}

function renderUsage() {
  const now = nowSec();
  const d = S.hist.derived || derive([], {});
  const setupNeeded = histSetupNeeded();
  const hasLines = S.hist.lines.length > 0;
  const empty = S.hist.loaded && !setupNeeded && !hasLines;
  const err = S.hist.error;
  setHidden($('usage-setup'), !setupNeeded);
  setHidden($('usage-empty'), !empty);
  setHidden($('usage-error'), !err);
  if (empty) {
    const since = S.hist.status && Number(S.hist.status.since);
    const when = since ? (dayKeyOf(since) === dayKeyOf(now) ? `at ${hm(since)}` : `on ${dayName(since)}`) : 'just now';
    setText($('usage-empty-text'), `Tracking began ${when}. Visits will appear here as they happen.`);
  }
  const host = $('usage-chart');
  const live = S.live && S.live.reading ? { t: S.live.t, w: S.live.reading.w } : null;
  const todayN = todayCount(d, live, now).n;
  const sig = [todayN, S.ui.range, S.ui.selectedDay, S.hist.loadedAt, S.hist.lines.length, dayKeyOf(now), host.clientWidth, setupNeeded, empty, err, appCleans().length, S.auth ? 1 : 0].join('|');
  if (sig === S.ui.usageSig) return;
  S.ui.usageSig = sig;

  const ghost = !hasLines;
  const series = dailySeries(ghost ? derive([], {}) : d, S.ui.range, now);
  const today = series[series.length - 1];
  if (!ghost && today && today.isToday) today.visits = Math.max(today.visits, todayN);
  if (S.ui.selectedDay && !series.some((s) => s.date === S.ui.selectedDay)) S.ui.selectedDay = null;
  host.dataset.ghost = ghost ? '1' : '0';
  renderBars(host, series, { onSelect: ghost ? undefined : selectDay, selected: S.ui.selectedDay });
  setHidden($('chart-legend'), ghost);
  if (ghost) { setHidden($('day-panel'), true); } else renderDayPanel(series, d, now);

  const prof = hourProfile(d, now);
  const hh = $('hours-chart');
  if (prof.ready && hasLines) {
    setHidden(hh, false);
    renderHours(hh, prof);
    setHidden($('hours-empty'), true);
  } else {
    setHidden(hh, true);
    setHidden($('hours-empty'), false);
  }
  renderActivity(d, now);
  for (const b of document.querySelectorAll('#range-switch button')) b.setAttribute('aria-checked', String(Number(b.dataset.range) === S.ui.range));
}

// ---------- rendering: trust row ----------
function trustCopy(now) {
  const t = trackingInfo(now);
  const ago = (s) => ageText(now - s);
  switch (t.level) {
    case 'loading': return { tone: 'neutral', text: 'History tracking: checking…' };
    case 'setup': return { tone: 'neutral', text: 'History tracking: not set up' };
    case 'on': return { tone: 'ok', text: t.checked ? `History tracking: on · checked ${ago(t.checked)}` : 'History tracking: on · starting up' };
    case 'delayed': return { tone: 'warn', text: `Tracking delayed (GitHub runs can lag) · last check ${ago(t.checked || t.ok)}` };
    case 'problem': return { tone: 'warn', text: `History tracking: ${errWords(t.err)}` };
    case 'stopped': return { tone: 'danger', text: t.ok ? `Last good check ${dayName(t.ok)} ${hm(t.ok)}` : '', link: true };
    default: return { tone: 'neutral', text: '' };
  }
}

function errWords(err) {
  const k = err && err.kind;
  if (k === 'login') return "couldn't sign in to Popur";
  if (k === 'network') return "couldn't reach Popur";
  if (k === 'push') return "couldn't save the latest readings";
  if (k === 'shape') return 'Popur sent something unexpected';
  if (k === 'http') return 'Popur returned an error';
  return 'trouble on the last check';
}

function renderTrust() {
  const c = trustCopy(nowSec());
  const row = $('trust-row');
  if (row.dataset.tone !== c.tone) row.dataset.tone = c.tone;
  setText($('trust-text'), c.text);
  setHidden($('trust-text'), !c.text);
  const link = $('tracking-link');
  setHidden(link, !c.link);
  if (c.link) {
    setText(link, 'Tracking stopped – tap to turn it back on');
    if (link.getAttribute('href') !== S.cfg.ACTIONS_URL) link.setAttribute('href', S.cfg.ACTIONS_URL);
  }
}

// ---------- rendering: dock (clean button / progress) ----------
function renderDock() {
  const p = S.progress;
  setHidden($('progress-card'), !p);
  setHidden($('clean-wrap'), !!p);
  if (p) {
    setHidden($('clean-hint'), true);
    setHidden($('clean-reason'), true);
    renderProgress(p);
    return;
  }
  const g = cleanGate();
  if (!g.enabled && S.ui.confirm) exitConfirm(true);
  const btn = $('clean-btn');
  btn.disabled = !g.enabled;
  btn.classList.toggle('is-confirm', S.ui.confirm);
  setHidden($('clean-ring'), !S.ui.confirm);
  setText($('clean-label'), S.ui.confirm ? 'Tap again to clean' : 'Clean now');
  setText($('clean-hint'), 'Make sure your cat is out');
  setHidden($('clean-hint'), !S.ui.confirm);
  const reason = $('clean-reason');
  setText(reason, g.reason || '');
  setHidden(reason, !g.reason || S.ui.confirm);
  reason.dataset.tone = g.tone || '';
}

function renderProgress(p) {
  const copy = PROGRESS_COPY[p.final ? p.outcome : p.step];
  const card = $('progress-card');
  card.dataset.final = p.final ? '1' : '0';
  card.dataset.tone = copy[2];
  card.dataset.outcome = p.final ? p.outcome : '';
  setText($('progress-title'), copy[0]);
  setText($('progress-text'), copy[1]);
  const cur = p.final ? (p.outcome === 'done' || p.outcome === 'counted' ? 4 : STEP_ORDER.indexOf(p.step)) : STEP_ORDER.indexOf(p.step);
  const labels = { sending: 'Sending', sent: 'Sent', cleaning: 'Cleaning', done: p.outcome === 'counted' ? 'Counted' : 'Done' };
  STEP_ORDER.forEach((name, i) => {
    const li = $('step-' + name);
    let state = i < cur ? 'done' : i === cur ? 'active' : 'todo';
    if (p.final && p.outcome === 'error' && i === 0) state = 'error';
    if (p.final && (p.outcome === 'timeout' || p.outcome === 'unfinished') && i === cur) state = 'todo';
    li.dataset.state = state;
    setText(li.lastElementChild, labels[name] + (state === 'done' ? ' ✓' : ''));
  });
  setHidden($('progress-dismiss'), !p.final);
}

// ---------- rendering: settings ----------
const settingsOpen = () => $('settings-sheet').open;
const diagOpen = () => settingsOpen() && $('diagnostics').open;

function renderSettings() {
  if (!settingsOpen()) return;
  const now = nowSec();
  const signedIn = !!S.auth;
  setHidden($('sec-control'), !signedIn);
  const pause = $('pause-switch');
  const rd = pickReading();
  pause.setAttribute('aria-checked', String(!!(rd && rd.m === 1)));
  pause.disabled = !cleanGate().enabled && !(S.live && S.live.reading.on !== 0 && S.online && S.devid);

  // device picker
  setHidden($('sec-devices'), S.devices.length < 2);
  const sig = S.devices.map((d) => d.devid + ':' + d.name).join('|') + '#' + S.devid;
  const list = $('device-list');
  if (list.dataset.sig !== sig) {
    list.dataset.sig = sig;
    list.replaceChildren(...S.devices.map((d) => {
      const b = h('button', { class: 'device-opt', type: 'button', role: 'radio', 'aria-checked': String(d.devid === S.devid), 'data-devid': d.devid },
        h('span', { text: d.name || 'Litter box' }));
      const tick = h('span', { class: 'tick' });
      tick.append(icon('check'));
      b.append(tick);
      return b;
    }));
  }

  // history tracking
  const t = trackingInfo(now);
  const summary = {
    loading: 'Checking…',
    setup: "Not set up yet. Nothing records your cat's visits while this page is closed.",
    on: 'On. A helper checks your box about every 15 minutes, even when this page is closed.',
    delayed: 'Delayed. GitHub sometimes runs late, and it usually catches up on its own.',
    problem: `On, but the last check had trouble: ${errWords(t.err)}.`,
    stopped: 'Stopped. Tap the link below to turn it back on.',
  }[t.level];
  setText($('tracking-summary'), summary);
  const facts = $('tracking-facts');
  const rows = [];
  if (t.level !== 'setup' && t.level !== 'loading') {
    rows.push(['Last check', t.checked ? `${ageText(now - t.checked)}` : 'not yet']);
    rows.push(['Last success', t.ok ? `${ageText(now - t.ok)}` : 'not yet']);
    rows.push(['Last problem', t.err ? errWords(t.err) : 'none']);
  }
  rows.push(['Live updates', S.mqtt.state === 'live' ? 'available' : S.mqtt.state === 'refused' ? 'not available' : S.auth ? 'not connected' : 'sign in to check']);
  const fsig = rows.map((r) => r.join(':')).join('|');
  if (facts.dataset.sig !== fsig) {
    facts.dataset.sig = fsig;
    facts.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]));
  }
  const needSetup = t.level === 'setup';
  setHidden($('setup-open'), !needSetup);
  const fb = $('setup-fallback-link');
  setHidden(fb, !(needSetup || t.level === 'stopped'));
  const fbText = t.level === 'stopped' ? 'Turn tracking back on' : 'Set it up on GitHub instead';
  if (fb.firstChild.nodeValue !== fbText) fb.firstChild.nodeValue = fbText;
  fb.setAttribute('href', t.level === 'stopped' ? S.cfg.ACTIONS_URL : S.cfg.SECRETS_URL);
  setHidden($('tracking-actions'), !(needSetup || t.level === 'stopped'));

  for (const b of document.querySelectorAll('#theme-switch button')) b.setAttribute('aria-checked', String(b.dataset.themeChoice === S.ui.theme));

  setHidden($('account-signedin'), !signedIn);
  setHidden($('account-signedout'), signedIn);
  if (signedIn) {
    setText($('account-email'), maskEmail(S.auth.email));
    $('keep-switch-settings').setAttribute('aria-checked', String(S.keep));
  }
  $('repo-link').setAttribute('href', S.cfg.REPO_URL);
  if (diagOpen()) renderDiagnostics();
}

let diagTimer = null;
function scheduleDiagRender() {
  if (diagTimer) return;
  diagTimer = setTimeout(() => { diagTimer = null; if (diagOpen()) renderDiagnostics(); }, 300);
}

const secretList = () => [S.api && S.api.token, S.auth && S.auth.homeId, S.auth && S.auth.userId, S.devid, S.auth && S.auth.email, S.auth && S.auth.md5];

function diagnosticsData() {
  const secrets = secretList();
  const st = S.hist.status;
  return {
    app: APP_VERSION,
    time: new Date().toISOString(),
    userAgent: navigator.userAgent,
    deviceinfo: S.live && S.live.raw ? redact(S.live.raw, secrets) : null,
    homeDetails: S.homeRaw ? redact(S.homeRaw, secrets) : null,
    insights: st && st.insights ? redact(st.insights, secrets) : null,
    run: st && st.run ? st.run : null,
    binValuesSeen: [...S.binSeen].sort(),
    liveUpdates: { state: S.mqtt.state, suback: S.mqtt.info.suback, messages: S.mqtt.info.msgs },
    log: S.log.slice(-150).map((l) => `${new Date(l.t).toISOString().slice(11, 19)} ${l.kind}: ${l.text}`),
  };
}

function renderDiagnostics() {
  const d = diagnosticsData();
  const pretty = (o, empty) => (o ? JSON.stringify(o, null, 2) : empty);
  setText($('diag-deviceinfo'), pretty(d.deviceinfo, 'No reading yet'));
  setText($('diag-home'), pretty(d.homeDetails, 'Not loaded yet'));
  setText($('diag-insights'), pretty(d.insights, 'No tracking notes yet'));
  const seen = d.binValuesSeen;
  const note = seen.length
    ? `Values seen this session: ${seen.join(', ')}. Only 2 is confirmed to mean "full" by other apps. 0 and 1 are treated as "has room" but are unverified until a real full reading is confirmed.`
    : 'No bin readings yet. Only 2 is confirmed to mean "full" by other apps; 0 and 1 are treated as "has room" but are unverified.';
  setText($('diag-binnote'), note);
  const m = S.mqtt;
  setText($('diag-mqtt'), `State: ${m.state}. Subscribe answer: ${m.info.suback === null ? 'none yet' : m.info.suback === 0x80 ? 'refused' : 'accepted'}. Messages received: ${m.info.msgs}.`);
  setText($('diag-log'), d.log.length ? d.log.join('\n') : 'Nothing logged yet');
}

// ---------- render entry points ----------
function renderLight() {
  renderGlobal();
  renderHeader();
  renderHero();
  renderToday();
  renderTrust();
  renderDock();
}

function render() {
  renderLogin();
  renderLight();
  renderUsage();
  renderSettings();
}

// ---------- toast ----------
let toastAction = null;
function hideToast() {
  const box = $('toast');
  try { if (box.hidePopover) box.hidePopover(); } catch { /* not open */ }
  box.hidden = true;
}
function toast(text, action = null) {
  const box = $('toast');
  setText($('toast-text'), text);
  const btn = $('toast-action');
  toastAction = action ? action.fn : null;
  btn.hidden = !action;
  if (action) btn.textContent = action.label;
  box.hidden = false;
  try { if (box.showPopover && !box.matches(':popover-open')) box.showPopover(); } catch { /* popover is optional */ }
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(hideToast, TOAST_MS);
}

// ---------- clean confirm ----------
function enterConfirm() {
  S.ui.confirm = true;
  clearTimeout(S.confirmTimer);
  S.confirmTimer = setTimeout(() => exitConfirm(), CONFIRM_MS);
  render();
}
function exitConfirm(silent = false) {
  S.ui.confirm = false;
  clearTimeout(S.confirmTimer);
  if (!silent) render();
}

function onCleanClick(e) {
  if (!cleanGate().enabled) return;
  if (e.detail === 0) { $('confirm-dialog').showModal(); return; } // keyboard / screen reader: a real dialog
  if (!S.ui.confirm) enterConfirm();
  else { exitConfirm(true); startClean(); }
}

// ---------- sign in / out ----------
async function onLoginSubmit(e) {
  e.preventDefault();
  if (S.loginBusy) return;
  const email = $('login-email').value.trim();
  const pw = $('login-password').value;
  const err = $('login-error');
  if (!email || !pw) { err.textContent = 'Enter your email and password.'; err.hidden = false; return; }
  err.hidden = true;
  S.loginBusy = true;
  renderLogin();
  try {
    S.keep = $('keep-signed-in').getAttribute('aria-checked') === 'true';
    store.set('keep', S.keep);
    await doLogin(email, md5Hex(pw));
    setApiAuth();
    $('login-password').value = '';
    Object.assign(S, { expired: false, evicted: false, loading: true, devices: [], devid: null, dk: null, live: null, pid2: null, apiError: null, backoffMs: 0 });
    store.del('relogins');
    render();
    await refresh({ full: true });
    schedulePoll();
  } catch (ex) {
    const k = ex && ex.kind;
    err.textContent = k === 'login' ? "That email or password didn't work. Check them and try again."
      : k === 'network' ? "Can't reach Popur. Check your connection and try again."
        : 'Something went wrong signing in. Please try again.';
    err.hidden = false;
    S.auth = null;
    setApiAuth();
  } finally {
    S.loginBusy = false;
    render();
  }
}

async function evictedSignIn() {
  store.del('relogins');
  S.evicted = false;
  try {
    if (!S.auth || !S.auth.md5) throw new Error('no credentials');
    await doLogin(S.auth.email, S.auth.md5);
    setApiAuth();
    render();
    await refresh({ full: true });
    schedulePoll();
  } catch {
    expireSession();
  }
  render();
}

function signOut() {
  stopMqtt();
  clearTimeout(S.pollTimer);
  clearAccountData();
  S.expired = false;
  S.evicted = false;
  S.loading = true;
  S.apiError = null;
  S.ui.usageSig = '';
  $('settings-sheet').close();
  toast('Signed out');
  render();
  loadHistoryNow();
}

async function switchDevice(devid) {
  if (devid === S.devid) return;
  stopMqtt();
  S.devid = devid;
  S.name = (S.devices.find((d) => d.devid === devid) || {}).name || null;
  S.live = null; S.pid2 = null; S.fieldPrev = null; S.progress = null; S.loading = true;
  S.mqtt.state = 'off'; S.mqtt.failures = 0;
  await updateDk();
  persistSession();
  persistCache();
  render();
  await refresh();
  schedulePoll();
}

// ---------- history tracking setup (handoff code) ----------
async function openSetup() {
  if (!S.auth) {
    if (settingsOpen()) $('settings-sheet').close();
    toast('Sign in first, then turn on history tracking');
    $('login-email').focus();
    return;
  }
  const dlg = $('setup-dialog');
  setHidden($('setup-pw'), true);
  setHidden($('setup-code-view'), true);
  setText($('setup-copy-status'), '');
  setText($('setup-copy-label'), 'Copy setup code');
  $('setup-fallback').setAttribute('href', S.cfg.SECRETS_URL);
  if (!dlg.open) dlg.showModal();
  const md5 = S.auth.md5 || (store.get('cred') || {}).md5;
  if (!md5) { setHidden($('setup-pw'), false); $('setup-password').focus(); return; }
  await produceSetupCode(md5);
}

async function produceSetupCode(md5) {
  try {
    const code = await makeSetupCode(S.auth.email, md5, S.cfg.HANDOFF_SPKI, nowSec());
    S.setupCode = code;
    $('setup-code').value = code;
    setHidden($('setup-pw'), true);
    setHidden($('setup-code-view'), false);
  } catch {
    setHidden($('setup-pw'), false);
    const e = $('setup-pw-error');
    e.textContent = "Couldn't make the setup code on this browser. Use the GitHub link instead.";
    e.hidden = false;
  }
}

async function copyText(text, fallbackEl) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* try the old way */ }
  try {
    const el = fallbackEl || h('textarea', { 'aria-hidden': 'true' });
    if (!fallbackEl) { el.value = text; document.body.append(el); }
    el.focus(); el.select();
    const ok = document.execCommand('copy');
    if (!fallbackEl) el.remove();
    return ok;
  } catch { return false; }
}

async function copySetupCode() {
  const ok = await copyText(S.setupCode || $('setup-code').value, $('setup-code'));
  setText($('setup-copy-label'), ok ? 'Copied ✓' : 'Copy setup code');
  setText($('setup-copy-status'), ok
    ? 'Copied. Paste it into your chat with Claude.'
    : 'Could not copy automatically. Press and hold the code above to select it, then copy it.');
}

async function showAccountDetails() {
  const pre = $('account-details');
  if (!pre.hidden) { pre.hidden = true; return; }
  pre.textContent = 'Loading…';
  pre.hidden = false;
  try {
    const raw = await withAuth(() => S.api.user());
    pre.textContent = JSON.stringify(redact(raw, secretList()), null, 2);
  } catch {
    pre.textContent = "Couldn't load account details.";
  }
}

async function copyReport() {
  const ok = await copyText(JSON.stringify(diagnosticsData(), null, 2));
  setText($('diag-copy-status'), ok ? 'Report copied. Private details are hidden.' : "Couldn't copy the report on this browser.");
}

// ---------- appearance ----------
function applyTheme() {
  const r = document.documentElement;
  if (S.ui.theme === 'light' || S.ui.theme === 'dark') r.dataset.theme = S.ui.theme;
  else delete r.dataset.theme;
}
function setTheme(choice) {
  S.ui.theme = choice;
  store.set('theme', choice);
  applyTheme();
  render();
}

// ---------- events ----------
function bindEvents() {
  const on = (id, ev, fn) => $(id).addEventListener(ev, fn);

  on('settings-btn', 'click', openSettings);
  on('device-btn', 'click', () => { openSettings(); $('sec-devices').scrollIntoView({ block: 'center' }); });
  on('settings-close', 'click', () => $('settings-sheet').close());
  for (const id of ['settings-sheet', 'setup-dialog', 'confirm-dialog']) {
    $(id).addEventListener('click', (e) => { if (e.target === $(id)) $(id).close(); });
  }
  on('updated-btn', 'click', () => { refresh(); loadHistoryNow(); });
  on('api-retry', 'click', () => { S.backoffMs = 0; refresh().then(schedulePoll); });

  on('login-form', 'submit', onLoginSubmit);
  on('login-email', 'input', () => { $('login-email').dataset.touched = '1'; });
  on('keep-signed-in', 'click', () => {
    const sw = $('keep-signed-in');
    sw.setAttribute('aria-checked', String(sw.getAttribute('aria-checked') !== 'true'));
  });
  on('evicted-signin', 'click', evictedSignIn);

  on('resume-btn', 'click', () => setPaused(false));
  on('clean-btn', 'click', onCleanClick);
  on('progress-dismiss', 'click', () => { S.progress = null; render(); });
  on('confirm-cancel', 'click', () => $('confirm-dialog').close());
  on('confirm-go', 'click', () => { $('confirm-dialog').close(); startClean(); });

  for (const b of document.querySelectorAll('#range-switch button')) {
    b.addEventListener('click', () => { S.ui.range = Number(b.dataset.range); S.ui.usageSig = ''; renderUsage(); });
  }
  const step = (delta) => {
    const series = dailySeries(S.hist.derived || derive([], {}), S.ui.range, nowSec());
    const i = series.findIndex((s) => s.date === S.ui.selectedDay);
    const next = series[i + delta];
    if (next) { S.ui.selectedDay = next.date; S.ui.usageSig = ''; renderUsage(); }
  };
  on('day-prev', 'click', () => step(-1));
  on('day-next', 'click', () => step(1));
  on('day-close', 'click', () => { S.ui.selectedDay = null; S.ui.usageSig = ''; renderUsage(); });
  on('history-retry', 'click', loadHistoryNow);
  on('setup-open-usage', 'click', openSetup);
  on('setup-open', 'click', openSetup);

  on('pause-switch', 'click', () => setPaused($('pause-switch').getAttribute('aria-checked') !== 'true'));
  on('refresh-btn', 'click', () => { refresh({ full: true }); loadHistoryNow(); toast('Refreshing…'); });
  $('device-list').addEventListener('click', (e) => {
    const b = e.target.closest('.device-opt');
    if (b) switchDevice(b.dataset.devid);
  });
  for (const b of document.querySelectorAll('#theme-switch button')) b.addEventListener('click', () => setTheme(b.dataset.themeChoice));
  on('keep-switch-settings', 'click', () => {
    S.keep = !S.keep;
    store.set('keep', S.keep);
    persistSession();
    renderSettings();
  });
  on('account-details-btn', 'click', showAccountDetails);
  on('signout-btn', 'click', signOut);
  on('diagnostics', 'toggle', () => { if (diagOpen()) renderDiagnostics(); });
  on('diag-copy', 'click', copyReport);

  on('setup-close', 'click', () => $('setup-dialog').close());
  on('setup-make', 'click', async () => {
    const pw = $('setup-password').value;
    if (!pw) return;
    S.auth.md5 = md5Hex(pw);
    $('setup-password').value = '';
    await produceSetupCode(S.auth.md5);
  });
  on('setup-copy', 'click', copySetupCode);

  on('toast-action', 'click', () => { const fn = toastAction; hideToast(); if (fn) fn(); });

  window.addEventListener('online', () => { S.online = true; render(); onResume(); });
  window.addEventListener('offline', () => { S.online = false; render(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(S.pollTimer); stopMqtt(); } else onResume();
  });
  window.addEventListener('focus', onResume);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
}

function openSettings() {
  const dlg = $('settings-sheet');
  if (!dlg.open) dlg.showModal();
  renderSettings();
}

let lastResume = 0;
function onResume() {
  if (document.hidden || Date.now() - lastResume < 3000) return;
  lastResume = Date.now();
  if (S.auth && !S.evicted) { refresh().then(schedulePoll); startMqtt(); }
  if (Date.now() - S.hist.loadedAt > HISTORY_MS) loadHistoryNow();
  render();
}

// ---------- timers ----------
function tick() {
  const p = S.progress;
  if (p && !p.final) evalProgress();
  if (p && p.final && (p.outcome === 'done' || p.outcome === 'counted') && Date.now() - p.endedAt > DONE_LINGER_MS) S.progress = null;
  renderLight();
  renderUsage();
}

function startTimers() {
  setInterval(tick, 1000);
  setInterval(() => { if (!document.hidden) loadHistoryNow(); }, HISTORY_MS);
  const dockSize = () => document.documentElement.style.setProperty('--dock-h', `${$('dock').offsetHeight}px`);
  if (window.ResizeObserver) {
    new ResizeObserver(dockSize).observe($('dock'));
    let raf = 0;
    new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderUsage); }).observe($('usage-card'));
  }
  dockSize();
}

// ---------- start ----------
async function restore() {
  S.keep = store.get('keep', true) !== false;
  const sess = store.get('session');
  const cred = store.get('cred');
  if (sess && sess.token && sess.email) {
    S.auth = { email: sess.email, token: sess.token, homeId: sess.homeId, userId: sess.userId, md5: (cred && cred.md5) || null };
    S.devid = sess.devid || null;
  } else if (cred && cred.md5 && cred.email) {
    S.auth = { email: cred.email, token: null, homeId: null, userId: null, md5: cred.md5 };
  }
  setApiAuth();
  const cache = store.get('cache');
  if (S.auth && cache) {
    S.devices = Array.isArray(cache.devices) ? cache.devices : [];
    S.devid = S.devid || cache.devid || null;
    S.name = cache.name || null;
    if (cache.live && cache.live.reading) { S.live = { reading: cache.live.reading, t: cache.live.t, raw: null }; S.loading = false; }
  }
  if (S.auth && S.devid) S.dk = await deviceKey(S.auth.email, S.devid);
  else if (!S.auth) S.signedOutDk = store.get('lastdk') || null;
  const dk = effDk();
  const c = dk ? store.get('hist:' + dk) : null;
  if (c && c.status) setHistory({ status: c.status, lines: c.lines || [], notSetUp: false }, true);
}

async function init() {
  S.cfg = applyOverrides(window.location);
  S.api = new PopurApi({ base: S.cfg.API });
  S.online = navigator.onLine !== false;
  S.ui.theme = store.get('theme', 'system');
  applyTheme();
  hydrateIcons();
  bindEvents();
  await restore();
  $('keep-signed-in').setAttribute('aria-checked', String(S.keep));
  render();
  startTimers();
  if (S.auth) refresh({ full: true }).then(schedulePoll);
  loadHistoryNow();
}

init();

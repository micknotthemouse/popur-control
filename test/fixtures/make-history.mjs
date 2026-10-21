// Generates a data-branch fixture: status/gha.json + history/<dk>/<YYYY-MM>.ndjson.
// CLI: node test/fixtures/make-history.mjs --out test/.tmp/data --mode full|empty|notsetup|stale|setup --days 30 [--now <unixSec>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const EMAIL = 'cat@example.com';
export const DEVID = 'dev_test_789';
export const DK = crypto.createHash('sha256').update(`popur-control:v1:${EMAIL.trim().toLowerCase()}:${DEVID}`).digest('hex').slice(0, 12);

const H = 3600, D = 86400, RESET_SEC = 16 * H; // worknum resets at 16:00 UTC

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const lastReset = (t) => Math.floor((t - RESET_SEC) / D) * D + RESET_SEC;

// Local-time midnight of the day containing unix second t.
function localMidnight(t) { const d = new Date(t * 1000); d.setHours(0, 0, 0, 0); return Math.floor(d.getTime() / 1000); }

function planVisits(rand, start, now, days) {
  const visits = [];
  for (let i = 0; i <= days; i++) {
    const mid = localMidnight(start + i * D + 12 * H);
    const n = 3 + Math.floor(rand() * 5);
    for (let k = 0; k < n; k++) {
      const morning = rand() < 0.5;
      const hour = morning ? 6 + rand() * 4 : 18 + rand() * 4.5;
      const t = Math.floor(mid + hour * H);
      if (t > start && t < now - 600) visits.push(t);
    }
  }
  return visits.sort((a, b) => a - b);
}

function buildLines(rand, { start, end, days, now }) {
  const visits = planVisits(rand, start, now, days);
  const gapStart = start + Math.floor(days * 0.6) * D + 2 * H, gapEnd = gapStart + 3 * H;
  const fullStart = end - 3 * D + 4 * H, fullEnd = fullStart + 10 * H;
  const manStart = localMidnight(start + 7 * D + 12 * H) + 13 * H, manEnd = manStart + 4 * H;
  const effective = visits.filter((t) => !(t >= manStart && t < manEnd)); // manual mode: no cleans
  let lwBase = 1400;
  const state = (t) => {
    const w = effective.filter((v) => v > lastReset(t) && v <= t).length;
    const lw = lwBase + effective.filter((v) => v <= t).length;
    const r = t >= fullStart && t < fullEnd ? 2 : 0;
    const m = t >= manStart && t < manEnd ? 1 : 0;
    return { w, lw, r, on: 1, m };
  };

  const lines = [];
  let pt = null, last = null, lastLineT = 0, n = 0, rubCount = 0, bf = 0, binFullSince = null;
  let t = start + Math.floor(rand() * 600);
  let lastPoll = null;
  const poll = (at) => {
    n++;
    const s = state(at);
    rubCount = s.r === 2 ? rubCount + 1 : 0;
    bf = rubCount >= 2 ? 1 : 0;
    if (bf && binFullSince == null) binFullSince = at;
    if (!bf) binFullSince = null;
    const cur = { ...s, bf };
    const changed = !last || ['w', 'lw', 'r', 'bf', 'on', 'm'].some((k) => cur[k] !== last[k]);
    if (changed || (pt != null && at - pt > 2 * H) || (at - lastLineT >= 6 * H)) {
      lines.push({ t: at, pv: pt, w: cur.w, lw: cur.lw, r: cur.r, bf: cur.bf, on: 1, m: cur.m });
      lastLineT = at;
    }
    last = cur; pt = at; lastPoll = at;
  };
  while (t <= end) {
    if (!(t >= gapStart && t < gapEnd)) poll(t);
    t += 900 + Math.floor(rand() * 1200);
  }
  if (lastPoll < end - 600) poll(end - 120); // keep the final poll fresh
  return { lines, pt, last, n, binFullSince, firstT: start };
}

function monthKey(t) { const d = new Date(t * 1000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }

export function makeHistory({ out, mode = 'full', days = 30, now = Math.floor(Date.now() / 1000) }) {
  fs.rmSync(path.join(out, 'status'), { recursive: true, force: true });
  fs.rmSync(path.join(out, 'history'), { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  if (mode === 'notsetup') return { dk: DK, lines: 0 };

  const writeStatus = (obj) => {
    fs.mkdirSync(path.join(out, 'status'), { recursive: true });
    fs.writeFileSync(path.join(out, 'status', 'gha.json'), JSON.stringify(obj, null, 1));
  };
  const insights = {
    fields: ['devid', 'isonline', 'lastworknum', 'manualmode', 'rubbish', 'worknum'], homeFields: ['devicelist'],
    rubbish: [0, 2], lw: 'unknown', resetWin: [], loginOk: true, small: { sandlevel: 1, errcode: 0 },
    logins: { [new Date((now - D) * 1000).toISOString().slice(0, 10)]: 1, [new Date(now * 1000).toISOString().slice(0, 10)]: 1 },
  };
  const keepalive = { t: now - 5 * D, status: 204 };

  if (mode === 'setup') {
    writeStatus({ v: 1, src: 'gha', since: now, run: { t: now - 300, ok: null, n: 1, fails: 0, err: { t: now - 300, kind: 'setup' } }, devices: {}, insights: {}, keepalive: { t: null, status: null } });
    return { dk: DK, lines: 0 };
  }

  const stale = mode === 'stale';
  const end = stale ? now - 8 * H : now - 60;
  const start = now - days * D;
  const rand = rng(20261020);
  const r = mode === 'empty'
    ? { lines: [], pt: end, last: { w: 3, lw: 1452, r: 0, bf: 0, on: 1, m: 0 }, n: 1, binFullSince: null }
    : buildLines(rand, { start, end, days, now });

  const byMonth = new Map();
  for (const l of r.lines) {
    const k = monthKey(l.t);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(JSON.stringify(l));
  }
  if (byMonth.size) fs.mkdirSync(path.join(out, 'history', DK), { recursive: true });
  for (const [k, rows] of byMonth) fs.writeFileSync(path.join(out, 'history', DK, `${k}.ndjson`), rows.join('\n') + '\n');

  const lastLine = r.last && { t: r.pt, pv: null, ...r.last };
  writeStatus({
    v: 1, src: 'gha', since: start,
    run: { t: end, ok: end, n: r.n, fails: 0, err: null },
    devices: { [DK]: { pt: r.pt, last: lastLine, binPending: 0, binFullSince: r.binFullSince } },
    insights, keepalive,
  });
  return { dk: DK, lines: r.lines.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2);
  const opt = (n, d) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : d; };
  const res = makeHistory({
    out: path.resolve(opt('out', 'test/.tmp/data')), mode: opt('mode', 'full'),
    days: Number(opt('days', 30)), now: opt('now') ? Number(opt('now')) : Math.floor(Date.now() / 1000),
  });
  console.log(`mode=${opt('mode', 'full')} dk=${res.dk} lines=${res.lines}`);
}

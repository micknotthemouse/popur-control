// Pure history derivation: turns stored poll lines into visits per local day/hour and events.
// Line schema: {t, pv, w, lw, r, bf, on, m}; t and pv are unix seconds UTC, pv may be null.
// Days are LOCAL calendar days (Date getters), iterated with new Date(y, m, d) so DST is safe.
// No window/document/localStorage access; no imports.

const H = 3600;
const MAX_VISITS_PER_WINDOW = 20; // more than this in one window is treated as a counter glitch
const SHORT_WINDOW = 3 * H; // up to here a window is placed by its midpoint
const HOUR_SPREAD_MAX = H; // up to here a window is spread over local clock hours
const GAP_MIN = 2 * H; // longer windows are tracking gaps
const LOSSY_RESET_MIN = 30 * 60; // a counter reset inside a longer window probably lost some cycles
const TRAILING_GAP = 7 * H; // no line for this long while "now" moves on: treat as a gap
const MAX_SPAN_DAYS = 3700;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------- small helpers ----------

// Accept unix seconds or milliseconds for "now"-like inputs.
function toSec(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  return x > 1e11 ? Math.floor(x / 1000) : x;
}

function num(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

const pad2 = (n) => String(n).padStart(2, '0');

function dayKeyOfDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function dayKey(tSec) {
  return dayKeyOfDate(new Date(tSec * 1000));
}

function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return { y, m, d };
}

// Calendar-day arithmetic that survives DST (never adds 86400 seconds).
function addDays(key, n) {
  const { y, m, d } = parseKey(key);
  return dayKeyOfDate(new Date(y, m - 1, d + n));
}

function dayLabel(key) {
  const { y, m, d } = parseKey(key);
  const dt = new Date(y, m - 1, d);
  return `${WEEKDAYS[dt.getDay()]} ${d} ${MONTHS[m - 1]}`;
}

function ensureDay(days, key) {
  if (!days[key]) days[key] = { visits: 0, partial: false, lossy: false, binFull: false, manual: false };
  return days[key];
}

// Set `flag` on every local day touched by [fromT, toT].
function markSpan(days, fromT, toT, flag) {
  const last = dayKey(toT);
  let key = dayKey(fromT);
  for (let i = 0; i < MAX_SPAN_DAYS; i++) {
    ensureDay(days, key)[flag] = true;
    if (key >= last) break;
    key = addDays(key, 1);
  }
}

function cleanLines(lines) {
  if (!Array.isArray(lines)) return [];
  const out = [];
  for (const raw of lines) {
    if (!raw || typeof raw !== 'object') continue;
    const t = num(raw.t);
    if (t === null) continue;
    const pv = num(raw.pv);
    out.push({
      t,
      pv: pv !== null && pv <= t ? pv : null,
      w: num(raw.w),
      lw: num(raw.lw),
      r: num(raw.r),
      bf: num(raw.bf),
      on: num(raw.on),
      m: num(raw.m),
    });
  }
  return out.map((l, i) => [l, i]).sort((a, b) => a[0].t - b[0].t || a[1] - b[1]).map((x) => x[0]);
}

// ---------- visit counting ----------

// Returns {d, reset, anomaly} for consecutive lines a -> b.
function countDelta(a, b, lwMode) {
  let d = 0;
  let reset = false;
  if (a.w !== null && b.w !== null) {
    if (b.w < a.w) {
      d = b.w;
      reset = true;
    } else {
      d = b.w - a.w;
    }
  }
  if (lwMode === 'lifetime' && a.lw !== null && b.lw !== null && b.lw >= a.lw) {
    d = b.lw - a.lw;
  }
  let anomaly = false;
  if (d > MAX_VISITS_PER_WINDOW) {
    d = 0;
    anomaly = true;
  }
  return { d, reset, anomaly };
}

// Spread d over local clock hours in proportion to overlap with [start, end].
function spreadHours(hours, start, end, d) {
  if (end <= start) {
    const dt = new Date(end * 1000);
    addHour(hours, dayKeyOfDate(dt), dt.getHours(), d);
    return;
  }
  const total = end - start;
  let cursor = start;
  for (let guard = 0; cursor < end && guard < 4; guard++) {
    const dt = new Date(cursor * 1000);
    const boundary = cursor - dt.getMinutes() * 60 - dt.getSeconds() + H; // next local :00
    const pieceEnd = Math.min(end, boundary);
    addHour(hours, dayKeyOfDate(dt), dt.getHours(), (d * (pieceEnd - cursor)) / total);
    cursor = pieceEnd;
  }
}

function addHour(hours, key, h, v) {
  if (!hours[key]) hours[key] = new Array(24).fill(0);
  hours[key][h] += v;
}

/**
 * @param {object[]} lines history lines
 * @param {{now?:number, lwMode?:string|null}} [opts]
 * @returns {{windows:object[], days:Object<string,object>, hours:Object<string,number[]>,
 *            events:object[], firstT:number|null, lastLine:object|null}}
 */
export function derive(lines, opts = {}) {
  const sorted = cleanLines(lines);
  const lwMode = opts.lwMode ?? null;
  const now = toSec(opts.now);
  const out = { windows: [], days: {}, hours: {}, events: [], firstT: null, lastLine: null };
  if (sorted.length === 0) return out;

  const { days, hours, events, windows } = out;
  out.firstT = sorted[0].t;
  out.lastLine = sorted[sorted.length - 1];
  events.push({ t: out.firstT, type: 'trackingStarted' });

  // State flags carried over each line (a bin shown full at t stays full until the next line).
  for (const l of sorted) {
    if (l.bf === 1) markSpan(days, l.t, l.t, 'binFull');
    if (l.m === 1) markSpan(days, l.t, l.t, 'manual');
  }

  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    const end = b.t;
    const start = Math.min(Math.max(a.t, b.pv ?? a.t), end);
    const L = end - start;
    const { d, reset, anomaly } = countDelta(a, b, lwMode);
    const gap = L > GAP_MIN;
    const lossy = anomaly || (reset && L > LOSSY_RESET_MIN);

    // Day placement.
    let key;
    let partial = false;
    if (L <= SHORT_WINDOW) {
      key = dayKey(Math.floor((start + end) / 2));
    } else {
      key = dayKey(end);
      partial = true;
    }
    const day = ensureDay(days, key);
    day.visits += d;
    if (partial) day.partial = true;
    if (lossy) day.lossy = true;
    if (gap) markSpan(days, start, end, 'partial');

    // Hour placement.
    if (d > 0 && L <= HOUR_SPREAD_MAX) spreadHours(hours, start, end, d);

    // State carried across the span a.t .. b.t.
    if (a.bf === 1) markSpan(days, a.t, b.t, 'binFull');
    if (a.m === 1) markSpan(days, a.t, b.t, 'manual');

    windows.push({ start, end, L, d, day: key, partial: partial || gap, reset, anomaly, gap, lossy });

    // Events.
    if (d > 0) events.push({ t: end, type: 'visit', n: d, range: [start, end] });
    if (gap) events.push({ t: end, type: 'gap', range: [start, end] });
    if (a.bf !== null && b.bf !== null && a.bf !== b.bf) {
      events.push({ t: end, type: b.bf === 1 ? 'binFull' : 'binEmptied' });
    }
    if (a.on !== null && b.on !== null && a.on !== b.on) {
      events.push({ t: end, type: b.on === 1 ? 'online' : 'offline' });
    }
    if (a.m !== null && b.m !== null && a.m !== b.m) {
      events.push({ t: end, type: b.m === 1 ? 'paused' : 'resumed' });
    }
  }

  // The last line's state continues until "now"; a long silence is a trailing gap.
  const last = out.lastLine;
  if (now !== null && now > last.t) {
    if (last.bf === 1) markSpan(days, last.t, now, 'binFull');
    if (last.m === 1) markSpan(days, last.t, now, 'manual');
    if (now - last.t > TRAILING_GAP) markSpan(days, last.t, now, 'partial');
  }

  events.sort((x, y) => x.t - y.t);
  return out;
}

// ---------- today ----------

/**
 * Visits so far today: history for today plus a top-up from a live reading newer than the last line.
 * @param {object} derived result of derive()
 * @param {{t?:number, w?:number}|null} live latest live reading (REST), same units as line.w
 * @param {number} now unix seconds
 * @returns {{n:number, source:'history'|'history+live'|'box'|'none'}}
 */
export function todayCount(derived, live, now) {
  const nowS = toSec(now) ?? Math.floor(Date.now() / 1000);
  const last = derived && derived.lastLine;
  const liveW = live ? num(live.w) : null;

  if (!last) {
    // No history at all: the box's own "cleanings today" counter is the only source.
    return liveW !== null ? { n: liveW, source: 'box' } : { n: 0, source: 'none' };
  }

  const base = (derived.days[dayKey(nowS)] || {}).visits || 0;
  const liveT = live ? (toSec(num(live.t)) ?? nowS) : null;
  let top = 0;
  if (liveW !== null && last.w !== null && liveT !== null && liveT > last.t) {
    top = liveW >= last.w ? liveW - last.w : liveW;
    top = Math.max(0, Math.min(MAX_VISITS_PER_WINDOW, top));
  }
  return { n: base + top, source: top > 0 ? 'history+live' : 'history' };
}

// ---------- series ----------

/**
 * Oldest-first list of the last nDays local days ending today.
 * @returns {{date:string,label:string,visits:number,partial:boolean,lossy:boolean,manual:boolean,
 *            binFull:boolean,noData:boolean,isToday:boolean}[]}
 */
export function dailySeries(derived, nDays, now) {
  const nowS = toSec(now) ?? Math.floor(Date.now() / 1000);
  const today = dayKey(nowS);
  const firstKey = derived && derived.firstT !== null && derived.firstT !== undefined ? dayKey(derived.firstT) : null;
  const dayMap = (derived && derived.days) || {};
  const out = [];
  for (let i = nDays - 1; i >= 0; i--) {
    const key = addDays(today, -i);
    const day = dayMap[key];
    const noData = firstKey === null || key < firstKey;
    out.push({
      date: key,
      label: dayLabel(key),
      visits: noData || !day ? 0 : day.visits,
      partial: !noData && !!(day && day.partial),
      lossy: !noData && !!(day && day.lossy),
      manual: !noData && !!(day && day.manual),
      binFull: !noData && !!(day && day.binFull),
      noData,
      isToday: key === today,
    });
  }
  return out;
}

// Complete (not today) local days, newest first, that have data.
function completeDays(derived, nDays, nowS) {
  const today = dayKey(nowS);
  const firstKey = derived && derived.firstT !== null && derived.firstT !== undefined ? dayKey(derived.firstT) : null;
  const dayMap = (derived && derived.days) || {};
  const out = [];
  for (let i = 1; i <= nDays; i++) {
    const key = addDays(today, -i);
    out.push({ key, day: dayMap[key] || null, hasData: firstKey !== null && key >= firstKey });
  }
  return out;
}

function median(values) {
  const v = values.slice().sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function meanVisits(entries) {
  const withData = entries.filter((e) => e.hasData);
  if (withData.length === 0) return null;
  // Equals "sum / 7" when all seven days have data; days before tracking began are not counted as zeros.
  return withData.reduce((s, e) => s + (e.day ? e.day.visits : 0), 0) / withData.length;
}

/**
 * Mean placed visits per local clock hour over up to 28 complete days that have data
 * (days with a tracking gap are skipped: their hours would be undercounted).
 * @returns {{hours:number[], days:number, ready:boolean}}
 */
export function hourProfile(derived, now) {
  const nowS = toSec(now) ?? Math.floor(Date.now() / 1000);
  const sums = new Array(24).fill(0);
  let days = 0;
  for (const e of completeDays(derived, 28, nowS)) {
    if (!e.hasData || (e.day && e.day.partial)) continue;
    days++;
    const hrs = derived.hours && derived.hours[e.key];
    if (hrs) for (let h = 0; h < 24; h++) sums[h] += hrs[h];
  }
  return { hours: sums.map((s) => (days ? s / days : 0)), days, ready: days >= 7 };
}

/**
 * @returns {{avg7:number|null, prev7:number|null, median14:number|null, lastVisitT:number|null}}
 */
export function stats(derived, now) {
  const nowS = toSec(now) ?? Math.floor(Date.now() / 1000);
  const c = completeDays(derived, 21, nowS); // newest first: [0..6] last 7, [7..13] previous 7, [0..13] last 14
  const avg7 = meanVisits(c.slice(0, 7));
  const prev7 = meanVisits(c.slice(7, 14));
  const last14 = c.slice(0, 14).filter((e) => e.hasData).map((e) => (e.day ? e.day.visits : 0));
  const median14 = last14.length >= 7 ? median(last14) : null;
  let lastVisitT = null;
  const windows = (derived && derived.windows) || [];
  for (let i = windows.length - 1; i >= 0; i--) {
    if (windows[i].d > 0) {
      lastVisitT = windows[i].end;
      break;
    }
  }
  return { avg7, prev7, median14, lastVisitT };
}

/**
 * Newest-first events, merging the phone's own "You started a clean" records.
 * @param {object} derived
 * @param {({t:number,type?:string}|number)[]} appCleans
 * @param {number} n limit
 */
export function recentEvents(derived, appCleans, n = 20) {
  const own = ((derived && derived.events) || []).slice();
  for (const c of Array.isArray(appCleans) ? appCleans : []) {
    const t = typeof c === 'number' ? c : num(c && c.t);
    if (t !== null) own.push({ t, type: 'appClean' });
  }
  own.sort((a, b) => b.t - a.t);
  return own.slice(0, n);
}

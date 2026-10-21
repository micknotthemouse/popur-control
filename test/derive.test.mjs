// Run: node --test test/derive.test.mjs
// TZ must be set before derive.js is first used; a dynamic import keeps that order explicit.
process.env.TZ = 'America/New_York';

import test from 'node:test';
import assert from 'node:assert/strict';

const { derive, todayCount, dailySeries, hourProfile, stats, recentEvents } = await import('../docs/lib/derive.js');

// Unix seconds for a LOCAL wall-clock time.
const local = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime() / 1000;
const line = (t, w, extra = {}) => ({ t, pv: null, w, lw: null, r: 0, bf: 0, on: 1, m: 0, ...extra });
const visitsOn = (der, key) => (der.days[key] ? der.days[key].visits : 0);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !~ ${b}`);

test('plain deltas add up per window and per day', () => {
  const t0 = local(2026, 10, 14, 10, 0);
  const der = derive([
    line(t0, 1),
    line(t0 + 900, 2, { pv: t0 }),
    line(t0 + 1800, 4, { pv: t0 + 900 }),
  ], { now: t0 + 3600 });
  assert.deepEqual(der.windows.map((w) => w.d), [1, 2]);
  assert.equal(visitsOn(der, '2026-10-14'), 3);
  assert.equal(der.firstT, t0);
  assert.equal(der.lastLine.w, 4);
  assert.deepEqual(der.events.filter((e) => e.type === 'visit').map((e) => e.n), [1, 2]);
  assert.deepEqual(der.events.find((e) => e.type === 'visit').range, [t0, t0 + 900]);
});

test('counter reset counts b.w and flags the window', () => {
  const t0 = local(2026, 10, 14, 11, 50);
  const der = derive([line(t0, 5), line(t0 + 600, 2, { pv: t0 })], { now: t0 + 1000 });
  assert.equal(der.windows[0].d, 2);
  assert.equal(der.windows[0].reset, true);
  assert.equal(der.windows[0].lossy, false); // short window: nothing meaningful lost
});

test('reset inside a long window is flagged lossy', () => {
  const t0 = local(2026, 10, 14, 8, 0);
  const der = derive([line(t0, 5), line(t0 + 3000, 2)], { now: t0 + 4000 });
  assert.equal(der.windows[0].reset, true);
  assert.equal(der.days['2026-10-14'].lossy, true);
});

test('pv narrowing moves the visit to the day it really happened', () => {
  const a = line(local(2026, 10, 14, 22, 30), 3);
  const bT = local(2026, 10, 15, 0, 30);
  const wide = derive([a, line(bT, 4)]); // midpoint 23:30 on the 14th
  assert.equal(visitsOn(wide, '2026-10-14'), 1);
  assert.equal(visitsOn(wide, '2026-10-15'), 0);
  const narrow = derive([a, line(bT, 4, { pv: local(2026, 10, 15, 0, 20) })]); // midpoint 00:25 on the 15th
  assert.equal(visitsOn(narrow, '2026-10-14'), 0);
  assert.equal(visitsOn(narrow, '2026-10-15'), 1);
});

test('gap over 2 h emits a gap event and marks days partial; over 3 h places by end', () => {
  const t0 = local(2026, 10, 14, 10, 0);
  const mid = derive([line(t0, 1), line(t0 + 2.5 * 3600, 2)]); // 2.5 h: gap, still midpoint placement
  assert.equal(mid.windows[0].gap, true);
  assert.equal(mid.events.filter((e) => e.type === 'gap').length, 1);
  assert.equal(mid.days['2026-10-14'].partial, true);

  const long = derive([line(local(2026, 10, 14, 22, 0), 1), line(local(2026, 10, 15, 3, 0), 3)]);
  assert.equal(long.windows[0].gap, true);
  assert.equal(visitsOn(long, '2026-10-15'), 2); // local day of the end
  assert.equal(long.days['2026-10-15'].partial, true);
  assert.equal(long.days['2026-10-14'].partial, true); // touched by the gap
  assert.equal(long.hours['2026-10-15'], undefined); // not spread over hours

  const short = derive([line(t0, 1), line(t0 + 3600, 2)]);
  assert.equal(short.windows[0].gap, false);
  assert.equal(short.days['2026-10-14'].partial, false);
});

test('more than 20 cleans in one window is an anomaly worth 0', () => {
  const t0 = local(2026, 10, 14, 9, 0);
  const der = derive([line(t0, 1), line(t0 + 600, 30, { pv: t0 })]);
  assert.equal(der.windows[0].d, 0);
  assert.equal(der.windows[0].anomaly, true);
  assert.equal(der.days['2026-10-14'].lossy, true);
  const edge = derive([line(t0, 0), line(t0 + 600, 20, { pv: t0 })]);
  assert.equal(edge.windows[0].d, 20);
});

test('null w gives d=0 and never throws', () => {
  const t0 = local(2026, 10, 14, 9, 0);
  const der = derive([line(t0, null), line(t0 + 600, 3), line(t0 + 1200, null), line(t0 + 1800, 4)]);
  assert.deepEqual(der.windows.map((w) => w.d), [0, 0, 0]);
});

test('lifetime lwMode uses the lw delta', () => {
  const t0 = local(2026, 10, 14, 9, 0);
  const lines = [line(t0, 4, { lw: 100 }), line(t0 + 600, 4, { lw: 103, pv: t0 })];
  assert.equal(derive(lines).windows[0].d, 0);
  assert.equal(derive(lines, { lwMode: 'lifetime' }).windows[0].d, 3);
  // lw going backwards falls back to the w delta
  const back = [line(t0, 4, { lw: 100 }), line(t0 + 600, 6, { lw: 90, pv: t0 })];
  assert.equal(derive(back, { lwMode: 'lifetime' }).windows[0].d, 2);
  // same clamp applies
  const big = [line(t0, 4, { lw: 100 }), line(t0 + 600, 4, { lw: 150, pv: t0 })];
  const bigD = derive(big, { lwMode: 'lifetime' });
  assert.equal(bigD.windows[0].d, 0);
  assert.equal(bigD.windows[0].anomaly, true);
});

test('hour spreading across an hour boundary sums to d', () => {
  const a = local(2026, 10, 14, 10, 50);
  const b = local(2026, 10, 14, 11, 20);
  const der = derive([line(a, 1), line(b, 4, { pv: a })]);
  const h = der.hours['2026-10-14'];
  near(h[10], 1); // 10 of 30 minutes
  near(h[11], 2); // 20 of 30 minutes
  near(h.reduce((s, x) => s + x, 0), 3);
  assert.equal(visitsOn(der, '2026-10-14'), 3);
  // a window longer than 60 minutes is not placed on hours
  const wide = derive([line(a, 1), line(a + 5400, 2, { pv: a })]);
  assert.equal(wide.hours['2026-10-14'], undefined);
});

test('days and hours stay correct across the US fall-back DST change (2026-11-01)', () => {
  // 2026-11-01 has 25 hours in New York. 23:30 EST that night is 04:30Z next day.
  const night = Date.UTC(2026, 10, 2, 4, 30) / 1000; // 23:30 EST on Nov 1
  const early = Date.UTC(2026, 10, 1, 4, 30) / 1000; // 00:30 EDT on Nov 1
  assert.equal(new Date(night * 1000).getDate(), 1);
  assert.equal(new Date(early * 1000).getDate(), 1);
  const der = derive([
    line(early - 600, 0),
    line(early, 1, { pv: early - 600 }),
    line(night - 600, 1, { pv: night - 900 }),
    line(night, 2, { pv: night - 600 }),
    line(night + 3600, 3, { pv: night }), // 00:30 EST on Nov 2
  ], { now: night + 7200 });
  assert.equal(visitsOn(der, '2026-11-01'), 2);
  assert.equal(visitsOn(der, '2026-11-02'), 1);

  const series = dailySeries(der, 4, night + 7200).map((s) => s.date);
  assert.deepEqual(series, ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);

  // A window across the repeated 01:00 hour lands entirely in hour 1 (EDT 01:50 -> EST 01:20).
  const s = Date.UTC(2026, 10, 1, 5, 50) / 1000;
  const fb = derive([line(s - 600, 0), line(s + 1800, 2, { pv: s })]);
  near(fb.hours['2026-11-01'][1], 2);

  // Spring forward (2026-03-08): consecutive days, no duplicates or skips.
  const spring = derive([line(local(2026, 3, 7, 12), 0)]);
  const sd = dailySeries(spring, 3, local(2026, 3, 9, 12)).map((x) => x.date);
  assert.deepEqual(sd, ['2026-03-07', '2026-03-08', '2026-03-09']);
});

test('bin full flips raise events and mark the day', () => {
  const t0 = local(2026, 10, 14, 9, 0);
  const der = derive([
    line(t0, 1, { bf: 0 }),
    line(t0 + 900, 1, { bf: 1, r: 2, pv: t0 }),
    line(t0 + 1800, 1, { bf: 1, r: 2, pv: t0 + 900 }),
    line(t0 + 2700, 1, { bf: 0, pv: t0 + 1800 }),
    line(t0 + 3600, 1, { on: 0, pv: t0 + 2700 }),
    line(t0 + 4500, 1, { on: 1, m: 1, pv: t0 + 3600 }),
    line(t0 + 5400, 1, { on: 1, m: 0, pv: t0 + 4500 }),
  ]);
  const types = der.events.map((e) => e.type);
  assert.deepEqual(types, ['trackingStarted', 'binFull', 'binEmptied', 'offline', 'online', 'paused', 'resumed']);
  assert.equal(der.days['2026-10-14'].binFull, true);
  assert.equal(der.days['2026-10-14'].manual, true);
  const clean = derive([line(t0, 1), line(t0 + 900, 1, { pv: t0 })]);
  assert.equal(clean.days['2026-10-14'].binFull, false);
});

test('bin stays marked full on later days until the next line', () => {
  const full = line(local(2026, 10, 14, 20, 0), 1, { bf: 1, r: 2 });
  const der = derive([full], { now: local(2026, 10, 16, 9, 0) });
  const s = dailySeries(der, 3, local(2026, 10, 16, 9, 0));
  assert.deepEqual(s.map((x) => x.binFull), [true, true, true]);
});

test('todayCount tops up from a newer live reading', () => {
  const t0 = local(2026, 10, 14, 9, 0);
  const now = t0 + 3600;
  const der = derive([line(t0, 0), line(t0 + 900, 3, { pv: t0 })], { now });
  assert.deepEqual(todayCount(der, null, now), { n: 3, source: 'history' });
  assert.deepEqual(todayCount(der, { t: t0 + 1800, w: 5 }, now), { n: 5, source: 'history+live' });
  // live counter reset: count the new value as fresh cleans
  assert.equal(todayCount(der, { t: t0 + 1800, w: 1 }, now).n, 4);
  // live reading not newer than the last line: no top-up
  assert.equal(todayCount(der, { t: t0 + 900, w: 9 }, now).n, 3);
  // absurd jump is clamped to 20
  assert.equal(todayCount(der, { t: t0 + 1800, w: 99 }, now).n, 3 + 20);
  // milliseconds are accepted for now
  assert.equal(todayCount(der, null, now * 1000).n, 3);
});

test('todayCount with no history uses the box counter', () => {
  const now = local(2026, 10, 14, 12);
  const der = derive([], { now });
  assert.deepEqual(todayCount(der, { t: now, w: 4 }, now), { n: 4, source: 'box' });
  assert.deepEqual(todayCount(der, null, now), { n: 0, source: 'none' });
});

test('dailySeries marks noData before the first line and isToday', () => {
  const first = local(2026, 10, 12, 9, 0);
  const now = local(2026, 10, 14, 15, 0);
  const der = derive([line(first, 0), line(first + 600, 2, { pv: first })], { now });
  const s = dailySeries(der, 5, now);
  assert.deepEqual(s.map((x) => x.date), ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']);
  assert.deepEqual(s.map((x) => x.noData), [true, true, false, false, false]);
  assert.deepEqual(s.map((x) => x.isToday), [false, false, false, false, true]);
  assert.equal(s[2].visits, 2);
  assert.equal(s[3].visits, 0);
  assert.equal(s[2].label, 'Mon 12 Oct');
});

// 22 days of data: day i (0 = oldest) has k visits; today is day 21 (only the morning is known).
function synthetic() {
  const lines = [];
  const counts = [];
  for (let i = 0; i < 22; i++) {
    const k = (i % 5) + 1;
    counts.push(k);
    const t = local(2026, 9, 1 + i, 8, 0); // Sep 1 + i (Date rolls over months)
    lines.push(line(t, 0, { pv: t - 900 }));
    lines.push(line(t + 900, k, { pv: t }));
  }
  return { lines, counts, now: local(2026, 9, 22, 12, 0) };
}

test('stats on a synthetic 21-day series', () => {
  const { lines, counts, now } = synthetic();
  const der = derive(lines, { now });
  const st = stats(der, now);
  const last7 = counts.slice(14, 21); // days 14..20 are the 7 complete days before today
  const prev7 = counts.slice(7, 14);
  const last14 = counts.slice(7, 21).sort((a, b) => a - b);
  near(st.avg7, last7.reduce((a, b) => a + b, 0) / 7);
  near(st.prev7, prev7.reduce((a, b) => a + b, 0) / 7);
  near(st.median14, (last14[6] + last14[7]) / 2);
  assert.equal(st.lastVisitT, local(2026, 9, 22, 8, 15)); // today's visit
  // today is excluded from avg7
  assert.equal(dailySeries(der, 1, now)[0].visits, counts[21]);
});

test('stats with little data: median14 null, averages use only days with data', () => {
  const { lines, now } = synthetic();
  const der = derive(lines.slice(-8), { now }); // last 4 days (incl. today)
  const st = stats(der, now);
  assert.equal(st.median14, null);
  assert.ok(st.avg7 > 0);
  assert.equal(st.prev7, null);
});

test('hourProfile is ready after 7 data days and averages per hour', () => {
  const { lines, now } = synthetic();
  const der = derive(lines, { now });
  const p = hourProfile(der, now);
  assert.equal(p.ready, true);
  assert.equal(p.days, 21);
  assert.equal(p.hours.length, 24);
  // all visits happened in the 08:00-08:15 window, hour 8
  assert.ok(p.hours[8] > 0);
  near(p.hours.reduce((a, b) => a + b, 0) - p.hours[8], 0);
  const young = hourProfile(derive(lines.slice(-8), { now }), now);
  assert.equal(young.ready, false);
});

test('recentEvents merges app cleans newest first and limits', () => {
  const t0 = local(2026, 10, 14, 9, 0);
  const der = derive([line(t0, 0), line(t0 + 600, 1, { pv: t0 })]);
  const ev = recentEvents(der, [{ t: t0 + 700, type: 'appClean' }, { t: t0 + 100, type: 'appClean' }], 10);
  assert.deepEqual(ev.map((e) => e.type), ['appClean', 'visit', 'appClean', 'trackingStarted']);
  assert.equal(recentEvents(der, [], 1).length, 1);
  assert.deepEqual(recentEvents(der, null, 0), []);
});

test('empty and garbage input never throws and returns empties', () => {
  const now = local(2026, 10, 14, 12);
  for (const input of [[], null, undefined, [null, {}, { t: 'x' }]]) {
    const der = derive(input, { now });
    assert.deepEqual(der.windows, []);
    assert.deepEqual(der.events, []);
    assert.equal(der.firstT, null);
    assert.equal(der.lastLine, null);
    const s = dailySeries(der, 7, now);
    assert.equal(s.length, 7);
    assert.ok(s.every((x) => x.noData && x.visits === 0));
    assert.deepEqual(stats(der, now), { avg7: null, prev7: null, median14: null, lastVisitT: null });
    const hp = hourProfile(der, now);
    assert.equal(hp.ready, false);
    assert.equal(hp.hours.length, 24);
    assert.deepEqual(recentEvents(der, [], 5), []);
  }
  assert.doesNotThrow(() => derive([line(5, 1)]));
  assert.deepEqual(derive([line(local(2026, 10, 14, 9), 2)]).windows, []);
});

test('unsorted input is sorted and a trailing silence marks days partial', () => {
  const t0 = local(2026, 10, 14, 9, 0);
  const der = derive([line(t0 + 600, 2, { pv: t0 }), line(t0, 1)], { now: local(2026, 10, 15, 9, 0) });
  assert.equal(visitsOn(der, '2026-10-14'), 1);
  assert.equal(der.days['2026-10-14'].partial, true);
  assert.equal(der.days['2026-10-15'].partial, true);
});

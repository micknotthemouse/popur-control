// Accessible inline-SVG charts. No colours or style attributes are set here: the UI styles the
// classes below with CSS variables.
//   svg.chart, rect.chart-bar (.is-today .is-partial .is-nodata .is-selected), rect.chart-bar-hatch,
//   pattern > line.chart-hatch, circle.chart-binfull, text.chart-label, text.chart-value, line.chart-grid
// The DOM is only touched inside functions, so importing this module in Node is safe.

const SVG_NS = 'http://www.w3.org/2000/svg';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const HEIGHT = 176;
const MARGIN = { top: 30, right: 8, bottom: 26, left: 8 };
const MAX_BAR_W = 24; // dataviz spec: thin bars, air around them
const GAP = 2; // minimum surface gap between touching bars
const RADIUS = 4; // rounded data end, square at the baseline
const WEEK_VIEW_MAX = 10; // up to this many bars: weekday labels and value labels

let uid = 0;

// ---------- tiny DOM helpers ----------

function svgEl(doc, name, attrs, text) {
  const el = doc.createElementNS(SVG_NS, name);
  for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  if (text !== undefined) el.textContent = text;
  return el;
}

function htmlEl(doc, name, text) {
  const el = doc.createElement(name);
  if (text !== undefined) el.textContent = text;
  return el;
}

function parseDate(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function fullLabel(s) {
  if (s.label) return s.label;
  const dt = parseDate(s.date);
  return `${WEEKDAYS[dt.getDay()]} ${dt.getDate()} ${MONTHS[dt.getMonth()]}`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Round the top of the scale to a clean number so bars never touch the ceiling.
function niceMax(v) {
  if (v <= 4) return 4;
  if (v <= 10) return Math.ceil(v / 2) * 2;
  return Math.ceil(v / 5) * 5;
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

function hatchDefs(doc, hatchId, clipId, width, baselineY) {
  const defs = svgEl(doc, 'defs', {});
  const pat = svgEl(doc, 'pattern', {
    id: hatchId,
    patternUnits: 'userSpaceOnUse',
    width: 6,
    height: 6,
    patternTransform: 'rotate(45)',
  });
  pat.appendChild(svgEl(doc, 'line', { class: 'chart-hatch', x1: 0, y1: 0, x2: 0, y2: 6, 'stroke-width': 2 }));
  defs.appendChild(pat);
  const clip = svgEl(doc, 'clipPath', { id: clipId });
  clip.appendChild(svgEl(doc, 'rect', { x: 0, y: 0, width, height: baselineY }));
  defs.appendChild(clip);
  return defs;
}

// A bar is a rect extended RADIUS below the baseline and clipped there, so only the top is rounded.
function barRect(doc, cls, x, w, top, baselineY, clipId) {
  const h = baselineY - top;
  return svgEl(doc, 'rect', {
    class: cls,
    x: round1(x),
    y: round1(top),
    width: round1(w),
    height: round1(h + RADIUS),
    rx: Math.min(RADIUS, w / 2, Math.max(h, 1)),
    'clip-path': `url(#${clipId})`,
  });
}

function makeTable(doc, caption, headers, rows) {
  const table = htmlEl(doc, 'table');
  table.setAttribute('class', 'sr-only');
  table.appendChild(htmlEl(doc, 'caption', caption));
  const hr = htmlEl(doc, 'tr');
  for (const h of headers) {
    const th = htmlEl(doc, 'th', h);
    th.setAttribute('scope', 'col');
    hr.appendChild(th);
  }
  table.appendChild(htmlEl(doc, 'thead')).appendChild(hr);
  const tbody = htmlEl(doc, 'tbody');
  for (const row of rows) {
    const tr = htmlEl(doc, 'tr');
    row.forEach((cell, i) => {
      const td = htmlEl(doc, i === 0 ? 'th' : 'td', cell);
      if (i === 0) td.setAttribute('scope', 'row');
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function replaceChildren(host, nodes) {
  while (host.firstChild) host.removeChild(host.firstChild);
  for (const n of nodes) host.appendChild(n);
}

function hostWidth(host) {
  return Math.max(160, host.clientWidth || 340);
}

// ---------- daily bars ----------

function barLabel(s) {
  const base = s.noData ? `${fullLabel(s)}: no data` : `${fullLabel(s)}: ${plural(s.visits, 'visit', 'visits')}`;
  const notes = [];
  if (s.partial) notes.push('incomplete day');
  if (s.lossy) notes.push('count may be low');
  if (s.manual) notes.push('auto-clean paused');
  if (s.binFull) notes.push('bin full');
  return notes.length ? `${base} (${notes.join(', ')})` : base;
}

function summary(series) {
  const days = series.filter((s) => !s.noData);
  if (days.length === 0) return `Visits per day, last ${series.length} days: no data yet.`;
  const total = days.reduce((a, s) => a + s.visits, 0);
  const top = days.reduce((a, s) => (s.visits > a.visits ? s : a), days[0]);
  const peak = top.visits > 0 ? ` Busiest day ${fullLabel(top)} with ${plural(top.visits, 'visit', 'visits')}.` : '';
  const full = days.filter((s) => s.binFull).length;
  const bin = full ? ` Bin was full on ${plural(full, 'day', 'days')}.` : '';
  return `Visits per day, last ${series.length} days: ${plural(total, 'visit', 'visits')} in total.${peak}${bin}`;
}

function xLabel(s, i, n, weekView) {
  const dt = parseDate(s.date);
  if (weekView) return WEEKDAYS[dt.getDay()];
  // Long view: day of month for today and every 5th day back from today, so labels never collide.
  return (n - 1 - i) % 5 === 0 ? String(dt.getDate()) : '';
}

/**
 * @param {Element} host
 * @param {{date:string,label?:string,visits:number,partial?:boolean,lossy?:boolean,manual?:boolean,
 *          binFull?:boolean,noData?:boolean,isToday?:boolean}[]} series oldest first
 * @param {{onSelect?:(date:string)=>void, selected?:string}} [opts]
 */
export function renderBars(host, series, opts = {}) {
  const doc = host.ownerDocument;
  const onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : null;
  const n = series.length;
  const W = hostWidth(host);
  const id = `c${++uid}`;
  const hatchId = `${id}-hatch`;
  const clipId = `${id}-clip`;
  const baselineY = HEIGHT - MARGIN.bottom;
  const plotH = baselineY - MARGIN.top;
  const innerW = W - MARGIN.left - MARGIN.right;
  const slot = n ? innerW / n : innerW;
  const barW = Math.max(2, Math.min(MAX_BAR_W, slot - GAP));
  const weekView = n <= WEEK_VIEW_MAX;
  const max = niceMax(series.reduce((a, s) => Math.max(a, s.noData ? 0 : s.visits), 0));

  const svg = svgEl(doc, 'svg', {
    class: 'chart',
    role: 'img',
    'aria-label': summary(series),
    viewBox: `0 0 ${W} ${HEIGHT}`,
    width: W,
    height: HEIGHT,
  });
  svg.appendChild(hatchDefs(doc, hatchId, clipId, W, baselineY));
  svg.appendChild(svgEl(doc, 'line', { class: 'chart-grid', x1: 0, y1: baselineY, x2: W, y2: baselineY }));

  const bars = [];
  series.forEach((s, i) => {
    const cx = MARGIN.left + slot * i + slot / 2;
    const x = cx - barW / 2;
    const h = s.noData || s.visits <= 0 ? 2 : Math.max(2, (s.visits / max) * plotH);
    const top = baselineY - h;

    const g = svgEl(doc, 'g', { role: 'button', tabindex: 0, 'aria-label': barLabel(s), 'data-date': s.date });
    // Transparent target, wider and taller than the bar.
    g.appendChild(svgEl(doc, 'rect', {
      x: round1(cx - slot / 2), y: 0, width: round1(slot), height: baselineY, fill: 'none', 'pointer-events': 'all',
    }));

    let cls = 'chart-bar';
    if (s.isToday) cls += ' is-today';
    if (s.partial || s.lossy || s.manual) cls += ' is-partial';
    if (s.noData) cls += ' is-nodata';
    if (opts.selected && opts.selected === s.date) cls += ' is-selected';
    const bar = barRect(doc, cls, x, barW, top, baselineY, clipId);
    g.appendChild(bar);
    bars.push({ bar, date: s.date });

    if (!s.noData && (s.partial || s.lossy || s.manual) && s.visits > 0) {
      const hatch = barRect(doc, 'chart-bar-hatch', x, barW, top, baselineY, clipId);
      hatch.setAttribute('fill', `url(#${hatchId})`);
      hatch.setAttribute('pointer-events', 'none');
      g.appendChild(hatch);
    }
    if (!s.noData && s.binFull) {
      g.appendChild(svgEl(doc, 'circle', { class: 'chart-binfull', cx: round1(cx), cy: 8, r: 4 }));
    }
    if (weekView && !s.noData && s.visits > 0) {
      g.appendChild(svgEl(doc, 'text', {
        class: 'chart-value', x: round1(cx), y: round1(top - 5), 'text-anchor': 'middle',
      }, String(s.visits)));
    }
    const label = xLabel(s, i, n, weekView);
    if (label) {
      g.appendChild(svgEl(doc, 'text', {
        class: 'chart-label', x: round1(cx), y: baselineY + 16, 'text-anchor': 'middle',
      }, label));
    }

    const select = () => {
      for (const b of bars) b.bar.classList.toggle('is-selected', b.date === s.date);
      if (onSelect) onSelect(s.date);
    };
    g.addEventListener('click', select);
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        select();
      }
    });
    svg.appendChild(g);
  });

  const rows = series.map((s) => {
    const notes = [];
    if (s.partial) notes.push('incomplete');
    if (s.lossy) notes.push('count may be low');
    if (s.manual) notes.push('auto-clean paused');
    if (s.binFull) notes.push('bin full');
    return [fullLabel(s), s.noData ? 'no data' : String(s.visits), notes.join(', ')];
  });
  const table = makeTable(doc, `Visits per day, last ${n} days`, ['Day', 'Visits', 'Notes'], rows);
  replaceChildren(host, [svg, table]);
}

// ---------- typical times ----------

const HOUR_TICKS = { 0: '00', 6: '06', 12: '12', 18: '18' };

const hh = (h) => `${String(h).padStart(2, '0')}:00`;

/**
 * @param {Element} host
 * @param {{hours:number[], days:number, ready:boolean}} profile mean placed visits per local hour
 */
export function renderHours(host, profile) {
  const doc = host.ownerDocument;
  const hours = profile && Array.isArray(profile.hours) && profile.hours.length === 24 ? profile.hours : new Array(24).fill(0);
  const ready = !!(profile && profile.ready);
  const days = (profile && profile.days) || 0;
  const W = hostWidth(host);
  const id = `c${++uid}`;
  const clipId = `${id}-clip`;
  const baselineY = HEIGHT - MARGIN.bottom;
  const plotH = baselineY - 14;
  const slot = (W - MARGIN.left - MARGIN.right) / 24;
  const barW = Math.max(2, Math.min(MAX_BAR_W, slot - GAP));
  const max = Math.max(0.5, ...hours);

  let aria;
  if (!ready) {
    aria = `Typical visit times: not enough data yet (${plural(days, 'day', 'days')} so far, a week is needed).`;
  } else {
    const peak = hours.indexOf(Math.max(...hours));
    aria = Math.max(...hours) > 0
      ? `Typical visit times by hour, over ${plural(days, 'day', 'days')}. Busiest around ${hh(peak)} with ${hours[peak].toFixed(1)} visits per day on average.`
      : `Typical visit times by hour, over ${plural(days, 'day', 'days')}: no visits recorded.`;
  }

  const svg = svgEl(doc, 'svg', {
    class: 'chart', role: 'img', 'aria-label': aria, viewBox: `0 0 ${W} ${HEIGHT}`, width: W, height: HEIGHT,
  });
  const defs = svgEl(doc, 'defs', {});
  const clip = svgEl(doc, 'clipPath', { id: clipId });
  clip.appendChild(svgEl(doc, 'rect', { x: 0, y: 0, width: W, height: baselineY }));
  defs.appendChild(clip);
  svg.appendChild(defs);
  svg.appendChild(svgEl(doc, 'line', { class: 'chart-grid', x1: 0, y1: baselineY, x2: W, y2: baselineY }));

  for (let h = 0; h < 24; h++) {
    const cx = MARGIN.left + slot * h + slot / 2;
    if (ready && hours[h] > 0) {
      const top = baselineY - Math.max(2, (hours[h] / max) * plotH);
      svg.appendChild(barRect(doc, 'chart-bar', cx - barW / 2, barW, top, baselineY, clipId));
    }
    if (HOUR_TICKS[h]) {
      svg.appendChild(svgEl(doc, 'text', {
        class: 'chart-label', x: round1(cx), y: baselineY + 16, 'text-anchor': 'middle',
      }, HOUR_TICKS[h]));
    }
  }

  const rows = hours.map((v, h) => [hh(h), ready ? (Math.round(v * 100) / 100).toFixed(2) : 'not enough data']);
  const table = makeTable(doc, 'Average visits per day by hour of day', ['Hour', 'Visits per day'], rows);
  replaceChildren(host, [svg, table]);
}

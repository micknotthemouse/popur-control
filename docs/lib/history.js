// Loads collector output from the public "data" branch.
async function fetchText(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('history http ' + r.status);
  return r.text();
}

export function parseNdjson(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') out.push(o);
    } catch { /* skip bad line */ }
  }
  return out;
}

function monthKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function loadStatus(dataBase) {
  const t = await fetchText(`${dataBase}status/gha.json?t=${Date.now()}`);
  if (t === null) return null;
  try { return JSON.parse(t); } catch { return null; }
}

// now: unix milliseconds (defaults to Date.now()).
export async function loadHistory({ dataBase, dk, now }) {
  const ms = now ?? Date.now();
  const cur = new Date(ms);
  const prev = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() - 1, 1));
  const [status, curText, prevText] = await Promise.all([
    loadStatus(dataBase),
    fetchText(`${dataBase}history/${dk}/${monthKey(cur)}.ndjson?t=${ms}`),
    fetchText(`${dataBase}history/${dk}/${monthKey(prev)}.ndjson`),
  ]);
  const lines = parseNdjson(prevText).concat(parseNdjson(curText));
  lines.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  return { status, lines, notSetUp: status === null };
}

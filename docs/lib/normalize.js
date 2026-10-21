// Normalisation of Popur API payloads. Pure functions, no DOM.
export const SENSITIVE_KEY_RE = /id|mac|ip|ssid|sn|serial|name|mail|user|home|token|key|pass|wifi|lat|lon|addr|ver|time|tz|zone|region|lang|country|code/i;

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function flag(v) {
  if (v === null || v === undefined) return null;
  return String(v) === '1' ? 1 : 0;
}

// -> {w: worknum, lw: lastworknum, r: rubbish, on: isonline, m: manualmode}
export function normalizeInfo(data) {
  const d = data && typeof data === 'object' ? data : {};
  return { w: num(d.worknum), lw: num(d.lastworknum), r: num(d.rubbish), on: flag(d.isonline), m: flag(d.manualmode) };
}

const LIST_KEYS = ['devicelist', 'devices', 'deviceList', 'list'];

export function parseDevices(homeData) {
  const d = homeData && typeof homeData === 'object' ? homeData : {};
  let list = null;
  for (const k of LIST_KEYS) if (Array.isArray(d[k])) { list = d[k]; break; }
  if (!list) return [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = item.devid ?? item._id ?? item.did;
    if (id === undefined || id === null || id === '') continue;
    out.push({
      devid: String(id),
      name: String(item.name ?? item.nickname ?? ''),
      model: String(item.model ?? ''),
    });
  }
  return out;
}

// 2 = full (every known client); any other finite number = ok; else unclear.
export function binState(r) {
  if (r === null || r === undefined || r === '') return 'unclear';
  const n = Number(r);
  if (!Number.isFinite(n)) return 'unclear';
  return n === 2 ? 'full' : 'ok';
}

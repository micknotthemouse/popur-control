// localStorage wrapper: JSON values, "popurctl:" prefix, errors swallowed.
const P = 'popurctl:';

export function get(key, fallback = null) {
  try {
    const raw = globalThis.localStorage.getItem(P + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}
export function set(key, val) {
  try { globalThis.localStorage.setItem(P + key, JSON.stringify(val)); return true; } catch { return false; }
}
export function del(key) {
  try { globalThis.localStorage.removeItem(P + key); } catch { /* ignore */ }
}
// Append item to an array value, keeping only the newest `max`.
export function pushCapped(key, item, max) {
  const arr = get(key, []);
  const next = (Array.isArray(arr) ? arr : []).concat([item]).slice(-max);
  set(key, next);
  return next;
}

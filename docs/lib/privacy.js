import { SENSITIVE_KEY_RE } from './normalize.js';

const enc = new TextEncoder();
function hex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Stable, non-reversible 12-hex key for a user+device pair (used as a public folder name).
export async function deviceKey(email, devid) {
  const s = `popur-control:v1:${String(email).trim().toLowerCase()}:${devid}`;
  const h = await globalThis.crypto.subtle.digest('SHA-256', enc.encode(s));
  return hex(h).slice(0, 12);
}

// Deep copy with sensitive keys / secret values replaced by a mask.
export function redact(obj, secretValues = []) {
  const secrets = new Set(secretValues.filter((v) => v !== null && v !== undefined && v !== '').map(String));
  const walk = (v, key) => {
    if (key !== undefined && SENSITIVE_KEY_RE.test(key)) return '•••';
    if (v !== null && typeof v === 'object') {
      if (Array.isArray(v)) return v.map((x) => walk(x));
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k], k);
      return o;
    }
    if (secrets.has(String(v))) return '•••';
    return v;
  };
  return walk(obj);
}

export function maskEmail(e) {
  const s = String(e || '');
  const at = s.indexOf('@');
  if (at < 1) return s ? '•••' : '';
  return s[0] + '•••' + s.slice(at);
}

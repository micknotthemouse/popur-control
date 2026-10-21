// Encrypted Popur session cache stored on the (public) data branch.
// AES-256-GCM, key = hex-decoded POPUR_CACHE_KEY secret. File = base64(iv | tag | ciphertext).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SESSION_FILE = 'session/gha.bin';
const AAD = Buffer.from('popur-control:session:v1');

export function isValidCacheKey(hex) {
  return typeof hex === 'string' && /^[0-9a-fA-F]{64}$/.test(hex);
}

export function encryptSession(keyHex, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

// Returns the object, or null on any problem (wrong key, tampered, malformed).
export function decryptSession(keyHex, b64) {
  try {
    const buf = Buffer.from(String(b64).trim(), 'base64');
    if (buf.length < 12 + 16 + 2) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), buf.subarray(0, 12));
    d.setAAD(AAD);
    d.setAuthTag(buf.subarray(12, 28));
    const pt = Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    const o = JSON.parse(pt);
    return o && typeof o.token === 'string' && o.token ? o : null;
  } catch {
    return null;
  }
}

export function loadSession(store, keyHex) {
  try {
    return decryptSession(keyHex, fs.readFileSync(path.join(store, SESSION_FILE), 'utf8'));
  } catch {
    return null;
  }
}

export function saveSession(store, keyHex, obj) {
  const file = path.join(store, SESSION_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encryptSession(keyHex, obj) + '\n');
}

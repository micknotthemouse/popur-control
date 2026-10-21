// Receives the setup code from the web app ("POPUR1.<base64url>", RSA-OAEP SHA-256), then stores the
// Popur login hash as GitHub Actions secrets and starts the collector. Prints only names and statuses.
// Usage: node tools/receive-handoff.mjs <code> [--dry-run] [--repo owner/name]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REPO, secretNames, setSecret, dispatch } from './gh.mjs';
import { maskEmail } from '../docs/lib/privacy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_AGE_S = 7 * 86400;
const SKEW_S = 300;

export function defaultKeyPath() {
  return process.env.HANDOFF_KEY_PATH || path.join(HERE, '..', 'secrets', 'handoff-private.pem');
}

// Decrypts and validates a setup code. Throws Error with a plain message; never echoes content.
export function decryptCode(code, { keyPath = defaultKeyPath(), now = Math.floor(Date.now() / 1000) } = {}) {
  const clean = String(code || '').replace(/\s+/g, '');
  if (!clean.startsWith('POPUR1.')) throw new Error('not a POPUR1 setup code');
  const b64 = clean.slice(7).replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error('setup code is malformed');
  let plain;
  try {
    plain = crypto.privateDecrypt(
      { key: fs.readFileSync(keyPath), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(b64, 'base64'),
    );
  } catch {
    throw new Error('could not decrypt the setup code with the handoff key');
  }
  let p;
  try { p = JSON.parse(plain.toString('utf8')); } catch { throw new Error('setup code payload is not JSON'); }
  if (!p || p.v !== 1) throw new Error('unsupported setup code version');
  if (typeof p.e !== 'string' || !p.e.includes('@')) throw new Error('setup code has no email');
  if (typeof p.h !== 'string' || !/^[0-9a-f]{32}$/i.test(p.h)) throw new Error('setup code has no valid hash');
  if (!Number.isFinite(p.t)) throw new Error('setup code has no timestamp');
  const age = now - p.t;
  if (age > MAX_AGE_S) throw new Error('setup code is older than 7 days; make a new one in the app');
  if (age < -SKEW_S) throw new Error('setup code is dated in the future');
  return { e: p.e.trim(), h: p.h.toLowerCase(), t: p.t, ageS: age };
}

// opts: { dryRun, repo, keyPath, now, log } plus { token, apiBase } for offline tests.
export async function receiveHandoff(code, opts = {}) {
  const log = opts.log || ((s) => console.log(s));
  const repo = opts.repo || DEFAULT_REPO;
  const net = { token: opts.token, apiBase: opts.apiBase };
  const p = decryptCode(code, opts);
  if (opts.dryRun) {
    log('dry run: decrypted and validated');
    log('fields: v, e, h, t');
    log(`email: ${maskEmail(p.e)}`);
    log(`age: ${Math.round(p.ageS / 60)} min`);
    return { dryRun: true, set: [] };
  }
  const existing = await secretNames(repo, net);
  const set = [];
  for (const [name, value] of [['POPUR_EMAIL', p.e], ['POPUR_PASSWORD_MD5', p.h]]) {
    const s = await setSecret(repo, name, value, net);
    log(`secret ${name}: HTTP ${s}`);
    set.push(name);
  }
  if (existing.includes('POPUR_CACHE_KEY')) {
    log('secret POPUR_CACHE_KEY: kept (already set)');
  } else {
    const s = await setSecret(repo, 'POPUR_CACHE_KEY', crypto.randomBytes(32).toString('hex'), net);
    log(`secret POPUR_CACHE_KEY: HTTP ${s}`);
    set.push('POPUR_CACHE_KEY');
  }
  const d = await dispatch(repo, 'collect.yml', 'main', net);
  log(`dispatch collect.yml: HTTP ${d}`);
  if (d !== 204) throw new Error(`dispatch failed (HTTP ${d})`);
  return { dryRun: false, set };
}

async function cli(argv) {
  const args = [...argv];
  const dryRun = args.includes('--dry-run');
  const ri = args.indexOf('--repo');
  const repo = ri >= 0 ? args[ri + 1] : undefined;
  const code = args.find((a, i) => !a.startsWith('--') && (ri < 0 || i !== ri + 1));
  if (!code) {
    console.log('usage: node tools/receive-handoff.mjs <code> [--dry-run] [--repo owner/name]');
    process.exitCode = 1;
    return;
  }
  try {
    await receiveHandoff(code, { dryRun, repo });
  } catch (e) {
    console.log(`error: ${e && e.message ? e.message : 'failed'}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await cli(process.argv.slice(2));

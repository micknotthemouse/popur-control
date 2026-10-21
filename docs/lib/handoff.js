// Builds the encrypted setup code the user pastes to Claude (RSA-OAEP, SHA-256).
function b64ToBytes(b64) {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function makeSetupCode(email, md5, spkiB64, nowSec) {
  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey('spki', b64ToBytes(spkiB64), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const msg = new TextEncoder().encode(JSON.stringify({ v: 1, e: email, h: md5, t: nowSec }));
  const ct = await subtle.encrypt({ name: 'RSA-OAEP' }, key, msg);
  return 'POPUR1.' + bytesToB64url(new Uint8Array(ct));
}

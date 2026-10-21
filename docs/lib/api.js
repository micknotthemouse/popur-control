// Popur cloud REST client. Works in browsers and Node 24 (global fetch).
import { normalizeInfo, parseDevices } from './normalize.js';

const TIMEOUT_MS = 15000;

export class ApiError extends Error {
  // kind: 'auth' | 'login' | 'network' | 'http' | 'shape'
  constructor(kind, { status = null, code = null, message } = {}) {
    super(message || kind);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

export class PopurApi {
  constructor({ base, fetchImpl } = {}) {
    this.base = String(base || '').replace(/\/+$/, '');
    this.token = null;
    this.homeId = null;
    this.userId = null;
    this._fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  }

  async _request(path, init = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await this._fetch(this.base + path, { ...init, signal: ctl.signal });
    } catch {
      throw new ApiError('network', { message: 'network' });
    } finally {
      clearTimeout(timer);
    }
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON body */ }
    return { res, body };
  }

  async login(email, md5) {
    const { res, body } = await this._request('/uapi/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ param: email, password: md5, type: '2' }),
    });
    const code = body && body.code !== undefined ? body.code : null;
    if (!res.ok && code === null) throw new ApiError('http', { status: res.status });
    if (code !== 200) throw new ApiError('login', { status: res.status, code });
    const d = body.data;
    if (!d || !d.token || !d.user) throw new ApiError('shape', { status: res.status, code });
    this.token = d.token;
    this.homeId = d.user.defaulthomeid ?? null;
    this.userId = d.user._id ?? null;
    return { token: this.token, homeId: this.homeId, userId: this.userId };
  }

  // Authenticated GET; returns body.data.
  async _get(path) {
    const { res, body } = await this._request(path, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + this.token },
    });
    const code = body && body.code !== undefined ? body.code : null;
    if (res.status === 401 || code === 401 || code === 20001) {
      throw new ApiError('auth', { status: res.status, code });
    }
    if (!res.ok) throw new ApiError('http', { status: res.status, code });
    if (code !== null && code !== 200) throw new ApiError('http', { status: res.status, code });
    if (!body || body.data === undefined || body.data === null) {
      throw new ApiError('shape', { status: res.status, code });
    }
    return body.data;
  }

  async homeDetails() {
    if (!this.homeId) throw new ApiError('shape', { message: 'no homeId' });
    const raw = await this._get('/uapi/home_details/' + encodeURIComponent(this.homeId));
    return { devices: parseDevices(raw), raw };
  }

  async deviceInfo(devid) {
    const raw = await this._get('/uapi/deviceinfo/info/' + encodeURIComponent(devid));
    return { reading: normalizeInfo(raw), raw, t: Math.floor(Date.now() / 1000) };
  }

  async user() {
    return this._get('/uapi/user');
  }
}

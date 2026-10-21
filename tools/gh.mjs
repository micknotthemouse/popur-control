// Laptop-only GitHub helper (module + CLI). Never prints tokens or secret values.
// Run `npm install` in this folder once (libsodium-wrappers).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sodium from 'libsodium-wrappers';

export const OWNER = 'micknotthemouse';
export const DEFAULT_REPO = `${OWNER}/popur-control`;
const API = 'https://api.github.com';

// Token from the Windows git credential manager. Silent: no prompts, never printed.
export function getToken() {
  const r = spawnSync('git', ['credential', 'fill'], {
    input: `protocol=https\nhost=github.com\nusername=${OWNER}\n\n`,
    encoding: 'utf8',
    env: { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' },
  });
  const m = /^password=(.+)$/m.exec(r.stdout || '');
  if (r.status !== 0 || !m) throw new Error('no GitHub credential available from git credential manager');
  return m[1].trim();
}

let cachedToken = null;

// Returns { status, data, headers }. Options { token, apiBase } exist for offline tests.
export async function api(method, apiPath, body, { token, apiBase } = {}) {
  const t = token || (cachedToken ||= getToken());
  const res = await fetch((apiBase || API) + apiPath, {
    method,
    headers: {
      Authorization: 'Bearer ' + t,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'popur-control-tools',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { status: res.status, data, headers: res.headers };
}

// Encrypts `value` for a GitHub repo public key (base64) as a libsodium sealed box; returns base64.
export async function sealBox(publicKeyB64, value) {
  await sodium.ready;
  const v = sodium.base64_variants.ORIGINAL;
  const pk = sodium.from_base64(publicKeyB64, v);
  return sodium.to_base64(sodium.crypto_box_seal(sodium.from_string(String(value)), pk), v);
}

// Sets an Actions secret. Returns the HTTP status (201 created, 204 updated).
export async function setSecret(repo, name, value, opts) {
  const pk = await api('GET', `/repos/${repo}/actions/secrets/public-key`, undefined, opts);
  if (pk.status !== 200 || !pk.data || !pk.data.key) throw new Error(`public-key HTTP ${pk.status}`);
  const encrypted_value = await sealBox(pk.data.key, value);
  const put = await api('PUT', `/repos/${repo}/actions/secrets/${name}`, { encrypted_value, key_id: pk.data.key_id }, opts);
  if (put.status !== 201 && put.status !== 204) throw new Error(`set secret ${name} HTTP ${put.status}`);
  return put.status;
}

export async function secretNames(repo, opts) {
  const r = await api('GET', `/repos/${repo}/actions/secrets?per_page=100`, undefined, opts);
  if (r.status !== 200) throw new Error(`secret-names HTTP ${r.status}`);
  return (r.data.secrets || []).map((s) => s.name);
}

export async function dispatch(repo, workflow, ref = 'main', opts) {
  const r = await api('POST', `/repos/${repo}/actions/workflows/${workflow}/dispatches`, { ref }, opts);
  return r.status; // 204 on success
}

// ---------------------------------------------------------------- CLI

const fullRepo = (r) => (r.includes('/') ? r : `${OWNER}/${r}`);

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  args.splice(i, v === undefined || v.startsWith('--') ? 1 : 2);
  return v === undefined || v.startsWith('--') ? true : v;
}

const out = (s) => console.log(s);
const fail = (what, r) => { out(`${what}: HTTP ${r.status}${r.data && r.data.message ? ' - ' + r.data.message : ''}`); process.exitCode = 1; };

const COMMANDS = {
  async whoami() {
    const r = await api('GET', '/user');
    if (r.status !== 200) return fail('whoami', r);
    out(`login: ${r.data.login}`);
    out(`scopes: ${r.headers.get('x-oauth-scopes') || '(none reported)'}`);
  },
  async 'create-repo'(args) {
    const pub = flag(args, '--public');
    const description = flag(args, '--description');
    const name = args[0];
    if (!name) throw new Error('usage: create-repo <name> --public --description <text>');
    const r = await api('POST', '/user/repos', { name, private: !pub, description: typeof description === 'string' ? description : '' });
    if (r.status !== 201) return fail('create-repo', r);
    out(`created: ${r.data.full_name} (${r.data.private ? 'private' : 'public'})`);
    out(r.data.html_url);
  },
  async 'enable-pages'(args) {
    const repo = fullRepo(args[0] || DEFAULT_REPO);
    const r = await api('POST', `/repos/${repo}/pages`, { source: { branch: 'main', path: '/docs' } });
    if (r.status === 201) out('pages: enabled');
    else if (r.status === 409) out('pages: already enabled (409)');
    else fail('enable-pages', r);
  },
  async 'pages-status'(args) {
    const repo = fullRepo(args[0] || DEFAULT_REPO);
    const r = await api('GET', `/repos/${repo}/pages`);
    if (r.status !== 200) return fail('pages-status', r);
    const d = r.data;
    out(`status: ${d.status}`);
    out(`url: ${d.html_url}`);
    out(`source: ${d.source && d.source.branch}${d.source && d.source.path}`);
  },
  async 'secret-names'(args) {
    const repo = fullRepo(args[0] || DEFAULT_REPO);
    out((await secretNames(repo)).join('\n') || '(none)');
  },
  async dispatch(args) {
    const [repo, wf, ref] = args;
    if (!repo || !wf) throw new Error('usage: dispatch <repo> <workflow file> [ref]');
    const s = await dispatch(fullRepo(repo), wf, ref || 'main');
    out(`dispatch: HTTP ${s}`);
    if (s !== 204) process.exitCode = 1;
  },
  async runs(args) {
    const repo = fullRepo(args[0] || DEFAULT_REPO);
    const n = Math.min(Math.max(Number(args[1]) || 5, 1), 30);
    const r = await api('GET', `/repos/${repo}/actions/runs?per_page=${n}`);
    if (r.status !== 200) return fail('runs', r);
    for (const run of r.data.workflow_runs || []) {
      out(`${run.status}\t${run.conclusion || '-'}\t${run.created_at}\t${run.html_url}`);
    }
    if (!(r.data.workflow_runs || []).length) out('(no runs)');
  },
  async 'workflow-state'(args) {
    const [repo, wf] = args;
    if (!repo || !wf) throw new Error('usage: workflow-state <repo> <file>');
    const r = await api('GET', `/repos/${fullRepo(repo)}/actions/workflows/${wf}`);
    if (r.status !== 200) return fail('workflow-state', r);
    out(`state: ${r.data.state}`);
  },
  async 'enable-workflow'(args) {
    const [repo, wf] = args;
    if (!repo || !wf) throw new Error('usage: enable-workflow <repo> <file>');
    const r = await api('PUT', `/repos/${fullRepo(repo)}/actions/workflows/${wf}/enable`);
    out(`enable-workflow: HTTP ${r.status}`);
    if (r.status !== 204) process.exitCode = 1;
  },
};

async function cli(argv) {
  const [cmd, ...args] = argv;
  const fn = COMMANDS[cmd];
  if (!fn) {
    out(`usage: node tools/gh.mjs <${Object.keys(COMMANDS).join('|')}> ...`);
    process.exitCode = 1;
    return;
  }
  try {
    await fn(args);
  } catch (e) {
    out(`error: ${e && e.message ? e.message : 'failed'}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await cli(process.argv.slice(2));

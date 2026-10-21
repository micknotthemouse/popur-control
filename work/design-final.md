# Final design for v1 (authoritative, 2026-10-20)

Read order: this file first, then `work/design-merged.md` for the detail it points to. **This file wins on any conflict.** `work/design-skeptic.md` explains why each change below was made. The API ground truth is `research/popur-api-spec.md`.

## Decided facts
- Repo: `micknotthemouse/popur-control`, **public**. Pages serves from `main` `/docs` at https://micknotthemouse.github.io/popur-control/.
- Commit identity: `micknotthemouse <339443901+micknotthemouse@users.noreply.github.com>`. The collector commits as `github-actions[bot]`.
- The origin `micknotthemouse.github.io` is shared with two of the user's own sites, which load no third-party scripts. Prefix every localStorage key with `popurctl:`. "Keep me signed in" defaults ON.
- The Popur cloud REST API allows CORS `*` (measured). The browser calls it directly.
- Edge is installed at `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`. There is no Chrome and no Python. Node is 24 and npm is 11.

## Cut from v1 (do NOT build)
- Merging the page's local snapshots into history. The page computes a top-up for "today" only (see derive).
- Multi-source merging. There is one source, `gha`; keep the code generic but do not build `lap`.
- Learning `lastworknum` and the reset time in the collector. Store everything raw and use config constants: `LW_MODE=null` (ignore), `RESET_UTC_MIN=960`.
- Subtracting app-started cleans. Show "You started a clean" events only. They are stored locally on the phone.
- The weekday×hour heatmap. Contingency L (laptop collector) and P (laptop listener). The laptop keeper task.
- The collector's MQTT probe. The page learns subscribe support itself and shows it in Diagnostics.
- The "Learn my box" guided session and the in-page day-1 Yes/No checklist. The Diagnostics live log covers both.
- The `x` field whitelist in history lines. Unknown fields go only into `status.insights.fields` (key names) plus `insights.small` (latest integer values 0–999 of non-sensitive keys, using the blacklist regex from the merged design plus `tz|zone|region|lang|country|code`).

## Changed from the merged design
1. **Token cache is ON by default.** `POPUR_CACHE_KEY` is a random 32-byte hex secret that Claude sets. The collector uses AES-256-GCM with key = the hex-decoded CACHE_KEY to store `{token, homeId, t}` in `session/gha.bin` on the data branch (base64 of iv|tag|ct). It uses the cached token and logs in only on an auth failure (HTTP 401, or a body `code` of 401 or 20001, or `code != 200` on an authed call). With no CACHE_KEY it logs in every run. `insights.logins` keeps a count per UTC day for the last 14 days.
2. **The page detects being kicked out.** Count silent re-logins in localStorage over a rolling hour. At more than 3 per hour, stop re-logging in and show the state "Signed in somewhere else" with a "Sign in again" button.
3. **GitHub Actions.** Use the current majors of `actions/checkout` and `actions/setup-node` that run on Node 24 (Node 20 actions were removed from runners in Sept 2026). The builder checks the latest release tag via `https://api.github.com/repos/actions/checkout/releases/latest` and the same for setup-node, then pins the major. Set `node-version: 24`, `timeout-minutes: 5`, `permissions: {contents: write, actions: write}`, and concurrency group `collector` with `cancel-in-progress: false`. Cron is `7,22,37,52 * * * *`, plus `workflow_dispatch` with no inputs.
4. **Bin state wording (top priority).**
   - `binState(r)`: `Number(r)===2` → `full`; any other finite number → `ok`. This matches every known client; 0 and 1 are flagged "unverified" in Diagnostics until real data confirms them. `null`, missing or NaN → `unclear`.
   - The hero's age comes from the reading's own time: the live REST fetch time, or the collector's `pt`. It never comes from when the file was fetched.
   - Age ≤ 30 min: present tense ("Bin has room" or "Bin full – empty it").
   - Age > 30 min: "Last known: has room · 2 h ago".
   - Age > 6 h, or collector red with no live data: "Bin status unknown".
   - Full is always shown when the latest known reading is full, even when stale ("Bin was full · 3 h ago").
5. **Visit counting (single source).** For consecutive lines a→b (sorted by t):
   - `start=max(a.t, b.pv ?? a.t)`, `end=b.t`.
   - If `a.w` or `b.w` is null: `d=0`.
   - If `b.w<a.w`: `d=b.w`, flag `reset`.
   - Otherwise: `d=b.w−a.w`.
   - If `d>20`: `d=0`, flag `anomaly`.
   - If `LW_MODE==='lifetime'` and both lw are numbers with `b.lw≥a.lw`, use `d=b.lw−a.lw` instead (same clamp).
   - Day and hour placement and gaps (L>2 h) as in the merged design §3 step 7–9.
6. **Today top-up.** `todayCount = history visits for today + top`.
   - If a live reading exists with `live.t > last.t`: `top = live.w ≥ last.w ? live.w − last.w : live.w`, clamped 0..20.
   - With no history at all: "N cleanings so far today, from the box" (`live.w`).
7. **Exit codes.** Exit 1 on any push failure. Also exit 1 when `fails` reaches 8, and on every 96th failure after that. Otherwise exit 0. A top-level catch prints only the error class and `kind`. No response bodies, stacks or URLs with tokens are ever printed.
8. **Secrets missing.** If `POPUR_EMAIL` is missing, or both `POPUR_PASSWORD` and `POPUR_PASSWORD_MD5` are missing, write `run.err={kind:'setup'}` and commit once. If status already says setup, do not commit. Exit 0. The page shows "History tracking isn't set up yet" (distinct from "no history yet").
9. **Keepalive.** Once per 30 days (`status.keepalive.t`), the collector calls `PUT /repos/{GITHUB_REPOSITORY}/actions/workflows/collect.yml/enable` with `GITHUB_TOKEN`. It records the HTTP status only and ignores failure. When stale, the page shows "Tracking stopped – tap to turn it back on", linking to `https://github.com/micknotthemouse/popur-control/actions/workflows/collect.yml`.
10. **Setup handoff (taps only, no typing on GitHub).**
    - Settings → History tracking → "Turn on history tracking". The empty state in the Usage card offers the same.
    - The page needs the email and md5 of the signed-in user. If the md5 is not in memory or storage, it asks for the password once.
    - It encrypts `JSON.stringify({v:1,e:email,h:md5,t:unixSeconds})` with RSA-OAEP SHA-256 using `CONFIG.HANDOFF_SPKI` (base64 DER SPKI, contents of `work/handoff-public-spki.b64`).
    - It shows the code `POPUR1.<base64url>`, a big "Copy setup code" button, and the instruction "Paste this code into your chat with Claude. It's locked so only your laptop can open it."
    - Laptop side, `tools/receive-handoff.mjs <code>`:
      1. Decrypt with `secrets/handoff-private.pem`. Reject anything older than 7 days.
      2. Fetch the repo public key and set secrets `POPUR_EMAIL` and `POPUR_PASSWORD_MD5` using a libsodium sealed box (`libsodium-wrappers` from `tools/node_modules`). Also set `POPUR_CACHE_KEY` (random 32-byte hex) if it does not exist.
      3. Dispatch `collect.yml` on `main`.
      4. Print only the names of the secrets set and HTTP statuses.
    - The GitHub token comes from `git credential fill` (host github.com, username micknotthemouse) with `GCM_INTERACTIVE=never` and `GIT_TERMINAL_PROMPT=0`. It is never printed. Fallback: a deep link to `https://github.com/micknotthemouse/popur-control/settings/secrets/actions`.
11. **Manifest.** `start_url:"./"`, `scope:"./"`, `display:"standalone"`. Icon paths are relative.
12. **CSP.** Production meta: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://cloud.popur.com.cn wss://cloud.popur.com.cn https://raw.githubusercontent.com; base-uri 'none'; form-action 'none'`.
    - The mock server rewrites `connect-src` when serving `index.html` to add `http://localhost:8787 ws://localhost:8787`.
    - Never use inline `style=` attributes or `setAttribute('style')`. Use classes, SVG presentation attributes, or CSSOM (`el.style.height=…`, which CSP allows).
13. **Collector privacy.** Mask derived values (`::add-mask::`) for email, password, md5, token, userId, homeId and each devid before any request that could throw. Strip `user.email` from nothing else; the data branch is public, so never write any of those values. A grep test enforces this.

## Shared module contracts (all builders code against these exactly)

Everything under `docs/lib/` is an ES module that imports nothing outside `docs/lib/`. These modules must not touch `window`/`document`/`localStorage` at import time; `store.js` and `charts.js` touch them only inside functions. Node 24 (the collector and tests) imports `normalize.js`, `privacy.js`, `derive.js`, `md5.js` and `mqtt.js` directly. Node 24 has global `crypto.subtle` and `WebSocket`.

- `config.js` → `export const CONFIG` with:
  - `OWNER`, `REPO`, `API`, `WSS:'wss://cloud.popur.com.cn/mqtt'`, `DATA:'https://raw.githubusercontent.com/micknotthemouse/popur-control/data/'`;
  - `REPO_URL`, `ACTIONS_URL`, `SECRETS_URL`;
  - `LW_MODE:null`, `RESET_UTC_MIN:960`, `HANDOFF_SPKI:'<b64>'`;
  - `POLL_MS:30000`, `PROGRESS_POLL_MS:5000`, `PROGRESS_MAX_MS:150000`.

  `export function applyOverrides(loc)` honours `?api=`, `?wss=` and `?data=` only when the hostname is `localhost` or `127.0.0.1`, and returns the effective config.
- `md5.js` → `export function md5Hex(str)` (UTF-8, RFC 1321; check against node:crypto in tests).
- `normalize.js`:
  - `export function normalizeInfo(data)` → `{w,lw,r,on,m}`. Numbers come from `Number()`; `on` and `m` come from `String(x)==='1'` → 1 or 0; missing → null.
  - `export function parseDevices(homeData)` → `[{devid,name,model}]`. It tolerates the shapes `devicelist`, `devices`, `deviceList` and `list`, and the ids `devid`, `_id` and `did`.
  - `export function binState(r)` → `'full'|'ok'|'unclear'`.
  - `export const SENSITIVE_KEY_RE`.
- `api.js` → `export class PopurApi`:
  - `{base}` ctor; `token`;
  - `login(email, md5)` → `{token, homeId, userId}`;
  - `homeDetails()` → `{devices, raw}`;
  - `deviceInfo(devid)` → `{reading, raw, t}`;
  - `user()` → `raw`.

  It throws `ApiError {kind:'auth'|'login'|'network'|'http'|'shape', status, code}`. It sends header `lang: en` only if needed (not by default). Timeout is 15 s via AbortController.
- `mqtt.js`:
  - `export class MqttClient extends EventTarget`: `{url, token}`; `connect()` resolves on CONNACK 0 and rejects with `{code}`; `subscribe(topic)` → granted QoS byte; `publish(topic, obj)`; `close()`.
  - Events: `message` (detail `{topic, payload}`; the payload is JSON-parsed when possible), `frame` (detail `{dir:'in'|'out', type}`, for the diagnostics log) and `close`.
  - It handles PINGREQ every 30 s, remaining-length decoding and frame reassembly.
  - `export async function publishOnce({url, token}, topic, obj)`.
  - `export const topics = {action:id=>\`devcrpc/action/${id}\`, attr:id=>\`devcrpc/attr/${id}\`, report:id=>\`devsrpc/attr/${id}\`}`.
  - `export function cleanPayload(nowSec)`, `export function manualPayload(on, nowSec)`.
  - `export function parseReport(payload)` → `{pid, value}[]`.
- `privacy.js`:
  - `export async function deviceKey(email, devid)` → 12 hex chars of sha256(`popur-control:v1:${email.trim().toLowerCase()}:${devid}`).
  - `export function redact(obj, secretValues)` (keys matching `SENSITIVE_KEY_RE`, or values equal to any secret → `"•••"`).
  - `export function maskEmail(e)`.
- `handoff.js` → `export async function makeSetupCode(email, md5, spkiB64, nowSec)` → `'POPUR1.'+base64url`.
- `store.js` → `get(key, fallback)`, `set(key, val)`, `del(key)` (JSON, `popurctl:` prefix, swallow errors), plus `pushCapped(key, item, max)`.
- `history.js` → `export async function loadHistory({dataBase, dk, now})` → `{status, lines, notSetUp:boolean}`.
  - It fetches `status/gha.json?t=` and the `history/<dk>/<YYYY-MM>.ndjson` for the current UTC month (with `?t=`) and the previous one.
  - A 404 means empty. A 404 on the status means `notSetUp`.
  - `export async function loadStatus(dataBase)`.
- `derive.js` (pure, uses the local timezone via Date):
  - `export function derive(lines, {now, lwMode})` → `{windows, days, hours, events, firstT, lastLine}`;
  - `export function todayCount(derived, live, now)` → `{n, source}`;
  - `export function dailySeries(derived, nDays, now)` → `[{date, label, visits, partial, lossy, binFull, noData, isToday}]`;
  - `export function hourProfile(derived, now)` → `{hours:number[24], days, ready:boolean}` (ready after 7 days of data);
  - `export function stats(derived, now)` → `{avg7, prev7, median14, lastVisitT}`;
  - `export function recentEvents(derived, appCleans, n)`.
- `charts.js`: `export function renderBars(svgHost, series, {onSelect})` and `export function renderHours(svgHost, profile)`. Each builds SVG with `role="img"`, an `aria-label`, and a visually hidden table sibling.

History line and `status/gha.json` schemas are as in the merged design §3, minus `x`. Status also carries `insights.small`, `insights.logins` and `keepalive`.

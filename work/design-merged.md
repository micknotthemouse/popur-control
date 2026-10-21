# Merged design (judge output, 2026-10-20)

> Superseded where work/design-final.md says so. design-final.md wins on any conflict.

## (a) Scores and verdict

| Criterion | Reliability | Fidelity | Experience |
|---|---|---|---|
| Primary uses work robustly | 8 | 8 | 7 |
| Correct against the research | 7 | 8 | 6 |
| Privacy/security in a public repo | 8 | 9 | 7 |
| Phone UX clarity | 8 | 7 | 9 |
| Build cost (higher is cheaper) | 6 | 5 | 8 |
| Run cost and maintenance (user only taps) | 8 | 7 | 8 |
| Resilience to the unknowns | 9 | 9 | 7 |
| **Total** | **54** | **53** | **52** |

Problems found against the research:
- **Experience: timing is broken.** It stores snapshots only when something changes and has no "previous poll" field, so the gap between two stored snapshots is the time between changes, often hours. Its "≤40 min" hour-of-day rule would almost never apply.
- **Experience: wildcard subscribe.** Its "Learn my box" session subscribes to `#`. On a shared cloud broker that could receive other people's device data. Fidelity rightly bans wildcards.
- **Experience: weak device hash.** It hashes devid with a public salt, which can be brute-forced if devids have little entropy. That matters because devid may work as a control capability: the broker authenticates by token only, and whether it checks ownership is unknown.
- **Reliability: stale poll times.** It commits a heartbeat only hourly, so `p` (the previous poll time) can be up to 60 minutes stale. That undermines its own 45-minute placement rule.
- **Reliability: session link in chat.** Its "#k=" link would send a reusable session through chat.
- **Reliability: too much built up front.** The RSA credential handoff and a laptop collector are built before anyone knows they are needed.
- **Fidelity: phase-2 cost.** Its always-on laptop listener needs the Popur credentials on the laptop and ongoing upkeep. Its live-data derivation (cycle typing, coverage shares) roughly doubles the derive code before subscribe is even proven. Its Data-quality screen shows field names like `lastworknum` to the user.
- **None of the three noted** that raw.githubusercontent.com reads need a public repo. Going private breaks history reads from the page as well as Pages.

**Winner: Reliability, used as the base.** It keeps everything raw and derives late, gives each source its own files, keeps showing status while signed out, never fakes "done", and has the best token-cache contingency. Grafted onto it:
- From Fidelity: per-line `pv` plus a commit on every run (this fixes the timing flaw); an email-salted device key; no wildcards; a daily unattended MQTT probe; a mock override honoured only on localhost.
- From Experience: stale-while-revalidate paint, the trust row, the box-counter fallback for "today", collector-side `insights`, a keeper that also dispatches when stale, the failure-email cadence, and a contrast script.

**Runner-up: Fidelity.** It lost on build cost (about 30% more code) and on running cost: a phase-2 always-on laptop listener with credentials is a maintenance burden for a user who never touches the laptop. Most of its precision gain comes from `pv`, which is grafted.

**How each fails:**
- The merged design degrades to 15-minute counter windows. If Actions cannot log in, history stops until a contingency is turned on, and live status still works.
- Fidelity fails more quietly but needs a credentialed laptop process kept alive.
- Experience fails silently: hour-of-day charts would stay mostly empty and nothing would flag it.

---

## (b) Merged design

### 0. Assumptions
- **A1 Repo is public.** It is `micknotthemouse/popur-control`. Pages, raw reads and free Actions minutes all require that. History is public.
- **A2 One home.** The design expects one box and one cat but supports N boxes.
- **A3 Timezone.** The phone's timezone is the household's. Days are grouped in local time; stored times are UTC Unix seconds.
- **A4 A cycle stands in for a visit.** The UI says "visits" with the subline "counted from cleanings".
- **A5 Daily reset.** `worknum` resets daily, by default at 16:00 UTC, and the reset time is learned from data. The meaning of `lastworknum` defaults to `ignore`.
- **A6 "Keep me signed in" is ON by default.** This deliberately departs from the research's opt-in advice, because the user wants taps only. A strict CSP, no third-party scripts and textContent-only rendering contain the risk. Record this in decisions.md.
- **A7 Secrets.** The user pastes `POPUR_EMAIL` and `POPUR_PASSWORD` once on github.com, using a deep link. The collector also accepts `POPUR_PASSWORD_MD5`.
- **A8 Laptop git credential scope.** Windows git credential manager's token is assumed to carry `repo` and `workflow` scope. The keeper's dry run verifies this from the `x-oauth-scopes` header.
- **A9 Clean counting.** A clean started from the app adds 1 to `worknum` (INF).

### 1. Architecture

```
Phone PWA (Pages: main:/docs)
 ├─ REST cloud.popur.com.cn: login, home_details, deviceinfo, /uapi/user   (poll)
 ├─ WSS mqtt: publish clean/manual; optional SUBSCRIBE devsrpc/attr/<devid>
 └─ GET raw.githubusercontent.com/.../data/status/*.json, history/**        (read-only)
Actions collector (cron, Node 24, 0 deps) → branch `data` (src "gha")
Laptop keeper (Task Scheduler, no Popur creds): re-enables / dispatches workflow
Contingencies (designed, built only if day 1 needs them):
  S = token cache (built now, off unless CACHE_KEY secret set)
  L = laptop collector (src "lap") + handoff.yml credential transfer
  P = laptop MQTT listener (phase 2)
```

- The page never writes to the repo.
- Each file has exactly one writer.
- Visits are derived only in `docs/lib/derive.js`, a pure module that the page, the collector's insights and the tests all share.

### 2. Repo layout and GitHub config

**`main` branch**

| Path | Contents |
|---|---|
| `docs/` | `index.html`, `styles.css`, `app.js` (state, render, polling), `manifest.webmanifest`, `.nojekyll`, `icons/{192,512,maskable-512,apple-180}.png` |
| `docs/lib/` | `config.js`, `api.js` (REST), `md5.js`, `mqtt.js`, `derive.js`, `charts.js` (SVG), `store.js` (localStorage), `privacy.js` (dk, x-whitelist, redaction) |
| `collector/` | `collect.mjs`, `git.mjs`, `tokencache.mjs` |
| `laptop/` | `keeper.mjs`, `install-keeper.ps1` |
| `.github/workflows/` | `collect.yml` |
| `test/` | `mock-server.mjs`, `derive.test.mjs`, `collector.test.mjs`, `e2e.mjs` (Edge/Chrome over CDP using Node's built-in WebSocket), `make-icons.mjs`, `contrast.mjs` |
| root | `package.json` (`{"type":"module","private":true}`), `README.md`, `architecture.md`, `decisions.md`, `changelog.md` |

**`data` branch** (orphan): `README.md`, `status/gha.json`, `history/<dk>/<YYYY-MM>.gha.ndjson` (UTC month), `session/gha.bin` (S only). Contingency L adds the `lap` equivalents.

**`config.js`**
- `OWNER`, `REPO`.
- `API='https://cloud.popur.com.cn'`, `WSS='wss://cloud.popur.com.cn:443/mqtt'`, `DATA='https://raw.githubusercontent.com/micknotthemouse/popur-control/data/'`, `SOURCES=['gha','lap']`.
- `LW_MODE=null` (overrides the learned value), `RESET_UTC_MIN=null`, `RUBBISH={0:'ok',2:'full'}`.
- Override: the `?api=`, `?wss=` and `?data=` URL parameters are honoured only when `location.hostname` is `localhost` or `127.0.0.1`.

**CSP meta:** `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://cloud.popur.com.cn wss://cloud.popur.com.cn:443 wss://cloud.popur.com.cn https://raw.githubusercontent.com http://localhost:8787 ws://localhost:8787`.

**Pages:** deploy from branch `main`, folder `/docs`.

**`collect.yml`**
- `on`: `schedule: '7,22,37,52 * * * *'` and `workflow_dispatch` with input `probe_seconds` (default 0, max 1200).
- `permissions: {contents: write}`; `concurrency: {group: collector, cancel-in-progress: false}`; `timeout-minutes: 5`.
- Steps: `actions/checkout@v4` (main, depth 1); `setup-node@v4` with node 24; `node collector/collect.mjs --src gha --store store`.
- Env: the secrets, plus `CACHE_KEY` (optional), `PROBE_SECONDS`, and `POPUR_API`/`POPUR_WSS` overrides for tests.
- Before any output, `git.mjs` runs:
  - `git fetch --depth=1 origin data`;
  - if that succeeds, `git worktree add store FETCH_HEAD -B data`;
  - otherwise `git worktree add --orphan -b data store`.

  A worktree inherits the checkout's auth.

### 3. Data model

**Device key**
- `dk = hex(sha256("popur-control:v1:" + email.trim().toLowerCase() + ":" + devid)).slice(0,12)`.
- `privacy.js` computes it with `crypto.subtle`, in both the browser and Node.
- Never written anywhere: devid, homeId, userId, device name, email, hash, token.

**History line** (NDJSON, one per append)
```json
{"t":1760950000,"pv":1760949100,"w":3,"lw":1452,"r":0,"bf":0,"on":1,"m":0,"x":{"status":1}}
```
- `pv`: this source's previous successful poll time, or `null` on the first poll. Any change happened in `(pv, t]`.
- `bf`: debounced bin-full flag, set to 1 after 2 consecutive polls with `r==2`.
- Missing fields are stored as `null`. `on` and `m` are normalised with `String(x)==="1"`.
- `x` whitelist (≤12 keys):
  - The key must not be one of the known fields.
  - The key must not match `/id|mac|ip|ssid|sn|serial|name|mail|user|home|token|key|pass|wifi|lat|lon|addr|ver|time/i`.
  - The value must be an integer, or a numeric string, between 0 and 999.

**When a line is appended:** any of `w`, `lw`, `r`, `bf`, `on`, `m`, `x` differs from `last`; or this is the first poll; or `t − pt > 2 h` (a gap marker); or `t − lastLine.t ≥ 6 h` (a keepalive).

**`status/gha.json`**
```json
{"v":1,"src":"gha","since":1760900000,
 "run":{"t":1760950000,"ok":1760950000,"n":412,"fails":0,
        "err":null},
 "devices":{"<dk>":{"pt":1760950000,"last":{ /*line*/ },"binPending":0,"binFullSince":null}},
 "insights":{"fields":["isonline","lastworknum","manualmode","rubbish","worknum","…"],
   "homeFields":["devicelist","…"],"rubbish":[0,2],"lw":"unknown",
   "resetWin":[[1760975400,1760976300]],"loginOk":true,
   "mqtt":{"t":1760950000,"connack":0,"suback":[0],"msgs":3,"pids":{"2":[1,3],"6":[0]}}}}
```
- `run.err` is `null` or `{"t":…,"kind":"login|network|http|shape|push","code":"401"}`. Codes and class words only.
- `insights.lw` is `unknown`, `lifetime` or `yesterday`.

**Learning, done by the collector**
- `resetWin` keeps the last 10 windows in which `w` dropped.
- `lw="lifetime"`: `lw` never decreased over ≥3 days, and Δlw == Δw in ≥90% of changing windows.
- `lw="yesterday"`: `lw` changes only when `w` drops, and the new `lw` ≥ the previous `w`.
- Any contradiction → `unknown`.

**Derivation (`derive.js`, per dk)**
1. **Merge** lines from all sources and the page's local snapshots (`src:"page"`). Sort by `t`.
2. **Window** for each consecutive pair a→b:
   - `start = max(a.t, b.pv ?? a.t)`, `end = b.t`, `L = end − start`.
   - Taking deltas along one sorted list telescopes, so several sources can never double count.
3. **Reset time and mode**
   - `R` = `RESET_UTC_MIN`, else the intersection of `resetWin` when there are ≥2 windows agreeing within 30 min, else 960 (16:00 UTC). It is "confirmed" in the first two cases only.
   - `mode` = `LW_MODE ?? insights.lw`.
   - If `mode = lifetime` and `b.lw ≥ a.lw`, then `d = b.lw − a.lw`.
4. **Count `d`:**
   - If `b.w < a.w`: reset. `d = b.w`.
     - With `mode = yesterday`, `R` crossed exactly once and `b.lw ≥ a.w`, add `b.lw − a.w`.
     - Otherwise flag the window `lossy`.
   - Else if `R` falls inside `(a.t, b.t]` and `R` is confirmed: `d = b.w`, flagged `lossy`.
   - Else: `d = b.w − a.w`.
5. **Clamp:** `d > 20` → count 0 and flag `anomaly`.
6. **App cleans:** for each `appCleans[dk]` time c, subtract 1, floored at 0, from the first window with `end ≥ c`, `end ≤ c + 30 min` and `d ≥ 1`. This works on the phone that started the clean only.
7. **Placement:**
   - Day: if L ≤ 3 h, the local day of the midpoint; otherwise the local day of `end`, and that day is marked `partial`.
   - Hour: if L ≤ 60 min, spread `d` across local hours in proportion to overlap; otherwise unplaced.
8. **Gaps:** windows with L > 2 h are gap spans. Days before the first line show "no data". Days with `m=1` are marked "tracking limited".
9. **Events:**
   - `bf` 0→1: "Bin full"; 1→0: "Bin emptied".
   - `on` changes: offline/online.
   - `m` changes: paused/resumed.
   - Windows with `d>0`: visits, with the range "between 14:10 and 14:25".
   - Each app clean: "You started a clean".
   - Gap spans: "Tracking gap".

### 4. Collector algorithm (`collect.mjs`)

1. **Set up the store** (worktree). Load `status/gha.json`. If it is missing, this is the first run, and the collector creates README.md plus an empty status file.
2. **Credentials.** Hash the password with node:crypto MD5. `::add-mask::` the email, password, MD5 hash, and later the token, userId, homeId and every devid. stdout carries only step names, HTTP codes and counts, never a response body.
3. **Token.**
   - If `CACHE_KEY` is set (contingency S): decrypt `session/gha.bin` (AES-256-GCM; the key is the hex secret) and use that token. Log in only on a 401, then re-encrypt and save.
   - Otherwise: `POST /uapi/auth` with a 15 s timeout and one retry after 5 s.
   - Failure classes: network error, timeout or 403 → `network`; `code != 200` → `login`.
4. **Fetch data.** GET `home_details/<homeId>`. Parse `devicelist`, `devices`, `deviceList` or `list`, and the id from `devid`, `_id` or `did`. Then GET `deviceinfo/info/<devid>` for each device. An unexpected shape → `err.kind = "shape"`, but keep whatever parsed.
5. **Per device:** build the reading.
   - `binPending`: incremented when `r==2`, reset otherwise. `bf = binPending ≥ 2 ? 1 : 0`, carrying over a previous `bf=1` until `r != 2`. Set `binFullSince` when `bf` flips.
   - Apply the append rule from §3, with `pv = pt`. Then set `pt = t`.
   - Update `insights`.
6. **MQTT probe.** Runs when `insights.mqtt.t` is not today (UTC), or when `PROBE_SECONDS > 0`.
   - Connect with `mqtt.js` (Node 24's global WebSocket, subprotocol `mqtt`) and SUBSCRIBE `devsrpc/attr/<devid>` only. Never use wildcards.
   - Listen 20 s, or `PROBE_SECONDS`.
   - Record connack, suback codes, the message count, and the pid → value set (integers 0–999 only).
7. **Status.** Set `run.t`. On success: `ok = t`, `fails = 0`, `err = null`. On failure: `fails++`, set `err`.
8. **Commit every run** as `github-actions[bot]`.
   - Why: this persists `pt` (exact `pv`), gives ~15-minute staleness, and counts as repo activity.
   - Push with `git pull --rebase` and up to 3 retries 5 s apart. Single writer, so no conflicts are possible.
   - Expected growth is roughly 30–40 MB of history a year (INF). Claude may squash the `data` branch yearly; record that in decisions.md.
9. **Exit code:** 0, except exit 1 when `fails == 8` (about 2 h) and every 96th failure after that. GitHub's failure email then works as a once-a-day alert.
10. **First run:** writes a baseline line with `pv: null`. The page shows "Tracking started {date}".

**Laptop keeper (`keeper.mjs`, phase 1)**
- Installed by Claude through `install-keeper.ps1`: Task Scheduler, daily at 09:13 and at logon. No Popur credentials.
- Token: `git credential fill` for host github.com; never printed.
- Steps:
  1. GET the workflow. If `state != active`: `PUT …/enable`.
  2. If `status/gha.json` has `run.t` older than 3 h: `POST …/dispatches` (ref `main`).
  3. Unconditional `PUT …/enable` when the last one was more than 6 days ago. State lives in `%LOCALAPPDATA%\popur-control\keeper.json`.
- Logs locally.
- `--dry-run` performs GETs only and reports scopes. That is the required test-mode run before activation.

**Contingency L** (only if day 1 shows `loginOk` false), about 250 lines:
- Claude generates an RSA-4096 keypair on the laptop and commits only the public key.
- `handoff.yml` (`workflow_dispatch`) RSA-OAEP-wraps an AES-GCM key over the secrets into a 1-day artifact.
- The keeper downloads it, decrypts it, and stores it ACL-restricted.
- The keeper runs `collect.mjs --src lap` when `gha` `run.ok` is more than 45 min old.

### 5. Front-end IA

One screen. The last-known state paints immediately from the cache, dimmed with "Updating…".

1. **Header**
   - Box name, and a device chevron when there are ≥2 boxes.
   - One status pill, in this priority order: Offline · Cat inside (live only) · Cleaning… · Auto-clean paused · Ready.
   - A "Live" dot when subscribed.
   - Trust line "Updated 12 s ago": tap to refresh.
   - Gear icon.
2. **Bin hero** (largest). States:
   - OK: "Bin has room".
   - FULL: "Bin full – empty it", with "since 08:40" taken from `binFullSince`.
   - Unmapped: "Bin status unclear" and small "code 1".
   - Offline: "Last known: has room · 2 h ago".
   - When `r==2` within 5 min of a cycle: the full card plus "Sensors can misread right after a clean – rechecking", rechecked at 15 s and 60 s.
   - Signed out: shown from collector `status` when there is exactly one device, labelled "from tracking, 14 min ago".
3. **Paused chip** (only when `m=1`): "Auto-clean is paused · Resume". One tap, no confirm, with an undo toast.
4. **Today**
   - A 48 px number: "4 visits today", with "counted from cleanings".
   - "Last one 38 min ago"; "Usually about 5 a day" (median of the last 14 complete days, shown after 7).
   - With no history: "3 cleanings so far, from the box".
5. **Usage**
   - Segmented 7 d | 30 d bars.
   - "Typical times" hour-of-day chart.
   - "Recent activity" list.
6. **Trust row:** "History tracking: on · checked 9 min ago".
7. **Clean button**
   - Sticky in the thumb zone, 64 px, with safe-area padding.
   - Tap 1 morphs it to "Tap again to clean", with a 4 s draining ring and "Make sure your cat is out". Expiry reverts it. Screen readers get a native `<dialog>` instead.
   - Disabled, with the reason stated: offline, cat inside, cleaning, signed out.
   - Bin full: stays enabled, with "Bin is full – cleaning may not finish".
8. **Progress card** (replaces the button)
   - Steps: Sending → Sent ✓ (CONNACK 0 and publish written, no close within 0.5 s) → Cleaning (live pid2=1, or REST `w` +1) → Done ✓.
   - Done needs live pid2 leaving 1. REST-only ends at "Cleaning counted ✓ – the box finishes on its own".
   - REST polling every 5 s for up to 150 s. On timeout: "Sent, but the box hasn't confirmed. It may still be cleaning – take a look."
   - Each clean is logged to `appCleans`.

**States**

| State | What the user sees |
|---|---|
| Loading, no cache | Skeleton cards |
| Signed out | Login card (email remembered, password, "Keep me signed in" ON, "Your password goes only to Popur") above the collector-sourced hero and charts |
| Expired (401) | Silent re-login with the stored hash; otherwise "Please sign in again" |
| Offline box | Grey pill; dimmed hero with age; Clean disabled: "Box is offline – check power or Wi-Fi" |
| Cleaning / cat inside / manual | As above |
| Collector stale | `run.ok` 75 min–6 h: amber "Tracking delayed (GitHub runs can lag)". Over 6 h, or `fails ≥ 8`: red "Tracking stopped since Tue 14:07 – tell Claude". Shown in Usage and the trust row only, never the hero |
| API error | "Can't reach Popur – retrying in 30 s"; backoff 30/60/120 s; collector values shown with their age |
| History fetch failed | "Couldn't load history · Retry" |
| No history | Ghost bars: "Your chart starts filling today. Tracking began 14:07." |
| Phone offline | Banner driven by `navigator.onLine` |

**More sheet (gear)**
- Pause auto-cleaning switch: publishes pid 3, with a plain explanation and an undo toast.
- Refresh now.
- Device picker.
- Tracking health in plain words: last run, last success, last problem, live updates available yes/no.
- Appearance: system/light/dark.
- Account: masked email, keep-signed-in, sign out, and "Account details" (`/uapi/user`, keys only).
- About: unofficial API; history is public; a deep link to the repo's secrets page.
- Advanced → Diagnostics:
  - Redacted `deviceinfo` and `home_details` (textContent).
  - Insights.
  - MQTT log.
  - "Learn my box (10 min)": subscribes to own topic only, logs REST diffs every 10 s plus MQTT, and prompts "Now let your cat use it / press Clean".
  - "Copy report": redacts blacklist keys and any value equal to devid, homeId, userId, token or email.
  - Day-1 checklist with one Yes/No: "Is the Popur phone app still signed in?"

### 6. Visual system

| Token | Light | Dark |
|---|---|---|
| bg | #F5F6F8 | #0B0D10 |
| surface | #FFFFFF | #15181D |
| surface-2 | #EEF0F3 | #1D2128 |
| text | #0F1419 | #F1F3F5 |
| text-2 | #5B6470 | #9AA4B0 |
| line | #E3E6EA | #262B33 |
| accent | #0F766E | #2DD4BF |
| ok | #15803D | #4ADE80 |
| warn | #B45309 | #FBBF24 |
| danger | #B91C1C | #F87171 |
| bin-full card | #B91C1C bg / #FFFFFF text | #7F1D1D bg / #FFFFFF text |

- **Type:** `system-ui, -apple-system, "Segoe UI", Roboto`. Scale 13/15/17/22/28/48. Weights 400/600/700. `tabular-nums` for numbers.
- **Spacing and shape:** 4-pt grid (4/8/12/16/24/32/48). Radii: chips 999, cards 20, button 28. Light mode uses one soft shadow; dark mode a 1 px `#ffffff14` border. Targets ≥ 48 px.
- **Motion:** 180 ms ease-out cross-fades, the confirm ring, and a pulse on the cleaning pill (1.2 s). `prefers-reduced-motion` makes every change instant.
- **Bin full dominance**
  - The hero becomes the full-bleed solid card with a 28 px/700 heading and a bin icon.
  - Everything below drops one level (muted header).
  - `meta theme-color` turns danger.
  - The title becomes "Bin full · Popur".
  - `navigator.setAppBadge(1)` where supported.
  - One pulse on entry. Always an icon plus words.
- **Contrast:** `test/contrast.mjs` asserts text ≥ 4.5:1 and graphics ≥ 3:1 for every pair.

### 7. Charts (the builder loads the dataviz skill first)

All charts are inline SVG with `role="img"`, an `aria-label` summary and a visually hidden `<table>`.

- **7/30 d bars:** visits per local day. Today in accent, other days muted accent. `partial`/`lossy`/manual days hatched. "No data" days get a thin grey dash. A red dot marks days with a bin-full event. Tapping a bar shows that day's events.
- **Typical times:** 24 bars, mean placed visits per hour over the last 28 days. Shown after 7 days, otherwise "Needs a week of data". After 14 days a weekday×hour heatmap toggle appears.
- **Recent activity:** the last 20 events, grouped by day.
- **Data loading:**
  - For each source, the current and previous UTC months (past months without `?t=`, the current one with `?t=now`). A 404 counts as empty.
  - Refetched every 5 min.
  - Page snapshots kept in localStorage: 7 days, capped at 3,000. They use the same append rule and `pv` from the page's own polls, and are merged before `derive()`.

### 8. Live updates and day-1 learning

**REST polling**
- Every 30 s while the page is visible; 5 s during progress; paused when hidden; immediate refresh on `visibilitychange` or focus.
- Precedence: live MQTT pid 2/6, then REST under 2 min old, then collector status. The age is always shown.

**MQTT** (an enhancement only)
- After sign-in, while visible: connect, SUBSCRIBE `devsrpc/attr/<devid>`, ping every 30 s, reconnect with 1–30 s backoff.
- SUBACK 0x80, a close within 5 s, or 3 failures → off for the session, silently.
- Mapping: pid 2 (3 = cat inside, 1 = cleaning), pid 6 (2 = full), pid 8 (counter, hint only).
- Commands publish on the open connection if there is one; otherwise connect, publish QoS 0, wait 0.5 s, disconnect.
- Payloads are exactly as in the research (`id` = Unix seconds, `from:"remote"`).

**Day-1 learning without user effort**
- `insights` (fields, rubbish values, reset windows, lw mode, `loginOk`, MQTT probe) lands publicly.
- Claude can dispatch longer probes.
- The user answers only the Yes/No checklist and optionally runs "Learn my box".

### 9. Failure modes and costs

| Failure | Mitigation |
|---|---|
| Subscribe refused | Polling only; "Cat inside" and the Done step are hidden |
| Collector login kicks the phone app out | Contingency S: Claude sets `CACHE_KEY` with `gh secret set` from the laptop |
| Actions IPs blocked | `loginOk:false` and the red row; contingency L |
| `lastworknum` meaningless | `ignore` mode; lossy days hatched |
| Missed reset | Confirmed reset time plus the `lossy` flag |
| Cron delays or drops | Windows built from `pv`; gap markers; hatching |
| 60-day disable | Commits every run, the keeper's enable/dispatch, the stale banner, failure email |
| Laptop off | Actions alone, plus the banner |
| False bin-full | Raw value shown live, debounced in history, recheck copy |
| API change | `shape` error, raw diagnostics |
| Clean ignored | Never fakes Done |
| XSS or token theft | CSP, textContent only, no CDNs |
| Phishing through the override | Localhost-only override |
| Device identity | Email-salted dk; masks; no wildcards |

**Costs**
- **Build:** about 2,300 lines of JS/CSS plus about 700 lines of mock and tests, in 3 Sonnet passes:
  1. front end;
  2. collector, workflow and keeper;
  3. mock, tests and icons.
- **Run:** $0. Public Actions (about 2,880 runs/month), Pages and the laptop task are all free. Keeper maintenance is only by Claude.

### 10. Test plan (`test/mock-server.mjs`, port 8787, zero deps)

**Mock**
- Serves `docs/` at `/` and a temporary data directory at `/data/`.
- REST with CORS `*`, an MD5 check, 401 expiry and the wrong-shape variants.
- A hand-rolled RFC 6455 upgrade and an MQTT 3.1.1 broker (CONNACK, SUBACK, PUBLISH routing, PINGRESP), which logs every frame.
- `POST /__scenario` switches between: `normal`, `binFull`, `binFlap`, `offline`, `manual`, `catInside`, `clean` (pid2→1, then `w+1` after 20 s, then pid2→0), `cleanSilent`, `tokenExpired`, `loginFail`, `server500`, `subscribeRefused`, `slow`, `resetDrop`, `lwLifetime`, `lwYesterday`, `unknownFields` (including `mac` and `ssid`).

**`derive.test.mjs`** covers:
- plain deltas;
- resets in all three modes;
- a reset hidden inside a window, both confirmed and unconfirmed;
- 3-source merges with out-of-order input (no double counting);
- `pv` narrowing;
- gaps over 2 h;
- the clamp;
- app-clean subtraction;
- hour spreading;
- DST/TZ day grouping;
- `bf` events;
- the x whitelist.

**`collector.test.mjs`** (local bare remote, fake `NOW`) covers:
- first-run orphan branch creation and the baseline line;
- an unchanged run commits status only;
- change, gap and keepalive appends;
- `bf` debounce;
- month rollover;
- insights detection;
- the exit-code cadence;
- the CACHE_KEY path, including re-login on a 401;
- the probe recording suback;
- concurrent push with retry;
- a grep of stdout, stderr and every committed file for email, password, MD5, token, devid, homeId and userId must find nothing.

**`e2e.mjs`** (390×844, light and dark, `?api=…&wss=…&data=…`) asserts:
- signed out: the collector hero shows;
- login stores the hash only when keep-signed-in is on;
- bin full: the hero is first and full-bleed, theme-color is red, the title changed;
- offline/cat-inside disable reasons;
- two-tap confirm, and ring expiry reverts;
- the mock receives the exact clean topic and payload;
- progress reaches counted, Done and timeout copy;
- manual switch publishes pid 3 with values 0 and 1;
- silent re-login on a 401;
- refused subscribe shows no error;
- stale and no-history states;
- a non-localhost override is ignored;
- a device name of `<img src=x onerror>` stays inert;
- zero CSP violations and zero requests outside the allowlist;
- all targets ≥ 48 px;
- the manifest and icons load;
- the hidden chart tables exist.

**Also run:**
- `contrast.mjs`;
- `keeper.mjs --dry-run` against a mock GitHub API on port 8788.

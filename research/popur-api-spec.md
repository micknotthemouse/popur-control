# Popur X5 cloud API and hosting spec (research synthesis, 2026-10-20)

Confidence tags: **CODE** = read in open-source client code; **DOC** = vendor or platform documentation; **MEAS** = measured by our own unauthenticated probes; **ANEC** = reviews or forum posts; **INF** = inferred; **UNKNOWN**.
Nothing here was tested with a logged-in account. Every logged-in behaviour is unverified until the user's account is used.

## Sources

- gingerAUT1988/home-assistant-popur (X5, cloud REST + MQTT publish), the reference for the user's reference app: https://github.com/gingerAUT1988/home-assistant-popur , code at https://raw.githubusercontent.com/gingerAUT1988/home-assistant-popur/main/custom_components/popur/api.py
- rajkumaar23/homebridge-popur (TypeScript port of the same API): https://raw.githubusercontent.com/rajkumaar23/homebridge-popur/HEAD/src/popurApi.ts
- jda258/popur-ha (X5, MQTT-only, **subscribes** to device push): https://raw.githubusercontent.com/jda258/popur-ha/HEAD/custom_components/popur/const.py and https://raw.githubusercontent.com/jda258/popur-ha/HEAD/custom_components/popur/coordinator.py
- DJPoulter/Popur-Esphome (model not named, same topics as popur-ha): https://raw.githubusercontent.com/DJPoulter/Popur-Esphome/HEAD/config.yaml
- User's reference app: `reference/popur-control-reference.html`. It matches the ginger code exactly. It stores the email and the MD5 hash in localStorage and keeps up to 2,000 history snapshots per device in localStorage.
- Not applicable: BookCatKid/pypopur and popur-s7-ha are for the **S7** (Tuya cloud). Do not reuse their endpoints or datapoints: https://github.com/BookCatKid/pypopur

Conflicts resolved:
- Two sweeps reported no public X5 project other than ginger. That was wrong. popur-ha, Esphome and homebridge-popur exist, and I re-fetched their code to confirm.
- One sweep said "no MQTT subscribe topic exists". That is only true of the ginger code. popur-ha and Esphome subscribe to `devsrpc/attr/<devid>` (CODE).

## 1. Auth and session behaviour

- **Login**: `POST https://cloud.popur.com.cn/uapi/auth` (CODE: ginger, homebridge).
  - Body: `{"param":"<email>","password":"<md5 hex of password>","type":"2"}`.
  - Headers: `Content-Type: application/json` and `User-Agent: com.cloudapp.popur.app`. The user agent is the Android package name. No code shows the server requiring it, but send it anyway.
  - Success is `code == 200`. The response carries `data.token`, `data.user._id` and `data.user.defaulthomeid`.
- **Authenticated calls**: `Authorization: Bearer <token>`.
- **The MD5 hash is the credential.** It is unsalted and the server accepts it directly, so storing the hash is as sensitive as storing the password.
- **Token lifetime: UNKNOWN.** No source documents one.
  - There is no refresh endpoint. `/uapi/auth/refresh`, `/uapi/token/refresh` and `/uapi/user/info` all return 404 (MEAS).
  - Homebridge drops the token on any 401 and logs in again on the next call (CODE).
- **Do logins kick other sessions? UNKNOWN.**
  - No reports were found either way. The ginger and homebridge repos show no issues about the phone app being logged out (ANEC, weak evidence).
  - The integrations log in on every restart. If that logged people out of the phone app, complaints would be expected, so the cloud probably allows several tokens at once (INF).
  - This is a real risk once a collector logs in every 15 minutes. Test it on day 1.
- **Recommendation**:
  - Web app: log in once, then keep `{token, homeId, devid}`. Re-login only on a 401 or a `code != 200`.
  - Collector: log in once per run. If the phone app turns out to get logged out, cache the token between runs instead, for example in an encrypted artifact or a secret updated through the API. That is harder, so only do it if needed.
- CORS: `Access-Control-Allow-Origin: *` on the REST API (MEAS). Allowed request headers include `Authorization`, `Content-Type` and `lang` (MEAS). `lang` is probably a language selector (INF).
- Rate limits, captcha and lockout: none documented. The integrations poll every 60 s with no throttling reported (ANEC; homebridge README default 60 s, minimum 15 s: https://raw.githubusercontent.com/rajkumaar23/homebridge-popur/HEAD/README.md).
- Region (MEAS): `cloud.popur.com.cn` resolves to 54.176.154.47, which is AWS us-west-1 (INF from the IP range). Unauthenticated round trips took 134 to 229 ms. No regional alternative hosts exist. Whether login is blocked from datacentre IPs (GitHub Actions) is UNKNOWN.

## 2. REST endpoints

Base `https://cloud.popur.com.cn`.

| Method | Path | Purpose | Key fields | Confidence | Source |
|---|---|---|---|---|---|
| POST | `/uapi/auth` | Login | in: `param`, `password` (md5), `type:"2"`; out: `code`, `data.token`, `data.user._id`, `data.user.defaulthomeid` | CODE | ginger api.py, homebridge popurApi.ts |
| GET | `/uapi/home_details/<homeId>` | Home and device list | `data.devicelist[]` → `devid`, `name` (homebridge also tolerates `devices`/`deviceList`/`list` and `_id`, `did`, `nickname`, `model`; example model "LB02K") | CODE | same |
| GET | `/uapi/deviceinfo/info/<devid>` | Device status | `rubbish`, `worknum`, `lastworknum`, `manualmode`, `isonline` (see section 4) | CODE | same |
| GET | `/uapi/user` | Exists (401 when unauthenticated); purpose unknown, probably the user profile | unknown | MEAS (route exists only) | probe |

Probed and **not found** (404, MEAS):
- `/uapi/deviceinfo/{history,log,records,properties,stat,statistics,worklog,workrecord,event,alarm,notice,list}/0`
- `/uapi/deviceinfo/0`, `/uapi/device/0`, `/uapi/devices`, `/uapi/records/0`, `/uapi/devicelog/0`
- `/uapi/home`, `/uapi/homes`, `/uapi/user/info`, `/uapi/auth/refresh`, `/uapi/token/refresh`, `/uapi/share/list`
- `/uapi/message/list`, `/uapi/messages`, `/uapi/notice`, `/uapi/pets`, `/uapi/pet`

These were guesses, so the misses do not prove that no history endpoint exists. Existing routes return HTTP 401 with `{"code":400,"msg":"请求参数错误"}` ("request parameter error"), while missing routes return a plain `404 page not found`.

## 3. MQTT

- **Browser and cloud path** (CODE: ginger, homebridge):
  - URL: `wss://cloud.popur.com.cn:443/mqtt?token=<url-encoded token>`, WebSocket subprotocol `mqtt`.
  - MQTT 3.1.1 (protocol level 4), with no username or password. The token in the query string is the only auth.
  - A bad token is rejected at the HTTP upgrade with 401 `{"code":20001,"msg":"Token鉴权失败"}` ("token authentication failed") (MEAS).
- **Alternative brokers** (CODE/README: popur-ha https://raw.githubusercontent.com/jda258/popur-ha/HEAD/README.md):
  - Cloud: port 4433 over TLS, whose certificate has expired, so the client must disable certificate checks.
  - The **device's local IP** on port 1883, which contradicts the ginger and homebridge "no local API" claim. That conflict is unresolved.
  - Neither path is usable from a GitHub Pages page: browsers cannot skip certificate checks or open raw TCP. Use the wss path on 443.
- **Command pattern** (CODE): connect, publish at QoS 0, wait about 0.5 s, disconnect. `id` is the Unix time in seconds, and `from:"remote"` is hard-coded and unexplained.

### Topics

| Direction | Topic | Payload | Effect | Confidence |
|---|---|---|---|---|
| publish | `devcrpc/action/<devid>` | `{"id":<unix s>,"method":"action","from":"remote","params":{"did":"0","sid":2,"aid":1,"in":[]}}` | Start a clean cycle | CODE (ginger, homebridge, popur-ha, Esphome; the last two omit `id`, `from` and `in`) |
| publish | `devcrpc/attr/<devid>` | `{"id":<unix s>,"method":"set_properties","from":"remote","params":[{"did":"0","sid":2,"pid":3,"value":0|1}]}` | Manual mode (pauses auto-clean; used as DND) on or off | CODE (ginger, homebridge) |
| subscribe | `devsrpc/attr/<devid>` | `{"method":"properties_changed","params":[{"pid":N,"value":V,...}]}` | Device pushes property changes | CODE (popur-ha const.py, Esphome config.yaml). Only `params[0]` is read, and `sid` is not checked. **Whether the token-auth wss broker allows this subscription is UNKNOWN.** |

### sid / pid / aid map

| ID | Meaning | Values | Confidence |
|---|---|---|---|
| sid 2 | Main litter-box service | n/a | CODE |
| sid 2 aid 1 | Start clean | `in: []` | CODE |
| sid 2 pid 2 | Box state | 3 = occupied (cat inside), 1 = running/cleaning, other values unknown (probably idle) | CODE for names, meanings from variable names (popur-ha `PROP_OCCUPIED`) |
| sid 2 pid 3 | Manual mode, writable | 1 on, 0 off | CODE |
| pid 6 (sid probably 2) | Bin status | 2 = full; other values unknown | CODE, sid INF. Probably the same value as REST `rubbish` (INF) |
| pid 8 (sid probably 2) | Clean count | integer | CODE, sid INF. Probably the same as `worknum` (INF) |

- Everything else is UNKNOWN: auto-clean delay, child lock, lights, deodoriser, sleep schedule, stop or pause actions, firmware and errors.
- A `get_properties` method is plausible by the MIoT-style naming (INF), but not confirmed.
- The full map needs either a decompile of the official APK (`com.cloudapp.popur.app` v1.0.8, reportedly delisted from Google Play 2026-07-20 per https://apkcombo.com/popur/com.cloudapp.popur.app/, unconfirmed) or logging what arrives on `devsrpc/attr/<devid>` (and `#`, if allowed) while using the official app.

## 4. Status field dictionary (`GET /uapi/deviceinfo/info/<devid>` → `data`)

| Field | Type seen | Meaning | Confidence |
|---|---|---|---|
| `rubbish` | number | `2` = bin full. Other values (0/1, maybe "near full") are unmapped. | CODE for 2; rest UNKNOWN |
| `worknum` | number | Clean cycles **today**. It may reset at midnight China Standard Time (UTC+8), which is 16:00 UTC. | CODE label; reset time from the ginger README (DOC by the author, unverified) |
| `lastworknum` | number | Treated as the lifetime total by ginger and the reference app. **The name equally suggests "yesterday's count".** Do not trust either reading until real data shows whether it is monotonic. | CODE label only; semantics UNKNOWN |
| `manualmode` | string/number | `"1"` = manual mode (auto-clean off / DND) on | CODE |
| `isonline` | string/number | `"1"` = online | CODE |

- Compare with `String(x) === "1"`, because the type varies.
- Other fields in the response are unknown. Dump the full `data` object once logged in and record it here.
- Bin-full reliability (ANEC): reviewers report both false "bin full" alerts after every clean and missing warnings (https://cats.com/popur-x5-self-cleaning-cat-litter-box-review, https://www.chewy.com/popur-x5-self-cleaning-cat-litter-box/product-reviews/1719862).
  - Show the raw state in the app.
  - Debounce it for notifications and history: require 2 consecutive polls before declaring the bin full.

## 5. Usage-history data sources, ranked

1. **MQTT push `devsrpc/attr/<devid>`, pid 2 = 3 (cat in box)**. This gives exact visit times.
   - Best signal, but whether the token-auth broker allows it is UNKNOWN.
   - It only works while a client stays connected: the open web page, or a long-running Actions job (see section 6).
   - pid 8 increments confirm cycles.
2. **Polled REST counters** (`worknum`, `lastworknum`). Known to work (CODE).
   - The collector polls about every 15 minutes and records deltas.
   - Precision is limited to the poll interval, and two visits between polls merge into one delta.
3. **Phone-app history**. Not exposed by any known endpoint (MEAS 404s).
4. **localStorage snapshots in the browser** (the reference app's approach). These only cover time the page is open and are lost when the browser is cleared. Use them only as a cache.

**Counting visits:**
- Store raw snapshots: `ts`, `worknum`, `lastworknum`, `rubbish`, `isonline`, `manualmode`.
- Compute `visits = max(0, worknum - prev.worknum)`. If `worknum` drops, treat it as a reset: count the new value as fresh cycles, and attribute the reset to the CST day boundary (16:00 UTC).
- Use `lastworknum` deltas only after day-1 data proves it is a monotonic lifetime total.
- Subtract cleans started from the app. The app should log its own "manual clean" events into the history (they also increment the counter, INF).
- Label the metric "cleaning cycles (≈ visits)". A cycle is not exactly a visit: two quick visits can yield one cycle, and visits during manual mode yield none (INF; reviewers use cycles as the usage proxy, ANEC).

## 6. GitHub hosting and collector mechanics

- **Pages**: on GitHub Free, a Pages site requires a **public** repo (DOC https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site). Whether personal Pro allows a private repo to publish publicly is unclear (DOC https://docs.github.com/en/get-started/learning-about-github/githubs-plans).
  - Limits: 1 GB site, 100 GB/month soft bandwidth, 10 builds/hour soft limit, which does not apply to Actions deploys (DOC https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).
- **Cron**: minimum 5 minutes. Runs are best effort and get delayed or dropped under load, especially at the top of the hour (DOC https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows).
  - Observed behaviour: "every 5 min" fired every 7 to 18 minutes (ANEC https://upptime.js.org/blog/2021/01/22/github-actions-schedule-not-working/), and a 30-minute gap was seen (ANEC https://github.com/tamucsa/points/issues/34).
  - **Recommend `7,22,37,52 * * * *`** plus `workflow_dispatch`, `timeout-minutes: 3`, and Node on `ubuntu-latest` with no dependencies.
- **Minutes**: public repos are free. Private repos get 2,000 min/month (Free) or 3,000 (Pro), and each job rounds up to 1 minute (DOC https://docs.github.com/en/billing/managing-billing-for-your-products/about-billing-for-github-actions).
  - That means 15-minute polling (2,880 runs) exceeds the Free private quota. A private repo on Free means 30-minute polling (1,440) or slower.
- **60-day auto-disable**: in **public** repos, scheduled workflows are disabled after 60 days without repository activity (DOC https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/disabling-and-enabling-a-workflow). The docs do not say whether bot commits count (UNKNOWN).
  - The popular keepalive action was disabled by GitHub staff (MEAS https://github.com/gautamkrishnar/keepalive-workflow), so don't use it.
  - Mitigation: a monthly step calls `PUT /repos/{o}/{r}/actions/workflows/{id}/enable` with a fine-grained PAT, because `GITHUB_TOKEN` lacks the permission (ANEC https://github.com/PhrozenByte/gh-workflow-immortality). Also show a "collector last ran X ago" warning in the app.
- **Storage layout**:
  - `data` branch, so collector commits never rebuild Pages.
  - `data/latest.json`: the last snapshot plus `collector_last_run`.
  - `data/history/YYYY-MM.json`: one record per change (on counter change, bin-state change or online change), not per poll.
  - Commit only if something changed (`git diff --quiet || commit`, git-scraping pattern https://simonwillison.net/2020/Oct/9/git-scraping/). Still update `collector_last_run` at most hourly, so staleness is visible.
- **Reads from the page**: `https://raw.githubusercontent.com/<user>/<repo>/data/...`, which serves `ACAO: *` and `max-age=300`, so it can lag up to 5 minutes (MEAS). Add `?t=<now>`. Avoid the contents API for reads: unauthenticated it allows 60 requests/hour per IP (DOC).
- **Concurrency**: `concurrency: {group: collector, cancel-in-progress: false}`, `permissions: contents: write`, and `git pull --rebase` with 3 push retries (DOC https://docs.github.com/en/actions/using-jobs/using-concurrency).
- **Secrets**:
  - `POPUR_EMAIL` and `POPUR_PASSWORD_MD5` as Actions secrets, passed via `env:`.
  - `::add-mask::` the token.
  - Never log API responses, because logs in a public repo are public (DOC https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions).
- **Optional live listener (INF)**: a job that holds the MQTT subscription for up to about 5.5 hours, restarted by cron every 6 hours, would record exact visit times for free in a public repo.
  - Risk: GitHub's Actions terms disallow uses unrelated to the repository's software project. Long-running scraping jobs are more likely to be flagged.
  - Treat this as a phase-2 experiment, only if the subscription is proven to work.
- **"Refresh now" from the page**: `POST /repos/{o}/{r}/actions/workflows/{file}/dispatches` needs a token (DOC https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event). Make it optional, using a fine-grained PAT scoped to Actions: write on this repo, stored in that browser only.
- **Privacy**: a public repo makes the cat's usage history public, though not credentials.

## 7. Web app best-practice notes

- **MQTT in the browser**: hand-roll a small client (about 120 lines) supporting CONNECT, CONNACK check, SUBSCRIBE (0x82, QoS 0), PUBLISH QoS 0, PINGREQ every 30 s, and incoming PUBLISH parsing with remaining-length decoding and frame buffering.
  - Use `new WebSocket(url, "mqtt")` with `binaryType = "arraybuffer"`.
  - Reconnect with backoff from 1 s to 30 s, re-login on refusal, and resubscribe after CONNACK.
  - The reference app never pings, so a long-lived connection would drop.
  - Fallback: mqtt.js 5.x (`createWebsocket` hook) (DOC https://cdn.jsdelivr.net/npm/mqtt@5.15.2/README.md). Avoid a CDN dependency on a page that holds a token.
- **After Clean**: poll `deviceinfo/info` every 5 to 10 s for about 60 to 90 s, or watch pid 2 move to 1 if the subscription works, to show "Cleaning…" and then "Done".
- **PWA**:
  - Use `manifest.json` with `name`, `start_url`, `display: standalone`, and 192/512 PNG icons including a maskable one (DOC https://web.dev/articles/add-manifest).
  - For iOS, add a 180×180 `apple-touch-icon`, `viewport-fit=cover`, `env(safe-area-inset-*)` and status-bar meta (DOC https://web.dev/learn/pwa/enhancements).
  - No service worker is needed.
- **Credential storage**:
  - Store `{token, homeId, devid}` in localStorage. Storing the MD5 hash should be an opt-in "keep me signed in" (OWASP: localStorage is readable by any XSS, DOC https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html).
  - Load no third-party scripts, and render API data with `textContent` only.
  - The reference app stores the hash by default. Do not copy that.
- **Layout, phone-first** (pattern from Whisker/Litter-Robot app, DOC https://www.litter-robot.com/eu/support/article/whisker-app-features/):
  1. Status pill: Online/Offline and Ready/Cleaning/Cat inside/Manual mode.
  2. Hero bin card: "Bin OK" or a full-width amber/red "Bin full: empty it" banner, with icon and text, not colour alone.
  3. Large Clean button in the thumb zone, with a confirm step (tap again within 3 s). Disable it with a stated reason when offline.
  4. Today's visits as a big number, a 7- or 30-day bar chart, an hour-of-day × weekday heatmap, and a recent-events list.
  5. A Settings sheet holding manual mode, device picker, collector status, account, and a diagnostics panel (raw `deviceinfo` JSON and the MQTT topic log).
- **Charts**: inline SVG, `role="img"` plus `aria-label`, and a hidden table alternative. Use a colour-blind-safe pair, with 3:1 contrast for graphics and 4.5:1 for text.

## 8. Open unknowns (need the user's real account) and risks

Resolve on day 1 with the diagnostics panel or one collector run:

1. Does the collector's login log the phone app out? (Run the collector, then open the phone app.)
2. The full `deviceinfo/info` and `home_details` JSON. Which other fields exist, such as errors, firmware or settings?
3. Is `lastworknum` a lifetime total or yesterday's count? When does `worknum` reset (16:00 UTC or local midnight)?
4. Does the wss broker accept SUBSCRIBE to `devsrpc/attr/<devid>`, and to `#`? Which pid values arrive during a visit and a clean? Is pid 2 = 3 reliable for "cat in box"?
5. `rubbish` values besides 2, and whether the bin-full flag false-alarms on this unit.
6. Token lifetime, and whether login works from GitHub Actions (datacentre IP).
7. `/uapi/user`: what it returns.

Risks:
- Unofficial API. It can break or change without notice, and the official app appears delisted (unconfirmed).
- The app's Android listing is reportedly gone, which may signal reduced vendor support.
- The MD5 hash is a reusable credential. Keep it only in Actions secrets and, opt-in, in one browser.
- Collector gaps of 10 to 30 minutes and dropped runs are normal. Counts are approximate.
- A public repo exposes usage history. A private repo on Free limits polling to every 30 minutes and still needs Pages on a public repo (or Pro, unclear).
- The 60-day disable on public repos needs a PAT-based re-enable or a manual nudge.

## 9. Day-1 findings from the real account (2026-10-21, first collector run)

- **Login from GitHub Actions works:** `loginOk: true`. The token cache is written to `session/gha.bin`.
- **`deviceinfo/info` keys:**
  - Location: `City`, `Country`, `District`, `Province`, `nationcode`.
  - Identity: `_id`, `devid`, `homeid`, `userid`, `userids`, `serverId`, `secretkey`.
  - Display: `dev_name`, `home_name`, `pic`, `has_new_name`, `active_enname`, `model`, `access`.
  - Time: `create_at`, `last_notice_time`, `time`.
  - Device state: `isonline`, `lastworknum`, `worknum`, `rubbish`, `run`, `switch`.
- **There is no `manualmode` field** on this unit, so the app's "paused" state reads as unknown. `switch` (seen as 0) and `run` (seen as 0) are candidates; to be learned.
- **First values:** `worknum` 2, `lastworknum` 25, `rubbish` 1 (bin had room, so 1 means not full), `isonline` 1.
- **`secretkey`** is excluded from all stored data by the sensitive-key rule. Only the key names are in public insights.

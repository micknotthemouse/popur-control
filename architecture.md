# Architecture — popur-control

## Components

- **Web app** (`docs/`, GitHub Pages at https://micknotthemouse.github.io/popur-control/). It is a static PWA: plain ES modules, no third-party scripts, and a strict CSP.
  - It talks directly to the Popur cloud:
    - REST at `https://cloud.popur.com.cn/uapi/*` for login, home details, device info and user.
    - MQTT 3.1.1 over `wss://cloud.popur.com.cn/mqtt?token=` to publish clean and manual-mode commands, with an optional subscription to `devsrpc/attr/<devid>`.
  - It reads history from `raw.githubusercontent.com/micknotthemouse/popur-control/data/`.
  - It never writes to GitHub.
- **Collector** (`collector/collect.mjs`, `.github/workflows/collect.yml`): Node 24 with zero dependencies, run every 15 min by cron plus manual dispatch.
  - Each run logs in, or reuses the encrypted cached token.
  - It reads every device's counters, appends changed readings to the `data` branch, and commits `status/gha.json` on every run.
- **Laptop tools** (`tools/`, not used at run time): the setup handoff receiver. It decrypts the code from the page, sets the Actions secrets and dispatches the collector. The private key lives in `secrets/` and is gitignored.

## Data (branch `data`, public)

- `status/gha.json`: last run, health, and per-device last reading plus `pt`, keyed by `dk`.
- `history/<dk>/<YYYY-MM>.ndjson`: one line per change, gap or 6-hour keepalive: `{t,pv,w,lw,r,bf,on,m}`.
- `session/gha.bin`: the AES-GCM encrypted token cache.
- `dk` is the first 12 hex characters of sha256 of `popur-control:v1:<email>:<devid>`. Email, devid, homeId, userId and the token are never written.

## Data flow

Collector → `data` branch → page fetches status and two months of NDJSON → `derive.js` (shared with tests) → charts. Live REST and MQTT readings override stored state for status and top up today's count.

## Constraints

- The Popur API is unofficial and reverse-engineered (`research/popur-api-spec.md`).
- Secrets live only in Actions secrets and the user's browser.
- Actions logs are public, so they print nothing sensitive.
- Pages, raw reads and free minutes all require the repo to stay public.

# Build checkpoint — popur-control

## 2026-10-21 — tracking live on the real account

**Running:**
- Live app: https://micknotthemouse.github.io/popur-control/ (Pages from `main` `/docs`, commit 4c28ae6 and later).
- The collector workflow `collect.yml` runs at :07/:22/:37/:52 each hour. Secrets are set (2026-10-21). Each run commits status and appends history on change. The first real run logged in OK.

**Links:**
- Repo: https://github.com/micknotthemouse/popur-control
- Actions: https://github.com/micknotthemouse/popur-control/actions/workflows/collect.yml
- Data: branch `data` (public).
- The handoff private key is in `secrets/handoff-private.pem` (gitignored; never print it).
- GitHub ops: `node tools/gh.mjs <cmd>`.
- To set secrets from a setup code: `node tools/receive-handoff.mjs <POPUR1.code>`.

**Pending from user:** say whether the official Popur phone app is still signed in after the first collector run (2026-10-21 05:39 UTC).

**Open risks:** unverified on the real account: whether a login evicts other sessions, whether MQTT subscribe works, whether a clean bumps `worknum`, what `lastworknum` means, and `rubbish` values other than 2. Also the 60-day schedule auto-disable (mitigated by bot commits, a monthly enable call and a stopped-tracking link in the page).

Measured: the live page reaches the real Popur API from the browser (a fake-account login was rejected cleanly, code 20005). The first real collector run logged in from GitHub Actions and wrote the baseline.

**Next step:** confirm phone-app sign-in status; check the next runs use the cached token (`insights.cacheUsed` true, logins stay at 1/day); after about a week, read `data` to decide `LW_MODE`, the reset time, and whether `switch` or `run` means paused (decisions D-2, D-6).




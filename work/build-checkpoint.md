# Build checkpoint — popur-control

## 2026-10-20 — v1 live, waiting for the user's first sign-in

**Running:**
- Live app: https://micknotthemouse.github.io/popur-control/ (Pages from `main` `/docs`, commit 4c28ae6 and later).
- The collector workflow `collect.yml` runs at :07/:22/:37/:52 each hour. It writes `status/gha.json` with `run.err.kind = setup` until the secrets exist, then commits nothing more.

**Links:**
- Repo: https://github.com/micknotthemouse/popur-control
- Actions: https://github.com/micknotthemouse/popur-control/actions/workflows/collect.yml
- Data: branch `data` (public).
- The handoff private key is in `secrets/handoff-private.pem` (gitignored; never print it).
- GitHub ops: `node tools/gh.mjs <cmd>`.
- To set secrets from a setup code: `node tools/receive-handoff.mjs <POPUR1.code>`.

**Pending from user:** sign in on the phone; tap Settings → History tracking → "Turn on history tracking" and paste the setup code into chat (Claude then runs `receive-handoff`); after the first collector run, say whether the Popur phone app is still signed in.

**Open risks:** unverified on the real account: whether a login evicts other sessions, whether GitHub Actions IPs can log in, whether MQTT subscribe works, whether a clean bumps `worknum`, what `lastworknum` means, and `rubbish` values other than 2. Also the 60-day schedule auto-disable (mitigated by bot commits, a monthly enable call and a stopped-tracking link in the page).

Measured: the live page reaches the real Popur API from the browser (a fake-account login was rejected cleanly, code 20005). One collector run on GitHub succeeded and created the `data` branch.

**Next step:** when the user pastes a setup code, run `node tools/receive-handoff.mjs <code>`, watch the run with `node tools/gh.mjs runs micknotthemouse/popur-control 1`, then check `status/gha.json` for `loginOk` and `insights.fields`. After about a week of data, decide `LW_MODE` and the reset time (decisions D-2, D-6).

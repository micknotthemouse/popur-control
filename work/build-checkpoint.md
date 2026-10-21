# Build checkpoint — popur-control

## 2026-10-20 — build phase

**Running:** build workflow `wf_29e07fff-a8d` (task w0wqbebue). Foundations (libs, derive+charts, mock+harness) run first, then UI+e2e and collector+tools. Specs: `work/design-final.md` (authoritative) > `work/design-merged.md`; why: `work/design-skeptic.md`; API: `research/popur-api-spec.md`.
**Links:** repo https://github.com/micknotthemouse/popur-control (public, created, empty); planned page https://micknotthemouse.github.io/popur-control/.
**Pending from user:** after deploy, sign in on the page and tap "Turn on history tracking", then paste the setup code into chat. After the first collector run, check whether the Popur phone app is still signed in.
**Open risks:** unofficial API; unknown whether logins evict other sessions; unknown whether GitHub Actions IPs can log in to Popur; MQTT subscribe unverified; `lastworknum` meaning unknown; 60-day schedule auto-disable. Handoff private key is in `secrets/` (gitignored).
**Next step:** when the build finishes, run all tests, review screenshots, commit, push main, enable Pages (`node tools/gh.mjs enable-pages`), and verify the live page loads.

# Changelog — popur-control

## 2026-10-20

- **Research done** (`research/popur-api-spec.md`).
  - Measured: the Popur REST API allows CORS `*`.
  - No history endpoint was found among about 30 probed paths.
- **Design done:** 3 approaches were compared, then judged and skeptic-reviewed. The final spec is `work/design-final.md`.
- **Build v1 implemented:**
  - Web app: `docs/`, a PWA with a strict CSP.
  - Shared libraries: `docs/lib/`.
  - History collector and its schedule: `collector/` and `.github/workflows/collect.yml`.
  - Setup tools for the laptop: `tools/`.
  - Mock Popur cloud for testing: `test/mock-server.mjs`.
- **Measured** (local mock only):
  - 77 unit, collector and tool tests passed.
  - 20 of 20 end-to-end browser checks passed in headless Edge.
  - Every colour contrast check passed.
- **Published:** commit `4c28ae6` pushed to the public repo, and GitHub Pages enabled from `main` `/docs`.
- **Unverified:** everything that needs the real Popur account:
  - login from the browser and from GitHub Actions;
  - MQTT subscribe;
  - whether a clean increments the counter;
  - what `lastworknum` means;
  - whether logins evict other sessions.

## 2026-10-21

- **Setup handoff worked:**
  - Secrets set: email, password hash and cache key.
  - First real collector run: login OK from GitHub Actions, one device found, baseline history line written.
- **Measured on the real box:**
  - Bin value 1 means it has room.
  - `worknum` was 2 and `lastworknum` 25.
  - There is no `manualmode` field, so the paused state is unknown in the app.
- **Unverified:**
  - Token-cache reuse on later runs.
  - Whether the phone app was signed out.
  - Clean and MQTT from the page with the real account.

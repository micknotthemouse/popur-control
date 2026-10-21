# Decisions — popur-control

## D-1 Static GitHub Pages app + Actions collector, public repo (2026-10-20)
- **Decision:** a static PWA on GitHub Pages calls the Popur cloud directly from the browser. History comes from a scheduled GitHub Actions collector that commits to an orphan `data` branch. The repo is public.
- **Why:**
  - The Popur REST API allows CORS `*` (measured).
  - Public repos get free Actions minutes and free Pages.
  - The user chose public.
- **Accepted tradeoffs:**
  - Litter-box usage history is publicly readable. It carries no credentials and no device identifiers.
  - Cron runs are best-effort, with 10–30 min jitter, so counts are approximate.
- **Runner-up: "data-fidelity-first"** (the same base plus an always-on laptop MQTT listener for exact visit times).
  - Why it lost: about 30% more code. It also needs Popur credentials on the laptop and a process kept alive on a machine the user never touches.
  - Most of its precision gain, the per-line previous-poll time `pv`, was grafted into the pick.
  - Third approach, "UX-first": its timing model was broken (no `pv`), and its wildcard MQTT subscribe could see other users' data.
- **Failure modes:**
  - If Actions IPs are refused by Popur, history stops but live status still works.
  - If MQTT subscribe is refused, the page falls back to polling and "Cat inside" is hidden.
  - If GitHub auto-disables the schedule (60 days), the page shows a red "Tracking stopped" row with a one-tap link.
- **Costs:** build is about 3k lines. Running cost is $0.

## D-2 Visits are counted from cleaning cycles (2026-10-20)
- `worknum` deltas between collector polls count visits. A drop counts as a daily reset.
- `lastworknum` is stored raw and ignored (`LW_MODE=null`) until a week of real data shows what it means. The reset time defaults to 16:00 UTC.
- The UI says "visits · counted from cleanings".
- Unverified: whether one cycle equals one visit, and whether app-started cleans increment `worknum`.

## D-3 Token cache on by default; detect sign-in eviction (2026-10-20)
- **Decision:** the collector caches its Popur token, AES-256-GCM encrypted with a random `POPUR_CACHE_KEY` secret, so it logs in only when the token expires. The page stops silent re-login after 3 per hour and shows "Signed in somewhere else".
- **Why:** it is unknown whether a Popur login logs out other sessions.
- **Rejected:** deriving the key from the password. An encrypted blob in a public repo would then give attackers an offline password-guessing oracle.

## D-4 "Keep me signed in" defaults on (2026-10-20)
- **Decision:** the stored MD5 hash is kept in localStorage by default.
- **Why:** the user wants taps only.
- **Accepted risk:** the `micknotthemouse.github.io` origin is shared with dusty-fox-link and velora-link. Neither loads third-party scripts (checked 2026-10-20). The app keeps a strict CSP and renders data with textContent only.
- **Revisit** if any site on that origin ever adds third-party scripts.

## D-5 Setup handoff instead of typing secrets on GitHub (2026-10-20)
- **Decision:** the page encrypts `{email, md5}` with an RSA-OAEP public key whose private half stays on the laptop (`secrets/`, gitignored). The user pastes the code into chat, and Claude sets the Actions secrets through the API.
- **Fallback:** a deep link to the repo's secrets page.

## D-6 v1 cuts (2026-10-20)
- Not built in v1:
  - page snapshots merged into history;
  - laptop collector, listener and keeper;
  - collector MQTT probe;
  - reset/lastworknum learning;
  - subtracting app-started cleans;
  - weekday×hour heatmap.
- These cuts follow the skeptic review (`work/design-skeptic.md`). Revisit after a week of real data.

## D-7 Run model (2026-10-20)
- The collector is deterministic Node code with no model at run time, so there is no per-run model cost.

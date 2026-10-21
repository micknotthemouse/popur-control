# Skeptic review of the merged design (2026-10-20)

**Skeptic review: ranked problems**

1. **Login contention can make the collector and the page lock each other out.** Likelihood is unknown; the research flags it as a real risk. Impact is high. Contingency S only reduces how often the collector logs in. If Popur allows one session per account, the page's silent re-login and the collector's re-login will keep evicting each other, and the phone app too. Fixes:
   - Turn the token cache on by default. Derive its key from the existing password secret (HKDF of the MD5 plus a fixed label), so `CACHE_KEY` and `gh secret set` are no longer needed.
   - Have the page count 401s per hour. If there are more than 3 per hour, stop the silent re-login and say "Another sign-in is replacing this one". Record `relogins/day` in insights.

2. **Every Pages site on the user's account shares one storage area.** Likelihood is medium; impact is high. localStorage belongs to `micknotthemouse.github.io`, not to the repo, so any other Pages project on that account can read the stored MD5 hash and token. The page's CSP gives no protection here. Fixes:
   - Before turning "Keep me signed in" on by default, list the account's other Pages repos.
   - If any of them load third-party scripts, default "Keep me signed in" to off, or move this app to its own custom subdomain.
   - Record this in decisions.md next to A6.

3. **The workflow uses action versions that run on Node 20.** It is near-certain to break and the impact is high. GitHub removed Node 20 from runners on 23 September 2026 ([changelog](https://github.blog/changelog/2026-03-19-deprecation-of-node-20-on-github-actions-runners/)). `checkout@v4` and `setup-node@v4` are Node 20 actions. Pin the current Node 24 majors (v5 or later; I have not checked the exact version) and run one real dispatch before relying on the schedule.

4. **The timeout kills long probes.** This is certain. `PROBE_SECONDS` can be up to 1200 but `timeout-minutes: 5`, so long probes are killed and the run's status is never committed. Use `timeout-minutes: ${{ inputs.probe_seconds > 0 && 25 || 5 }}`. Also note that a long probe holds the concurrency group, and scheduled runs that are waiting get cancelled, which creates gaps.

5. **"Bin has room" can be stale or made up.** Likelihood is medium; this is the user's top use.
   - The cached paint and the signed-out collector hero can say "has room" in the present tense when the data is hours or days old. Over 30 minutes old, the hero must read "Last known … X ago". Over 6 hours, or when the collector is red, it must read "Bin status unknown".
   - `RUBBISH={0:'ok'}` is an assumption; only 2 is backed by code. Normalise with `Number(r)`. Treat null, missing or NaN as "unclear", never as ok. Treat 0 as ok, but tag it unverified in diagnostics until day-1 data confirms it.
   - The hero's age must come from `run.t` / `pt`, not from fetch time. raw.githubusercontent may serve content up to 5 minutes old whatever the query string ([discussion](https://github.com/orgs/community/discussions/46691), [FLUID-6626](https://issues.fluidproject.org/browse/FLUID-6626/)).

6. **Merging the page's snapshots can double count.** Likelihood is medium; impact is medium. Snapshots use the phone's clock. With a little skew, or a lagging server read, a lower `w` can sort after a higher one. That looks like a fake reset, and `d = b.w` adds the whole day's count again. Two fixes:
   - Count a drop as a reset only if R (confirmed or default) is inside the window, or if `b.w` is at most 2. Otherwise `d = 0` and flag it.
   - Better for v1: cut page snapshots from `derive()` entirely. Use the live REST `w` only as a top-up for "today" since the last collector line.

7. **Subtracting app cleans is unproven and probably wrong.** Likelihood is medium. A manual clean pressed after a visit may replace the automatic cycle, and subtracting then shows 0 visits. It also only corrects one phone, while the public history stays raw. v1: do not subtract. Show "You started a clean" events and keep the "counted from cleanings" subline. Make subtraction a config flag that Claude sets after reviewing data.

8. **The reset time is learned in UTC.** If the box resets at local midnight, DST shifts it by 1 hour twice a year, and the learned windows stop agreeing. Store the learned reset as both UTC and local offset, and re-learn after any disagreement. Also apply the unconfirmed default R to the "hidden reset" rule, with `lossy`, rather than not applying it at all.

9. **The secrets setup breaks the "taps only" rule.** Pasting the email and password into GitHub's secrets page on a phone is a second typed login and needs a GitHub session on the phone. Fix: add a "Set up tracking" button on the page.
   - It RSA-OAEP-encrypts `{email, md5}` with a public key the laptop committed, and the user pastes the result into chat (a tap).
   - Claude decrypts it on the laptop and sets the secrets through the API. If no sealed-box tool is available on the laptop, that step needs a small helper, but it is laptop-side, so the zero-dependency rule does not apply.
   - This needs the laptop once. Keep the deep link as a fallback.

10. **The keeper does not run unattended after a reboot.** `git credential fill` reads Windows Credential Manager, which only works in an interactive logon (S4U and "run whether logged on" have no access to the user's protected credential store). After a Windows Update reboot with no logon, the keeper is dead. GCM can also show a GUI prompt and hang the task.
    - Set `GCM_INTERACTIVE=never` and `GIT_TERMINAL_PROMPT=0`.
    - Have the dry run report the logon dependency.
    - The keeper is mostly redundant anyway. Committing every run is repo activity, and long-running git-scraping repos survive on bot commits (INF). Treat it as nice-to-have.

11. **Privacy leaks besides the data files.**
    - **(a)** Commits Claude pushes from the laptop to `main` carry the laptop's `user.email`. Set the repo-local `user.email` to the account's noreply address before the first commit. The same applies to contingency L's commits.
    - **(b)** The `x` whitelist lets through `tz`, `zone`, `region`, `lang` and `country`. Add those to the blacklist. Better: keep unknown fields only in `insights` for the first 14 days, not in every history line forever.
    - **(c)** Mask derived values in Node before any request that could throw. Uncaught fetch errors print stacks; keep a top-level catch that prints only the error class.
    - **(d)** The `fails` counter is not persisted when the push fails. Exit 1 on any `push` failure so the failure email still fires.

12. **The PWA scope is wrong.** The site lives at `/popur-control/`, so the manifest must use `start_url` and `scope` `"./"` with relative icon paths. A root `/` breaks the home-screen launch. Add an e2e check for this.

13. **CSP traps for the builder.** `style-src 'self'` blocks `setAttribute('style')` and SVG `style=""`. Charts must use classes or SVG presentation attributes, or set styles through CSSOM. Drop the localhost entries from the production CSP by having the mock rewrite the CSP header for tests.

14. **Collector learning is underspecified and over-built.** The `lw` and `resetWin` learning needs counters across runs that are not in the schema. Cut it from v1. Store everything raw, have Claude read the public data after about a week, and set `LW_MODE` and `RESET_UTC_MIN` in config.

15. **GitHub Actions terms.** A 96-commits-a-day scraper is tolerated practice, but the keepalive repo was disabled. Low likelihood, high impact. Keep runs under 30 seconds, never loop inside a job, and keep the daily probe at 20 seconds.

**Cut from v1** (about 25% of the build):
- page snapshots merged into history;
- multi-source merge (keep a single `gha` source, with the telescoping kept generic);
- collector `lw` and reset learning;
- app-clean subtraction;
- the weekday×hour heatmap;
- the keeper's "unconditional enable every 6 days";
- contingency L detail beyond one paragraph in decisions.md.

**Missing states:**
- "Bin status unknown" (stale over 6 hours, or unmapped or null);
- "Signed in elsewhere" (eviction loop);
- "Tracking not set up yet" (no `data` branch or 404 on status) as distinct from "No history".

**Verdict: proceed with the listed fixes.** Fixes 1–5 are blocking. 6–9 change counting or setup and should be in v1. The rest are small.

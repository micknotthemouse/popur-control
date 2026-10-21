# Popur Control

A phone-first web app for a Popur X5 self-cleaning litter box. Open it here: https://micknotthemouse.github.io/popur-control/

Unofficial. It is not made by or connected to Popur. It uses the same web service the Popur phone app uses, which can change or stop working without notice. Use it at your own risk.

## What it does

1. **Status at a glance.** Whether the bin is full comes first, then whether the box is online, cleaning, or paused.
2. **One-tap clean.** Tap once, then tap again to confirm. It tells you plainly if the box did not respond.
3. **Cat usage history.** Visits per day, typical times of day and recent activity, collected in the background even when the app is closed.

Everything else (pause auto-clean, account, diagnostics) is in the settings sheet.

## Privacy

- Your Popur email and password go only to Popur. In the app they stay in your browser. For history tracking, a login hash is stored as an encrypted GitHub Actions secret, and nowhere else.
- This repository is public, and so is the `data` branch where history is kept. That branch holds **counts and timestamps only**: how many cleanings, when something changed, bin state. It holds no email, no password, no device or home ids, no device name and no location. Boxes are named by a short one-way key.
- The login session is kept on the data branch only in encrypted form. The key is an Actions secret.

## How history tracking works

A scheduled GitHub Actions job (`.github/workflows/collect.yml`) checks the box about every 15 minutes and writes a line to the `data` branch when something changed. GitHub does not run schedules exactly on time, so the numbers are approximate: two visits between checks can count as one, and a late run shows up as a gap.

To turn it on: open the app, sign in, go to settings and choose **Turn on history tracking**, then paste the setup code it shows into your chat with Claude. The code is encrypted so only Claude's laptop can open it.

GitHub switches off scheduled jobs in a public repository after 60 days without activity. The collector commits on every run and re-enables itself monthly to avoid that. If tracking ever stops anyway, the app says so and links to the page where it can be switched back on.

## Layout

| Path | What |
|---|---|
| `docs/` | The web app (served by GitHub Pages from `main` `/docs`) |
| `collector/` | The history collector run by Actions |
| `test/` | Tests and a mock Popur server |
| `tools/` | Laptop-only setup helpers (not deployed) |

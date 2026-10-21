# Popur Control data branch

This branch is written automatically by the "Collect litter box history" workflow, about every 15 minutes.
It is public. It holds counts and timestamps only.

- `status/gha.json`: when the collector last ran, whether it worked, and the latest reading per box.
- `history/<box key>/<YYYY-MM>.ndjson`: one line each time something changed (clean counter, bin state, online, auto-clean paused), plus occasional keep-alive lines.
- `session/gha.bin`: an encrypted login session. Unreadable without a secret key that is not in this repository.

Boxes are named by a short one-way key. No email, password, device id, home id, device name or location is stored here.
Times are Unix seconds (UTC). Counts are approximate: the collector looks at the box every ~15 minutes.

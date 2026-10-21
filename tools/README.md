# Laptop setup tools

Laptop only, never deployed. Run `npm install` here once (needs `libsodium-wrappers`, pinned to 0.7.15).

The GitHub token comes from the Windows git credential manager (`git credential fill`, no prompts). Nothing here prints a token, a password or a secret value; output is names and HTTP statuses.

## gh.mjs

`node tools/gh.mjs <command>` (a bare repo name means `micknotthemouse/<name>`)

| Command | Does |
|---|---|
| `whoami` | Shows the signed-in login and token scopes |
| `create-repo <name> --public --description "..."` | Creates a repo |
| `enable-pages <repo>` | Pages from `main` `/docs` (409 = already on) |
| `pages-status <repo>` | Build status and URL |
| `secret-names <repo>` | Lists Actions secret names (never values) |
| `dispatch <repo> <workflow file> [ref]` | Runs a workflow (default ref `main`) |
| `runs <repo> [n]` | Latest workflow runs: status, conclusion, time, link |
| `workflow-state <repo> <file>` | `active` or `disabled_*` |
| `enable-workflow <repo> <file>` | Re-enables a disabled workflow |

As a module it exports `getToken`, `api`, `sealBox`, `setSecret`, `secretNames`, `dispatch`.

## receive-handoff.mjs

`node tools/receive-handoff.mjs <POPUR1.code> [--dry-run] [--repo owner/name]`

Decrypts the setup code from the app with `secrets/handoff-private.pem` (RSA-OAEP, SHA-256), rejects anything older than 7 days, sets the secrets `POPUR_EMAIL` and `POPUR_PASSWORD_MD5` (and a random `POPUR_CACHE_KEY` if none exists), then runs `collect.yml` on `main`.

`--dry-run` only decrypts and validates, and prints the field names and a masked email. `HANDOFF_KEY_PATH` overrides the key file (used by tests).

## Tests

`node --test test/collector.test.mjs` covers the collector and these tools, offline against mocks. It never calls the real GitHub or Popur.

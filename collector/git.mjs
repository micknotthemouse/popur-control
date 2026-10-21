// Git helpers for the collector: a worktree on the orphan "data" branch, commit, push with retry.
// Git output is never printed (it can contain remote URLs); callers see only booleans.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const BOT = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', '-c', 'commit.gpgsign=false'];
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

export function git(args, { cwd } = {}) {
  const r = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout || '' };
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Removes a leftover worktree from an earlier run in the same checkout.
function cleanup(store) {
  git(['worktree', 'remove', '--force', store]);
  fs.rmSync(store, { recursive: true, force: true });
  git(['worktree', 'prune']);
  git(['branch', '-D', 'data']);
}

// Returns { existed } : whether the remote already had a data branch.
export function prepareStore({ store, remote }) {
  cleanup(store);
  const fetched = git(['fetch', '--depth=1', remote, 'data']).ok;
  if (fetched) {
    if (!git(['worktree', 'add', '-f', store, 'FETCH_HEAD']).ok) throw new Error('worktree add failed');
    if (!git(['-C', store, 'checkout', '-B', 'data']).ok) throw new Error('checkout failed');
    return { existed: true };
  }
  if (!git(['worktree', 'add', '--orphan', '-b', 'data', store]).ok) {
    // git < 2.42: no --orphan for worktree add
    cleanup(store);
    if (!git(['worktree', 'add', '--detach', store, 'HEAD']).ok) throw new Error('worktree add failed');
    if (!git(['-C', store, 'checkout', '--orphan', 'data']).ok) throw new Error('orphan checkout failed');
    git(['-C', store, 'rm', '-rf', '--quiet', '.']);
  }
  return { existed: false };
}

// Stages everything and commits. Returns true if a commit was made, false if nothing changed.
export function commitAll({ store, message }) {
  if (!git(['-C', store, 'add', '-A']).ok) throw new Error('add failed');
  if (git(['-C', store, 'diff', '--cached', '--quiet']).ok) return false;
  if (!git([...BOT, '-C', store, 'commit', '--quiet', '-m', message]).ok) throw new Error('commit failed');
  return true;
}

// Push with rebase-and-retry. Returns true on success.
// Network git commands run in the main checkout (cwd), not in the worktree: that is where the
// Actions checkout step configured its credentials. The branch ref is shared by both.
export async function pushStore({ store, remote, attempts = 3, delayMs = 5000 }) {
  const theirs = 'refs/popur/remote-data';
  for (let i = 1; i <= attempts; i++) {
    if (git(['push', '--quiet', remote, 'refs/heads/data:refs/heads/data']).ok) return true;
    if (i === attempts) break;
    await sleep(delayMs);
    const fetched = git(['fetch', '--quiet', remote, '+refs/heads/data:' + theirs]).ok;
    if (!fetched || !git([...BOT, '-C', store, 'rebase', '--quiet', theirs]).ok) {
      git(['-C', store, 'rebase', '--abort']);
    }
  }
  return false;
}

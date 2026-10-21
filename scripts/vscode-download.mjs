// VS Code's test download (.vscode-test in the main worktree) is shared by every worktree: by npm run test:vscode
// (.vscode-test.mjs) and by the demos (scripts/demo.mjs). Two of them downloading at once would unpack into the same
// folder and break each other's tar ("Cannot mkdir", ENOTEMPTY), so a download takes a lock first and the other waits.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The main worktree, where VS Code's test download is kept for every worktree. */
export function mainRoot(cwd = process.cwd()) {
  try {
    return path.dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' }).trim());
  } catch {
    return cwd;
  }
}

/** Whether process `pid` still runs (one we may not signal still does). */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Whether the lock at `lockDir` was left by a process that's gone, or is older than `staleMs`. */
function stale(lockDir, staleMs) {
  try {
    const pid = Number(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'));
    if (pid && !alive(pid)) return true;
    return Date.now() - fs.statSync(lockDir).mtimeMs > staleMs;
  } catch {
    // Just made, its pid not written yet (or just removed): not stale, unless it's been like that a while.
    try {
      return Date.now() - fs.statSync(lockDir).mtimeMs > 10_000;
    } catch {
      return false;
    }
  }
}

/**
 * Runs `fn` holding the lock folder `lockDir` (made with mkdir, which only one process wins), waiting while another
 * process holds it. A lock left by a process that's gone, or older than `staleMs`, is taken over.
 */
export async function withLock(lockDir, fn, { staleMs = 30 * 60_000, pollMs = 1000, onWait } = {}) {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  let told = false;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (stale(lockDir, staleMs)) {
      // Renamed away first: of two processes taking it over, only one renames it, so neither removes the other's new lock.
      const away = `${lockDir}.stale-${process.pid}`;
      try {
        fs.renameSync(lockDir, away);
        fs.rmSync(away, { recursive: true, force: true });
      } catch {
        // Another process took it over first.
      }
      continue;
    }
    if (!told) onWait?.();
    told = true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  try {
    fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid));
    return await fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

/** Runs `fn` (the download, and whatever else changes `cachePath`) while no other process downloads into it. */
export function withDownloadLock(cachePath, fn) {
  return withLock(path.join(cachePath, '.download.lock'), fn, {
    onWait: () => console.log(`Waiting for another download of VS Code into ${cachePath} to finish…`),
  });
}

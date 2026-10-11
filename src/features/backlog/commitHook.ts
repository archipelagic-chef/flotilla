import * as fs from 'node:fs';
import * as path from 'node:path';
import { runGit } from '../../core/git/gitCli';

/** Whose commits must start with the ticket id: agents' (Claude Code sets CLAUDECODE in their commands), everyone's, or no one's. */
export type CommitPrefixMode = 'agents' | 'everyone' | 'off';

const MARK = '# flotilla commit-msg hook';
/** An existing commit-msg hook is kept under this name and still runs, after Flotilla's check. */
export const PREVIOUS_HOOK = 'commit-msg.pre-flotilla';

/**
 * The commit-msg hook: in a worktree working on a backlog item (<git dir>/flotilla/ticket holds its id), a commit's
 * message must start with "<id>:". Merges, reverts and fixups are let through. The mode is read from
 * <common dir>/flotilla/commit-prefix, so changing the setting needs no new hook.
 */
export const COMMIT_HOOK = `#!/bin/sh
${MARK}: commits in a worktree that works on a backlog item start with its id ("BL-1: ...").
git_dir=$(git rev-parse --git-dir 2>/dev/null)
common_dir=$(git rev-parse --git-common-dir 2>/dev/null)
ticket=$(head -n 1 "$git_dir/flotilla/ticket" 2>/dev/null | tr -d '\\r')
mode=$(head -n 1 "$common_dir/flotilla/commit-prefix" 2>/dev/null | tr -d '\\r')
[ -n "$mode" ] || mode=agents
if [ -n "$ticket" ] && { [ "$mode" = everyone ] || { [ "$mode" = agents ] && [ -n "$CLAUDECODE" ]; }; }; then
  first=$(grep -v '^#' "$1" | grep -v '^[[:space:]]*$' | head -n 1)
  case "$first" in
    "$ticket:"* | "Merge "* | "Revert "* | "fixup! "* | "squash! "* | "amend! "*) ;;
    *)
      echo "This worktree works on $ticket: start the commit message with \\"$ticket: \\", like \\"$ticket: $first\\"." >&2
      exit 1
      ;;
  esac
fi
previous="$(dirname "$0")/${PREVIOUS_HOOK}"
if [ -x "$previous" ]; then exec "$previous" "$@"; fi
exit 0
`;

/** Where git runs hooks from (core.hooksPath, or the common dir's hooks). */
export async function hooksDir(cwd: string): Promise<string> {
  const out = (await runGit(['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], { cwd })).trim();
  return path.resolve(cwd, out);
}

/**
 * Installs the hook (once; an existing commit-msg hook is kept and chained) and records the mode. 'tracked': the
 * hooks are in the repository's files (core.hooksPath, as Husky sets it), which Flotilla doesn't change.
 */
export async function installCommitHook(mainRoot: string, commonDir: string, mode: CommitPrefixMode): Promise<'installed' | 'tracked'> {
  await fs.promises.mkdir(path.join(commonDir, 'flotilla'), { recursive: true });
  await fs.promises.writeFile(path.join(commonDir, 'flotilla', 'commit-prefix'), `${mode}\n`);
  const dir = await hooksDir(mainRoot);
  const inside = (parent: string, child: string) => {
    const rel = path.relative(parent, child);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  if (inside(mainRoot, dir) && !inside(commonDir, dir)) return 'tracked';
  if (mode === 'off') return 'installed';
  await fs.promises.mkdir(dir, { recursive: true });
  const hook = path.join(dir, 'commit-msg');
  const existing = await fs.promises.readFile(hook, 'utf8').catch(() => undefined);
  if (existing !== undefined && !existing.includes(MARK)) {
    const previous = path.join(dir, PREVIOUS_HOOK);
    if (!fs.existsSync(previous)) await fs.promises.rename(hook, previous);
  }
  if (existing !== COMMIT_HOOK) await fs.promises.writeFile(hook, COMMIT_HOOK, { mode: 0o755 });
  await fs.promises.chmod(hook, 0o755);
  return 'installed';
}

/** Marks a worktree (by its git dir) as working on an item: its commits then start with the item's id. */
export async function markWorktree(gitDir: string, id: string): Promise<void> {
  await fs.promises.mkdir(path.join(gitDir, 'flotilla'), { recursive: true });
  await fs.promises.writeFile(path.join(gitDir, 'flotilla', 'ticket'), `${id}\n`);
}

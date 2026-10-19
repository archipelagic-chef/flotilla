import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { GitError, runGit } from '../../core/git/gitCli';
import { gitHubRepo } from './sources/github';

/**
 * Pushes an approved ticket's branch to origin, so CI runs on it before it's merged (BL-104). Only to origin, never
 * forced, and only commits with the repository's own (anonymous) identity as author and committer.
 */

/** The only remote a ticket's branch is pushed to. */
export const PUSH_REMOTE = 'origin';

/** flotilla.ci.pushOnApproval: auto pushes when origin is on GitHub and a workflow runs on push. */
export type PushSetting = 'auto' | 'on' | 'off';

/** The last push of an item's branch (kept on the item): a tip isn't pushed, or noted, twice. */
export interface PushedInfo {
  branch: string;
  commit: string;
  /** Why it wasn't pushed, when it wasn't. */
  error?: string;
}

export type PushResult =
  | { kind: 'pushed'; branch: string; commit: string; count: number }
  | { kind: 'up-to-date'; branch: string; commit: string }
  | { kind: 'identity'; branch: string; commit: string; identity: string; strangers: Array<{ commit: string; subject: string; author: string; committer: string }> }
  | { kind: 'force'; branch: string; commit: string; remoteCommit: string }
  | { kind: 'failed'; branch: string; commit: string; reason: string; hint: string };

const short = (c: string) => c.slice(0, 7);
const message = (e: unknown) => (e instanceof GitError ? e.stderr || e.message : e instanceof Error ? e.message : String(e)).trim();

/** Whether a workflow file runs on push: its on: trigger is push, lists it, or has a push: key. */
export function runsOnPush(workflowYaml: string): boolean {
  const lines = workflowYaml.split(/\r?\n/);
  const at = lines.findIndex((l) => /^["']?on["']?\s*:/.test(l));
  if (at < 0) return false;
  const inline = lines[at].replace(/\s#.*$/, '').replace(/^["']?on["']?\s*:/, '').trim();
  if (inline) return /(^|[\s,[{])push\b/.test(inline);
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || l.trim().startsWith('#')) continue;
    if (!/^\s/.test(l)) break;
    if (/^\s+(-\s*)?["']?push["']?\s*(:|$)/.test(l)) return true;
  }
  return false;
}

/** Whether pushing on approval is on for this repository: on, or auto with a GitHub origin and a workflow on push. */
export async function pushOnApproval(cwd: string, setting: PushSetting): Promise<boolean> {
  if (setting === 'off') return false;
  const url = (await runGit(['remote', 'get-url', PUSH_REMOTE], { cwd }).catch(() => '')).trim();
  if (!url) return false;
  if (setting === 'on') return true;
  if (!gitHubRepo(url)) return false;
  const dir = path.join(cwd, '.github', 'workflows');
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => /\.ya?ml$/.test(f));
  for (const f of files) if (runsOnPush(await fs.readFile(path.join(dir, f), 'utf8').catch(() => ''))) return true;
  return false;
}

/** What to do about a failed push, from git's message. */
export function pushHint(error: string): string {
  if (/could not read Username|Authentication failed|terminal prompts disabled|Permission denied|403|denied to/i.test(error))
    return 'Sign in to GitHub for git (e.g. `gh auth login`, or a credential helper), then approve again or push the branch yourself.';
  if (/Could not resolve host|unable to access|timed out|Connection refused|Network is unreachable/i.test(error))
    return "Check the network connection; it's pushed again when the branch gets new commits.";
  if (/non-fast-forward|fetch first|rejected|stale info/i.test(error))
    return 'Origin has commits the branch lacks: merge them into the branch (or look at who pushed them); never force.';
  if (/No such remote|does not appear to be a git repository/i.test(error)) return 'Add an `origin` remote to push to.';
  return 'See the Flotilla output for the whole message.';
}

/**
 * Pushes a branch to origin (setting its upstream): fetches origin, checks every commit origin doesn't have yet was
 * authored and committed with the repository's configured identity, and that origin's branch (if any) is in the
 * branch's history: a push that would need force isn't made.
 */
export async function pushBranch(cwd: string, branch: string): Promise<PushResult> {
  const commit = (await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], { cwd }).catch(() => '')).trim();
  if (!commit) return { kind: 'failed', branch, commit: '', reason: `There's no branch \`${branch}\`.`, hint: 'Nothing to push.' };
  const failed = (reason: string, hint = pushHint(reason)): PushResult => ({ kind: 'failed', branch, commit, reason, hint });

  if (!(await runGit(['remote', 'get-url', PUSH_REMOTE], { cwd }).catch(() => ''))) return failed('The repository has no `origin` remote.');
  try {
    await runGit(['fetch', '--quiet', '--no-tags', PUSH_REMOTE], { cwd, timeoutMs: 120_000 });
  } catch (e) {
    return failed(`Fetching origin failed: ${message(e)}`);
  }

  // The identity Flotilla's agents commit with.
  const name = (await runGit(['config', 'user.name'], { cwd }).catch(() => '')).trim();
  const email = (await runGit(['config', 'user.email'], { cwd }).catch(() => '')).trim();
  if (!name || !email) return failed("The repository has no identity to commit with (git's user.name and user.email).", 'Set them, then approve again.');
  const identity = `${name} <${email}>`;
  const log = (await runGit(['log', '--format=%H%x00%an <%ae>%x00%cn <%ce>%x00%s', commit, '--not', `--remotes=${PUSH_REMOTE}`], { cwd }))
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [c, author, committer, subject] = l.split('\0');
      return { commit: c, author, committer, subject };
    });
  const strangers = log.filter((c) => c.author !== identity || c.committer !== identity);
  if (strangers.length) return { kind: 'identity', branch, commit, identity, strangers };

  const remoteCommit = (await runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/${PUSH_REMOTE}/${branch}^{commit}`], { cwd }).catch(() => '')).trim();
  if (remoteCommit === commit) {
    // Already there: only the upstream may be missing.
    await runGit(['branch', `--set-upstream-to=${PUSH_REMOTE}/${branch}`, branch], { cwd }).catch(() => undefined);
    return { kind: 'up-to-date', branch, commit };
  }
  if (remoteCommit && !(await runGit(['merge-base', '--is-ancestor', remoteCommit, commit], { cwd }).then(() => true, () => false)))
    return { kind: 'force', branch, commit, remoteCommit };

  try {
    // --force-with-lease would allow what this must never do: a plain push, refused by git when it isn't a fast-forward.
    await runGit(['push', '--set-upstream', PUSH_REMOTE, `refs/heads/${branch}:refs/heads/${branch}`], { cwd, timeoutMs: 120_000 });
  } catch (e) {
    return failed(`Pushing failed: ${message(e)}`);
  }
  return { kind: 'pushed', branch, commit, count: log.length };
}

/** The ticket's note of a push (none when origin already had it). */
export function pushNote(r: PushResult): string | undefined {
  const b = `\`${r.branch}\``;
  switch (r.kind) {
    case 'pushed':
      return `Pushed ${b} to origin at \`${short(r.commit)}\` (${r.count} new commit${r.count === 1 ? '' : 's'}), so CI runs on it.`;
    case 'up-to-date':
      return undefined;
    case 'identity':
      return [
        `Didn't push ${b} to origin: ${r.strangers.length === 1 ? 'a commit has' : `${r.strangers.length} commits have`} another identity than the repository's (\`${r.identity}\`):`,
        '',
        ...r.strangers.slice(0, 10).map((c) => `- \`${short(c.commit)}\` ${c.subject}: author \`${c.author}\`${c.committer !== c.author ? `, committer \`${c.committer}\`` : ''}`),
        ...(r.strangers.length > 10 ? [`- and ${r.strangers.length - 10} more`] : []),
        '',
        "Rewrite them with the repository's identity (or push yourself, if that's intended). Merge to main runs the checks locally.",
      ].join('\n');
    case 'force':
      return `Didn't push ${b} to origin: origin's \`${r.branch}\` (\`${short(r.remoteCommit)}\`) isn't in the branch's history, so it would take a force push, which Flotilla never does. Merge origin's commits into the branch (or remove the branch on origin), and it's pushed again on the branch's next commit.`;
    case 'failed':
      return `Couldn't push ${b} to origin: ${r.reason}\n\n${r.hint} Merge to main runs the checks locally.`;
  }
}

/** The PushedInfo kept on the item after a push. */
export function pushedInfo(r: PushResult): PushedInfo {
  const error = r.kind === 'pushed' || r.kind === 'up-to-date' ? undefined : r.kind;
  return { branch: r.branch, commit: r.commit, ...(error ? { error } : {}) };
}

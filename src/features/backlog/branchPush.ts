import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import picomatch from 'picomatch';
import { GitError, runGit } from '../../core/git/gitCli';
import { gitHubRepo } from './sources/github';

/**
 * Pushes an approved ticket's branch to origin, so CI runs on it before it's merged (BL-104). Only to origin, and only
 * commits with the repository's own (anonymous) identity as author and committer. Never forced, but for a branch its
 * agent rewrote (rebased, tidied: BL-181) over what Flotilla pushed itself: `--force-with-lease` on that commit.
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
  | { kind: 'pushed'; branch: string; commit: string; count: number; rewritten?: boolean }
  | { kind: 'up-to-date'; branch: string; commit: string }
  | {
      kind: 'identity';
      branch: string;
      commit: string;
      identity: string;
      strangers: Array<{ commit: string; subject: string; author: string; committer: string }>;
    }
  | { kind: 'force'; branch: string; commit: string; remoteCommit: string }
  | { kind: 'failed'; branch: string; commit: string; reason: string; hint: string };

const short = (c: string) => c.slice(0, 7);
const message = (e: unknown) => (e instanceof GitError ? e.stderr || e.message : e instanceof Error ? e.message : String(e)).trim();

/** A workflow's push trigger's filters, as written (each one there only when the workflow has it). */
export interface PushTrigger {
  branches?: string[];
  'branches-ignore'?: string[];
  tags?: string[];
  'tags-ignore'?: string[];
}

const FILTERS = ['branches', 'branches-ignore', 'tags', 'tags-ignore'] as const;
const indent = (l: string) => /^\s*/.exec(l)![0].length;
const unquote = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, '$2');
const uncomment = (l: string) => l.replace(/\s#.*$/, '');

/** A workflow's push trigger: undefined when it has none; its filters when it has a push: key with them. */
export function pushTrigger(workflowYaml: string): PushTrigger | undefined {
  const lines = workflowYaml.split(/\r?\n/);
  const at = lines.findIndex((l) => /^["']?on["']?\s*:/.test(l));
  if (at < 0) return undefined;
  const inline = uncomment(lines[at])
    .replace(/^["']?on["']?\s*:/, '')
    .trim();
  if (inline) return /(^|[\s,[{])push\b/.test(inline) ? {} : undefined;
  const block = (from: number, over: number) => {
    const out: number[] = [];
    for (let i = from; i < lines.length; i++) {
      if (!lines[i].trim() || lines[i].trim().startsWith('#')) continue;
      if (indent(lines[i]) <= over) break;
      out.push(i);
    }
    return out;
  };
  for (const i of block(at + 1, 0)) {
    const l = uncomment(lines[i]);
    if (/^\s+-\s*["']?push["']?\s*$/.test(l)) return {};
    if (!/^\s+["']?push["']?\s*:/.test(l)) continue;
    const trigger: PushTrigger = {};
    const own = block(i + 1, indent(l));
    for (const j of own) {
      const m = /^\s+["']?([\w-]+)["']?\s*:\s*(.*)$/.exec(uncomment(lines[j]));
      const key = FILTERS.find((f) => f === m?.[1]);
      if (!m || !key || indent(lines[j]) !== indent(lines[own[0]])) continue;
      const value = m[2].trim();
      trigger[key] = value
        ? value
            .replace(/^\[|\]$/g, '')
            .split(',')
            .map(unquote)
            .filter(Boolean)
        : block(j + 1, indent(lines[j]))
            .map((k) => /^\s*-\s*(.*)$/.exec(uncomment(lines[k]))?.[1])
            .filter((v): v is string => v !== undefined)
            .map(unquote);
    }
    return trigger;
  }
  return undefined;
}

/** Whether a GitHub Actions filter pattern matches a ref name (* stays within a /, ** doesn't). */
const filterMatch = (pattern: string, ref: string) => picomatch.isMatch(ref, pattern, { dot: true });

/**
 * Why a push trigger doesn't run on a push to branch, as the filter that leaves it out ("branches: main, feature/**");
 * undefined when it runs. As GitHub reads them: branches lets in what its last matching pattern does (a ! one keeps
 * out), branches-ignore keeps out what any of its patterns matches, and tags without branches filters keep out every
 * branch.
 */
export function branchFilterWhy(trigger: PushTrigger, branch: string): string | undefined {
  const { branches, 'branches-ignore': ignore } = trigger;
  if (branches) {
    let runs = false;
    for (const p of branches) if (filterMatch(p.replace(/^!/, ''), branch)) runs = !p.startsWith('!');
    return runs ? undefined : `branches: ${branches.join(', ')}`;
  }
  if (ignore) return ignore.some((p) => filterMatch(p, branch)) ? `branches-ignore: ${ignore.join(', ')}` : undefined;
  const tags = trigger.tags ?? trigger['tags-ignore'];
  if (tags) return `${trigger.tags ? 'tags' : 'tags-ignore'}: ${tags.join(', ')} (no branches)`;
  return undefined;
}

/** Whether a workflow file runs on push (to branch, when given: its branch filters let it in). */
export function runsOnPush(workflowYaml: string, branch?: string): boolean {
  const trigger = pushTrigger(workflowYaml);
  return !!trigger && (branch === undefined || !branchFilterWhy(trigger, branch));
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

/** Whether a remote's URL is on this machine (a path or file://), not on the network (https://, ssh://, host:path). */
export function isLocalUrl(url: string): boolean {
  const u = url.trim();
  if (!u) return false;
  if (/^file:\/\//i.test(u)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return false;
  if (/^[a-z]:[\\/]/i.test(u)) return true;
  return !/^[^/\\]*:/.test(u);
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
 * branch's history: a push that would need force isn't made, unless origin's branch is where Flotilla pushed it
 * (leased: its last push) and the branch was rewritten since: that one goes with `--force-with-lease` on it.
 */
export async function pushBranch(cwd: string, branch: string, o: { leased?: string } = {}): Promise<PushResult> {
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
  const rewritten =
    !!remoteCommit &&
    !(await runGit(['merge-base', '--is-ancestor', remoteCommit, commit], { cwd }).then(
      () => true,
      () => false,
    ));
  // Rewritten over someone else's push (or one Flotilla doesn't know): never forced.
  if (rewritten && remoteCommit !== o.leased) return { kind: 'force', branch, commit, remoteCommit };

  try {
    // Otherwise a plain push, refused by git when it isn't a fast-forward; a rewritten branch only over Flotilla's own push.
    const lease = rewritten ? [`--force-with-lease=refs/heads/${branch}:${remoteCommit}`] : [];
    await runGit(['push', '--set-upstream', ...lease, PUSH_REMOTE, `refs/heads/${branch}:refs/heads/${branch}`], { cwd, timeoutMs: 120_000 });
  } catch (e) {
    return failed(`Pushing failed: ${message(e)}`);
  }
  return { kind: 'pushed', branch, commit, count: log.length, ...(rewritten ? { rewritten } : {}) };
}

/** The ticket's note of a push (none when origin already had it). */
export function pushNote(r: PushResult): string | undefined {
  const b = `\`${r.branch}\``;
  switch (r.kind) {
    case 'pushed':
      return r.rewritten
        ? `Pushed ${b} to origin at \`${short(r.commit)}\`, replacing its rewritten history (\`--force-with-lease\` on Flotilla's last push), so CI runs on it.`
        : `Pushed ${b} to origin at \`${short(r.commit)}\` (${r.count} new commit${r.count === 1 ? '' : 's'}), so CI runs on it.`;
    case 'up-to-date':
      return undefined;
    case 'identity':
      return [
        `Didn't push ${b} to origin: ${r.strangers.length === 1 ? 'a commit has' : `${r.strangers.length} commits have`} another identity than the repository's (\`${r.identity}\`):`,
        '',
        ...r.strangers
          .slice(0, 10)
          .map((c) => `- \`${short(c.commit)}\` ${c.subject}: author \`${c.author}\`${c.committer !== c.author ? `, committer \`${c.committer}\`` : ''}`),
        ...(r.strangers.length > 10 ? [`- and ${r.strangers.length - 10} more`] : []),
        '',
        "Rewrite them with the repository's identity (or push yourself, if that's intended). Merge to main runs the checks locally.",
      ].join('\n');
    case 'force':
      return `Didn't push ${b} to origin: origin's \`${r.branch}\` (\`${short(r.remoteCommit)}\`) isn't in the branch's history and isn't what Flotilla pushed, so it would take a force push, which Flotilla never does over others' commits. Take origin's commits into the branch (or remove the branch on origin), and it's pushed again on the branch's next commit.`;
    case 'failed':
      return `Couldn't push ${b} to origin: ${r.reason}\n\n${r.hint} Merge to main runs the checks locally.`;
  }
}

/** The PushedInfo kept on the item after a push. */
export function pushedInfo(r: PushResult): PushedInfo {
  const error = r.kind === 'pushed' || r.kind === 'up-to-date' ? undefined : r.kind;
  return { branch: r.branch, commit: r.commit, ...(error ? { error } : {}) };
}

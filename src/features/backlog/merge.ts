import * as fs from 'node:fs';
import * as path from 'node:path';
import { GitError, runGit } from '../../core/git/gitCli';
import type { BacklogItem } from './backlog';

/**
 * Merging a ticket's branch into the base branch, from the ticket. The merge is made in a temporary worktree outside
 * the user's folders (so none of theirs is ever left mid-merge), checked there, and only then does the base branch
 * fast-forward to it. Nothing is pushed.
 */

/** A merge waiting for a decision: its conflicts being resolved by an agent, or resolved and waiting for the user. */
export interface MergeState {
  /** The temporary worktree the merge is in (under mergeRoot()). */
  dir: string;
  branch: string;
  /** The local branch it merges into, and where that was when the merge started. */
  base: string;
  baseTip: string;
  /** resolving: an agent is at the conflicts; resolved: it reported, for the user to approve; failed: see reason. */
  state: 'resolving' | 'resolved' | 'failed';
  agent?: string;
  session?: string;
  reason?: string;
  /** The checks failed on the merge (state failed): their command, and the end of their output. */
  checks?: { command: string; output: string; /** ISO 8601: when they failed. */ at?: string };
  /** The worktree's HEAD when an agent started fixing the checks: its fix is a commit on top of it. */
  from?: string;
  /**
   * A merge of a ticket in the merge train (BL-146): baseTip is the train's commit before it (onto base and the tickets
   * ahead, its ids). Approving it records the resolution (rerere) and rebuilds the train, which lands the ticket.
   */
  train?: { ahead: string[] };
  /** ISO 8601. */
  started: string;
}

/** The end of the checks' output, without terminal colours: what the ticket shows and the fixing agent is given. */
export function outputTail(text: string, maxLines = 120, maxChars = 10_000): string {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '').replace(/\r\n?/g, '\n').trimEnd();
  // Runs of blank lines as one.
  const lines = plain.split('\n').filter((l, i, all) => l.trim() || (i > 0 && all[i - 1].trim()));
  const tail = lines.slice(-maxLines).join('\n');
  return tail.length > maxChars ? tail.slice(tail.length - maxChars).replace(/^[^\n]*\n/, '') : tail;
}

/**
 * How many tests (or hooks) timed out in a check run's output, when that's all that failed (vitest's "Test timed out"
 * / "Hook timed out", with no other error: no assertion, type or lint failure); 0 otherwise. Such a run is often only a
 * loaded machine, so it's worth running once more before an agent looks at it (BL-124).
 */
export function timeoutsOnly(output: string): number {
  // eslint-disable-next-line no-control-regex
  const lines = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/);
  const timeout = /\b(?:Test|Hook) timed out\b/;
  // Error lines: "Error: …", "AssertionError: …", tsc's "error TS2322: …", ESLint's "  12:3  error  …".
  const error = /^\s*(?:[A-Z]\w*)?Error\b[^:]*:|\berror TS\d+:|^\s*\d+:\d+\s+error\s/;
  let timeouts = 0;
  for (const line of lines) {
    if (timeout.test(line)) timeouts++;
    else if (error.test(line)) return 0;
  }
  return timeouts;
}

/** Where an item's branch was merged: the base branch, and the merge commit. */
export interface MergedInfo {
  into: string;
  commit: string;
  /** ISO 8601. */
  date: string;
}

/** The message of a ticket's merge commit. */
export function mergeMessage(item: Pick<BacklogItem, 'id' | 'title'>): string {
  return `Merge ${item.id}: ${item.title}`;
}

/** Which of ids a text mentions, as a whole id ("BL-1" isn't in "BL-12"). */
export function idsIn(text: string, ids: readonly string[]): string[] {
  return ids.filter((id) => {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9])${escaped}(?![0-9])`, 'i').test(text);
  });
}

/**
 * The other tickets a branch carries commits of that aren't done (their ids in its commit messages): merging it would
 * merge their unfinished work too. The item itself, its linked issues, its parent (an epic) and its parts don't count.
 */
export function blockingItems(item: Pick<BacklogItem, 'id' | 'links' | 'parent'>, messages: readonly string[], items: readonly BacklogItem[]): BacklogItem[] {
  const own = new Set([item.id, ...(item.parent ? [item.parent] : []), ...(item.links ?? []).map((l) => l.id)].map((i) => i.toLowerCase()));
  const others = items.filter((i) => !own.has(i.id.toLowerCase()) && i.parent !== item.id && i.status !== 'done');
  const text = messages.join('\n');
  const found = new Set(idsIn(text, others.map((i) => i.id)).map((i) => i.toLowerCase()));
  return others.filter((i) => found.has(i.id.toLowerCase()));
}

/**
 * An order to merge branches in, dependencies first: a branch that contains another's commits goes after it (contains
 * (a, b): a has b's commits). Otherwise the order given is kept.
 */
export function mergeOrder<T>(entries: readonly T[], contains: (a: T, b: T) => boolean): T[] {
  const left = [...entries];
  const out: T[] = [];
  while (left.length) {
    // The first one that needs none of the others left (in a cycle, the first one).
    const at = Math.max(0, left.findIndex((a) => !left.some((b) => b !== a && contains(a, b))));
    out.push(...left.splice(at, 1));
  }
  return out;
}

/**
 * The checks to run after a merge when flotilla.merge.checkCommand isn't set: the repository's typecheck and test
 * scripts, if its package.json has them (run with its package manager, from its lock file).
 */
export function defaultCheckCommand(packageJson: string | undefined, lockFiles: readonly string[] = []): string | undefined {
  if (!packageJson) return undefined;
  let scripts: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: unknown };
    if (parsed.scripts && typeof parsed.scripts === 'object') scripts = parsed.scripts as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const pm = lockFiles.includes('pnpm-lock.yaml') ? 'pnpm' : lockFiles.includes('yarn.lock') ? 'yarn' : 'npm';
  const run = (s: string) => (pm === 'npm' ? (s === 'test' ? 'npm test' : `npm run ${s}`) : `${pm} ${s}`);
  const commands = ['typecheck', 'test'].filter((s) => typeof scripts[s] === 'string' && (scripts[s] as string).trim()).map(run);
  return commands.length ? commands.join(' && ') : undefined;
}

/** The checks for a worktree: the setting, else the default from its package.json. */
export async function checkCommand(dir: string, configured: string): Promise<string | undefined> {
  if (configured.trim()) return configured.trim();
  const pkg = await fs.promises.readFile(path.join(dir, 'package.json'), 'utf8').catch(() => undefined);
  const locks = ['pnpm-lock.yaml', 'yarn.lock'].filter((f) => fs.existsSync(path.join(dir, f)));
  return defaultCheckCommand(pkg, locks);
}

const rev = async (cwd: string, ref: string) => (await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd })).trim();

/**
 * The local branch to merge into for a base (resolveBase may give "origin/main": its local "main"); undefined if there's
 * none.
 */
export async function localBase(cwd: string, base: string): Promise<string | undefined> {
  const candidates = [base, base.replace(/^[^/]+\//, '')];
  for (const c of candidates) {
    if (await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${c}`], { cwd }).then(() => true, () => false)) return c;
  }
  return undefined;
}

/** What a branch would merge: its commits' messages (not on base), and whether it looks superseded or already merged. */
export interface BranchCheck {
  tip: string;
  baseTip: string;
  /** Its commits that base doesn't have, newest first. */
  commits: Array<{ hash: string; message: string }>;
  /** Nothing to merge: base has all its commits. */
  merged: boolean;
  /** Nothing it changes differs from base (its work is there already, in other commits). */
  superseded: boolean;
}

export async function checkBranch(cwd: string, base: string, branch: string): Promise<BranchCheck> {
  const [tip, baseTip] = await Promise.all([rev(cwd, `refs/heads/${branch}`), rev(cwd, `refs/heads/${base}`)]);
  const log = await runGit(['log', '--format=%H%x00%B%x1e', `${baseTip}..${tip}`], { cwd });
  const commits = log
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, ...rest] = r.split('\x00');
      return { hash, message: rest.join('\x00').trim() };
    });
  if (!commits.length) return { tip, baseTip, commits, merged: true, superseded: false };
  const start = (await runGit(['merge-base', baseTip, tip], { cwd })).trim();
  const changed = (await runGit(['diff', '--name-only', '--no-renames', start, tip, '--'], { cwd })).split('\n').filter(Boolean);
  // Its files as they are on base: none differs, and it changes nothing base doesn't have.
  const differs = changed.length
    ? (await runGit(['diff', '--name-only', '--no-renames', baseTip, tip, '--', ...changed], { cwd, env: { GIT_LITERAL_PATHSPECS: '1' } })).trim()
    : '';
  return { tip, baseTip, commits, merged: false, superseded: !differs };
}

export type MergeOutcome = { kind: 'merged'; commit: string } | { kind: 'conflicts'; files: string[] };

/** The files with conflicts in a worktree. */
export async function conflictedFiles(dir: string): Promise<string[]> {
  return (await runGit(['diff', '--name-only', '--diff-filter=U'], { cwd: dir })).split('\n').filter(Boolean);
}

/**
 * Merges branch into base in a new temporary worktree at dir (detached at base's tip): `git merge --no-ff`, with the
 * repository's configured identity. Conflicts are left there to resolve; any other failure removes the worktree.
 */
export async function mergeInWorktree(
  cwd: string,
  o: { dir: string; baseTip: string; branch: string; message: string },
): Promise<MergeOutcome> {
  await fs.promises.mkdir(path.dirname(o.dir), { recursive: true });
  await runGit(['worktree', 'add', '--detach', o.dir, o.baseTip], { cwd, timeoutMs: 120_000 });
  try {
    await runGit(['merge', '--no-ff', '--no-edit', '-m', o.message, `refs/heads/${o.branch}`], {
      cwd: o.dir,
      timeoutMs: 120_000,
      env: { GIT_MERGE_AUTOEDIT: 'no', GIT_EDITOR: ':' },
    });
  } catch (error) {
    const files = await conflictedFiles(o.dir).catch(() => []);
    if (files.length) return { kind: 'conflicts', files };
    await removeMergeWorktree(cwd, o.dir).catch(() => undefined);
    throw error;
  }
  return { kind: 'merged', commit: await rev(o.dir, 'HEAD') };
}

/**
 * Whether a merge in dir is finished (committed, no conflicts left): the commit to move the base to, or what's missing.
 * That's the merge commit on top of baseTip, or fixes committed after it (an agent fixing the checks, BL-65): plain
 * commits whose messages start with the item's id. merge is the merge commit; fixes, the fixes' subjects, oldest first.
 * With redo, a merge made again onto where the base is now (BL-149) is taken too: a merge commit whose first parent is
 * on redo.base, after baseTip, and whose second is on redo.branch. onto is the merge's first parent: its base.
 */
export async function mergeResult(
  dir: string,
  baseTip: string,
  id?: string,
  redo?: { base: string; branch: string },
): Promise<{ commit: string; merge: string; onto: string; fixes: string[] } | { problem: string }> {
  const conflicts = await conflictedFiles(dir).catch(() => []);
  if (conflicts.length) return { problem: `${conflicts.length} file${conflicts.length === 1 ? ' still has' : 's still have'} conflicts (${conflicts.slice(0, 5).join(', ')}).` };
  const merging = await runGit(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd: dir }).then(() => true, () => false);
  if (merging) {
    // Resolved, not committed: committed here, with the merge's message.
    await runGit(['commit', '--no-edit'], { cwd: dir, env: { GIT_EDITOR: ':' } });
  }
  const head = await rev(dir, 'HEAD');
  // The commits on top of baseTip, newest first: hash, parents, then the subject.
  const log = (await runGit(['log', '--first-parent', '--format=%H %P%x00%s', `${baseTip}..${head}`], { cwd: dir })).split('\n').filter(Boolean);
  const commits = log.map((l) => {
    const [hashes, subject = ''] = l.split('\x00');
    const [hash, ...parents] = hashes.trim().split(/\s+/);
    return { hash, parents, subject };
  });
  const isFix = (c: (typeof commits)[number]) => c.parents.length === 1 && !!id && startsWithId(c.subject, id);
  const dirty = async () => !!(await runGit(['status', '--porcelain', '--untracked-files=no'], { cwd: dir })).trim();
  // Made again onto the base as it is now: the fixes, then that merge; the base's own commits below it don't count.
  const last = commits.findIndex((c) => !isFix(c));
  const again = last >= 0 && redo ? commits[last] : undefined;
  if (again && again.parents.length === 2 && again.parents[0] !== baseTip) {
    const ancestor = (a: string, b: string) => runGit(['merge-base', '--is-ancestor', a, b], { cwd: dir }).then(() => true, () => false);
    const [onBase, ofBranch] = await Promise.all([ancestor(again.parents[0], `refs/heads/${redo!.base}`), ancestor(again.parents[1], `refs/heads/${redo!.branch}`)]);
    if (onBase && ofBranch) {
      if (await dirty()) return { problem: 'its worktree has uncommitted changes.' };
      return { commit: head, merge: again.hash, onto: again.parents[0], fixes: commits.slice(0, last).reverse().map((c) => c.subject) };
    }
  }
  const merge = commits.at(-1);
  if (!merge || merge.parents.length < 2 || merge.parents[0] !== baseTip) return { problem: 'its worktree has no merge commit on top of the base branch.' };
  const fixes = commits.slice(0, -1).reverse();
  const stray = fixes.find((c) => !isFix(c));
  if (stray) {
    return {
      problem: `${stray.hash.slice(0, 7)} "${stray.subject}" after the merge commit isn't a fix of it (${stray.parents.length !== 1 ? 'it merges' : `its message doesn't start with ${id ?? "the ticket's id"}`}).`,
    };
  }
  if (await dirty()) return { problem: 'its worktree has uncommitted changes.' };
  return { commit: head, merge: merge.hash, onto: baseTip, fixes: fixes.map((c) => c.subject) };
}

const startsWithId = (subject: string, id: string) => subject.toLowerCase().startsWith(id.toLowerCase()) && !/[0-9]/.test(subject.charAt(id.length));

/** The folder temporary merge worktrees go in: under the OS's temp folder, never in the user's. */
export function mergeRoot(tmp: string): string {
  return path.join(tmp, 'flotilla-merge');
}

/** Whether dir is a temporary merge worktree's folder (a path read from backlog.json is checked before it's removed). */
export function isMergeDir(dir: string, tmp: string): boolean {
  const root = path.resolve(mergeRoot(tmp));
  const resolved = path.resolve(dir);
  const rel = path.relative(root, resolved);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep);
}

/** Links the main worktree's node_modules into a merge worktree, so its checks can run there; the link, if made. */
export async function linkDependencies(dir: string, from: string): Promise<string | undefined> {
  const source = path.join(from, 'node_modules');
  const link = path.join(dir, 'node_modules');
  if (!fs.existsSync(path.join(dir, 'package.json')) || !fs.existsSync(source) || fs.existsSync(link)) return undefined;
  await fs.promises.symlink(source, link, process.platform === 'win32' ? 'junction' : 'dir');
  return link;
}

/** Removes a link made by linkDependencies (only the link: never what it points to). */
async function unlinkDependencies(dir: string): Promise<void> {
  const link = path.join(dir, 'node_modules');
  const stat = await fs.promises.lstat(link).catch(() => undefined);
  if (!stat?.isSymbolicLink()) return;
  await fs.promises.unlink(link).catch(() => fs.promises.rmdir(link));
  if (await fs.promises.lstat(link).then(() => true, () => false)) throw new Error(`Couldn't remove the link ${link}.`);
}

/** Removes a temporary merge worktree (aborting a merge in progress there), and git's record of it. */
export async function removeMergeWorktree(cwd: string, dir: string): Promise<void> {
  await unlinkDependencies(dir);
  // A real node_modules (not our link) is never removed with it.
  if ((await fs.promises.lstat(path.join(dir, 'node_modules')).catch(() => undefined))?.isDirectory()) {
    throw new Error(`${dir} has a node_modules folder that isn't Flotilla's link; remove the folder yourself.`);
  }
  await runGit(['merge', '--abort'], { cwd: dir }).catch(() => undefined);
  try {
    await runGit(['worktree', 'remove', '--force', '--force', dir], { cwd, timeoutMs: 120_000 });
  } catch (error) {
    if (fs.existsSync(dir) && !(error instanceof GitError && /is not a working tree/.test(error.stderr))) throw error;
  }
  await runGit(['worktree', 'prune'], { cwd }).catch(() => undefined);
}

/**
 * Moves base to the merge commit, only as a fast-forward from where it was (baseTip). In the worktree that has base
 * checked out (worktree), `git merge --ff-only` updates its files too: the caller checks it has no uncommitted
 * changes first. Without one, the branch ref moves (only if it's still at baseTip).
 */
export async function fastForward(cwd: string, o: { base: string; baseTip: string; commit: string; worktree?: string; message: string }): Promise<void> {
  const now = await rev(cwd, `refs/heads/${o.base}`);
  if (now !== o.baseTip) throw new Error(`${o.base} moved since the merge started (it was at ${o.baseTip.slice(0, 7)}, it's at ${now.slice(0, 7)}): merge again.`);
  if (o.worktree) await runGit(['merge', '--ff-only', o.commit], { cwd: o.worktree, timeoutMs: 120_000 });
  else await runGit(['update-ref', '-m', `flotilla: ${o.message}`, `refs/heads/${o.base}`, o.commit, o.baseTip], { cwd });
}

/** Uncommitted changes in a worktree (untracked files aside): a fast-forward doesn't touch a worktree that has them. */
export async function hasUncommittedChanges(dir: string): Promise<boolean> {
  return !!(await runGit(['status', '--porcelain', '--untracked-files=no'], { cwd: dir })).trim();
}

/** The commits on one side of a merge touching some files, as "abc1234 subject" lines, oldest first. */
export async function commitsTouching(cwd: string, from: string, to: string, files: readonly string[]): Promise<string[]> {
  if (!files.length) return [];
  const out = await runGit(['log', '--reverse', '--format=%h %s', `${from}..${to}`, '--', ...files], { cwd, env: { GIT_LITERAL_PATHSPECS: '1' } });
  return out.split('\n').filter(Boolean);
}

/**
 * What the agent fixing a merge whose checks failed is told (after its lead line): the merge committed cleanly (or its
 * conflicts were resolved), but together the two sides break the checks. It fixes that in a commit of its own on top
 * of the merge, or asks in the ticket when the two intents can't both be kept.
 */
export function fixChecksPrompt(o: {
  item: Pick<BacklogItem, 'id' | 'title'>;
  agent: string;
  ticket: string;
  branch: string;
  base: string;
  start: string;
  description: string;
  checks: { command: string; output: string };
  /** The base's commits since the branch started, as "abc1234 subject" lines. */
  ours: readonly string[];
  /** The tickets those commits are of. */
  others: ReadonlyArray<{ id: string; title: string; description: string; ticket: string }>;
}): string {
  const quote = (s: string) => (s.trim() ? s.trim().replace(/^/gm, '> ') : '> (no description)');
  const short = o.start.slice(0, 12);
  const ours = o.ours.length ? o.ours.slice(-30).map((l) => `- ${l}`).join('\n') + (o.ours.length > 30 ? `\n- (and ${o.ours.length - 30} older)` : '') : '- (none)';
  return [
    `Your task: fix the checks on the merge of ${o.item.id}'s branch ${o.branch} into ${o.base}. This is a temporary git worktree, detached, with the merge committed (\`git merge --no-ff ${o.branch}\` onto ${o.base}), but the checks fail on it: each side passed on its own, so it's the two together that break. The checks: \`${o.checks.command}\`. The end of their output:`,
    `\`\`\`text\n${o.checks.output.trim() || '(no output)'}\n\`\`\``,
    `${o.item.id} "${o.item.title}" (the branch being merged), as its ticket ${o.ticket} describes it:\n\n${quote(o.description)}`,
    `What ${o.base} has that ${o.branch} didn't (\`git log ${short}..HEAD^1\`):\n${ours}`,
    ...(o.others.length ? [`Those changes on ${o.base} are from:\n\n${o.others.map((t) => `${t.id} "${t.title}" (${t.ticket}):\n\n${quote(t.description)}`).join('\n\n')}`] : []),
    `Keep both intents: what ${o.item.id} does, and what ${o.base}'s changes do; don't drop or disable either side's code or tests to make the checks pass. Read the ticket's latest activity first: the user may have answered a question of yours there. Fix what the two sides break together, run the checks (\`${o.checks.command}\`) until they pass, then commit your fix on top of the merge, as a commit of its own whose message starts with "${o.item.id}: " (\`git commit -m "${o.item.id}: Fix the checks after merging ${o.base}"\`, or say what you fixed). Don't amend the merge commit, don't change any other branch or worktree, don't rebase or reset, and don't push.`,
    `If the two intents can't both be kept (they want opposite things: a design conflict), don't pick a side: commit nothing, and ask in the ticket instead. In your report, after its summary, put the question in a block fenced with \`\`\`question: its first line the question, then the choices as "- " lines, the one you suggest marked "(recommended)". The user answers there and starts you again.`,
    `Then report in the ticket ${o.ticket}: append an entry at the end of its "## Activity" section, a heading "### YYYY-MM-DD HH:MM · Agent ${o.agent}" (local time), then what broke, how you fixed it and why, and whether the checks pass (or your question). The user reads it and approves the fix from the ticket; Flotilla then runs the checks again and moves ${o.base} to the merge. Don't end it with "Ready for review.".`,
  ].join('\n\n');
}

/** What the agent resolving a merge's conflicts is told (after its lead line, which names it and the item). */
export function resolvePrompt(o: {
  item: Pick<BacklogItem, 'id' | 'title'>;
  agent: string;
  ticket: string;
  branch: string;
  base: string;
  start: string;
  files: readonly string[];
  description: string;
  ours: readonly string[];
  theirs: readonly string[];
  others: ReadonlyArray<{ id: string; title: string; description: string }>;
  checks?: string;
  /** Why the merge stopped after its conflicts were resolved (the checks failed): what to fix. */
  problem?: string;
  /** The base moved since the merge was made (BL-149): it's made again onto it. */
  moved?: boolean;
}): string {
  const quote = (s: string) => (s.trim() ? s.trim().replace(/^/gm, '> ') : '> (no description)');
  const list = (lines: readonly string[]) => (lines.length ? lines.map((l) => `- ${l}`).join('\n') : '- (none touching these files)');
  const short = o.start.slice(0, 12);
  const fixing = !o.files.length;
  return [
    o.moved
      ? `Your task: merge ${o.item.id}'s branch ${o.branch} again into ${o.base}. This is a temporary git worktree with the merge committed (its conflicts were resolved), but ${o.base} moved since, so it stopped: ${o.problem ?? 'merge again'}. Make the merge again onto ${o.base} as it is now: note the earlier merge (\`git rev-parse HEAD\`), then \`git checkout --detach ${o.base}\` and \`git merge --no-ff --no-edit ${o.branch}\`, and resolve its conflicts as the earlier merge did (\`git checkout <earlier> -- <file>\` where ${o.base}'s new changes don't touch the file). Flotilla takes one merge commit whose first parent is ${o.base}'s tip and whose second is ${o.branch}, with only commits whose messages start with "${o.item.id}: " on top of it.`
      : fixing
      ? `Your task: finish merging ${o.item.id}'s branch ${o.branch} into ${o.base}. This is a temporary git worktree, detached at ${o.base}, with the merge committed (its conflicts were resolved), but it stopped: ${o.problem ?? 'it needs fixing'}. Fix that in the merge (\`git commit --amend --no-edit\` keeps it one merge commit).`
      : `Your task: resolve the conflicts of merging ${o.item.id}'s branch ${o.branch} into ${o.base}. This is a temporary git worktree, detached at ${o.base}, in the middle of that merge (\`git merge --no-ff ${o.branch}\`). The conflicted files: ${o.files.map((f) => `\`${f}\``).join(', ')}.`,
    `${o.item.id} "${o.item.title}" (the branch being merged), as its ticket ${o.ticket} describes it:\n\n${quote(o.description)}\n\nIts commits touching those files (\`git log ${short}..${o.branch} -- <file>\`):\n${list(o.theirs)}`,
    `What ${o.base} changed in them since ${o.branch} started (\`git log ${short}..HEAD -- <file>\`):\n${list(o.ours)}`,
    ...(o.others.length ? [`Those changes on ${o.base} are from:\n\n${o.others.map((t) => `${t.id} "${t.title}":\n\n${quote(t.description)}`).join('\n\n')}`] : []),
    fixing
      ? `Keep both sides' intent: what ${o.item.id} does, and what ${o.base}'s changes do.${o.checks ? ` Run the checks (\`${o.checks}\`) until they pass.` : ''} ${o.moved ? 'Commit the merge with `git commit --no-edit` (keep its message), and amend it with your fixes.' : 'Amend the merge commit with your fixes.'} Don't change any other branch or worktree, don't rebase or reset, and don't push.`
      : `Keep both sides' intent: what ${o.item.id} does, and what ${o.base}'s changes do; don't drop either to make the conflict go away. Resolve every conflict, \`git add\` the files${o.checks ? `, run the checks (\`${o.checks}\`) and fix what they find` : ''}, then commit the merge with \`git commit --no-edit\` (keep its message). Don't change any other branch or worktree, don't rebase or reset, and don't push.`,
    `Then report in the ticket ${o.ticket}: append an entry at the end of its "## Activity" section, a heading "### YYYY-MM-DD HH:MM · Agent ${o.agent}" (local time) followed by how you resolved ${fixing ? 'it' : 'each conflict'} and why${o.checks ? ', and whether the checks pass' : ''}. The user reads it and approves the resolution from the ticket; Flotilla then runs the checks and moves ${o.base} to the merge. Don't end it with "Ready for review.".`,
  ].join('\n\n');
}

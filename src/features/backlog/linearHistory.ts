import * as fs from 'node:fs';
import * as path from 'node:path';
import { runGit } from '../../core/git/gitCli';
import { conflictedFiles, removeMergeWorktree } from './merge';

export { mergeStyle, type MergeStyle } from './tidyNotes';

/**
 * A tidy, linear history (BL-181): agents rebase their branch onto main instead of merging it in, and tidy their
 * commits into the steps a reviewer reads before they report; with `flotilla.merge.style` `fast-forward` (the default),
 * a ticket lands by rebasing its branch onto main (squashing its `fixup!` commits) and moving main to that tip.
 */

const REBASE_ENV = { GIT_EDITOR: ':', GIT_SEQUENCE_EDITOR: ':', GIT_MERGE_AUTOEDIT: 'no' };

/** Whether a rebase is in progress in dir (stopped on conflicts). */
export async function rebasing(dir: string): Promise<boolean> {
  const paths = (await runGit(['rev-parse', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply'], { cwd: dir })).split('\n').filter(Boolean);
  return paths.some((p) => fs.existsSync(path.resolve(dir, p.trim())));
}

/** Whether there are fixup!/squash! commits in from..to. */
export async function hasFixups(dir: string, from: string, to: string): Promise<boolean> {
  const subjects = (await runGit(['log', '--format=%s', `${from}..${to}`], { cwd: dir })).split('\n');
  return subjects.some((s) => /^(fixup|squash|amend)! /.test(s));
}

export type RebaseOutcome = { kind: 'rebased'; commit: string; rebased: boolean } | { kind: 'conflicts'; files: string[] };

/**
 * Rebases what's checked out in dir (detached) onto onto, squashing its fixup! commits (`--autosquash`), with rerere
 * on when asked (the train). Nothing to do (onto is in it, no fixups): rebased false. Conflicts are left there, the
 * rebase stopped on them; any other failure aborts it and throws.
 */
export async function rebaseInDir(dir: string, onto: string, o: { rerere?: boolean } = {}): Promise<RebaseOutcome> {
  const head = async () => (await runGit(['rev-parse', 'HEAD'], { cwd: dir })).trim();
  const before = await head();
  const contained = await runGit(['merge-base', '--is-ancestor', onto, before], { cwd: dir }).then(
    () => true,
    () => false,
  );
  if (contained && !(await hasFixups(dir, onto, before))) return { kind: 'rebased', commit: before, rebased: false };
  const rerere = o.rerere ? ['-c', 'rerere.enabled=true', '-c', 'rerere.autoUpdate=true'] : [];
  try {
    await runGit([...rerere, 'rebase', '-i', '--autosquash', '--empty=drop', onto], { cwd: dir, timeoutMs: 300_000, env: REBASE_ENV });
  } catch (error) {
    const files = await conflictedFiles(dir).catch(() => []);
    if (files.length) return { kind: 'conflicts', files };
    // rerere resolved what stopped it: go on while it can.
    if (o.rerere && (await rebasing(dir))) {
      const went = await continueRebase(dir, rerere);
      if (went.kind === 'rebased') return went;
      if (went.files.length) return went;
    }
    await runGit(['rebase', '--abort'], { cwd: dir }).catch(() => undefined);
    throw error;
  }
  return { kind: 'rebased', commit: await head(), rebased: true };
}

/**
 * Merge to main with fast-forward (BL-181): in a new temporary worktree at dir, detached at the branch's tip, the
 * branch rebased onto baseTip when it isn't on top of it (or has fixup! commits to squash). Conflicts are left there,
 * the rebase stopped on them; any other failure removes the worktree.
 */
export async function rebaseInWorktree(cwd: string, o: { dir: string; baseTip: string; branch: string; rerere?: boolean }): Promise<RebaseOutcome> {
  await fs.promises.mkdir(path.dirname(o.dir), { recursive: true });
  await runGit(['worktree', 'add', '--detach', o.dir, `refs/heads/${o.branch}`], { cwd, timeoutMs: 120_000 });
  try {
    return await rebaseInDir(o.dir, o.baseTip, { rerere: o.rerere });
  } catch (error) {
    await removeMergeWorktree(cwd, o.dir).catch(() => undefined);
    throw error;
  }
}

/** Goes on with a rebase stopped in dir whose conflicts are all resolved (and staged), until it ends or stops again. */
export async function continueRebase(dir: string, rerere: string[] = []): Promise<RebaseOutcome> {
  for (let i = 0; i < 1000 && (await rebasing(dir)); i++) {
    const files = await conflictedFiles(dir).catch(() => []);
    if (files.length) return { kind: 'conflicts', files };
    await runGit(['add', '-u'], { cwd: dir });
    const went = await runGit([...rerere, 'rebase', '--continue'], { cwd: dir, timeoutMs: 300_000, env: REBASE_ENV }).then(
      () => true,
      () => false,
    );
    if (!went) {
      const left = await conflictedFiles(dir).catch(() => []);
      if (left.length) return { kind: 'conflicts', files: left };
      // Nothing left to commit in this step (its change is in onto already): skipped.
      if (await rebasing(dir)) await runGit(['rebase', '--skip'], { cwd: dir, env: REBASE_ENV }).catch(() => undefined);
    }
  }
  return { kind: 'rebased', commit: (await runGit(['rev-parse', 'HEAD'], { cwd: dir })).trim(), rebased: true };
}

/**
 * Whether a rebase in dir is finished onto baseTip: the tip to move the base to, or what's missing. The commits on
 * top of baseTip are plain (no merges), each starting with the item's id (a fixup! of one, too).
 */
export async function rebaseResult(dir: string, baseTip: string, id: string): Promise<{ commit: string; count: number } | { problem: string }> {
  const conflicts = await conflictedFiles(dir).catch(() => []);
  if (conflicts.length)
    return { problem: `${conflicts.length} file${conflicts.length === 1 ? ' still has' : 's still have'} conflicts (${conflicts.slice(0, 5).join(', ')}).` };
  if (await rebasing(dir)) return { problem: 'the rebase is still in progress (`git rebase --continue`).' };
  const head = (await runGit(['rev-parse', 'HEAD'], { cwd: dir })).trim();
  if (
    !(await runGit(['merge-base', '--is-ancestor', baseTip, head], { cwd: dir }).then(
      () => true,
      () => false,
    ))
  ) {
    return { problem: `its worktree isn't on top of the base branch (${baseTip.slice(0, 7)}).` };
  }
  const log = (await runGit(['log', '--format=%H %P%x00%s', `${baseTip}..${head}`], { cwd: dir })).split('\n').filter(Boolean);
  if (!log.length) return { problem: 'nothing is on top of the base branch.' };
  for (const l of log) {
    const [hashes, subject = ''] = l.split('\x00');
    const [hash, ...parents] = hashes.trim().split(/\s+/);
    if (parents.length !== 1) return { problem: `${hash.slice(0, 7)} "${subject}" is a merge commit: the history is to be linear.` };
    const own = subject.replace(/^((fixup|squash|amend)! )+/, '');
    if (!startsWithId(own, id)) return { problem: `${hash.slice(0, 7)} "${subject}" doesn't start with ${id}.` };
  }
  if ((await runGit(['status', '--porcelain', '--untracked-files=no'], { cwd: dir })).trim()) return { problem: 'its worktree has uncommitted changes.' };
  return { commit: head, count: log.length };
}

const startsWithId = (subject: string, id: string) => subject.toLowerCase().startsWith(id.toLowerCase()) && !/[0-9]/.test(subject.charAt(id.length));

import { runGit } from '../../core/git/gitCli';
import { readyToMerge, type BacklogData, type BacklogItem } from './backlog';
import { conflictedFiles, removeMergeWorktree } from './merge';

/**
 * The merge queue (BL-140): the tickets waiting to land, in order, and the train built from it: a throwaway branch
 * (flotilla/train) made of the base with each queued ticket's branch merged on, `--no-ff`, in queue order. A ticket
 * that conflicts with the train ahead of it is left out of it (the ones behind it are merged as if it weren't there).
 * Landing a ticket moves the base forward to its merge commit in the train: what was merged and checked is what lands.
 */

/** The branch the train is kept on. */
export const TRAIN_BRANCH = 'flotilla/train';

/** A queued ticket in the train: its merge commit, or the files it conflicts on with the train ahead of it. */
export interface TrainEntry {
  id: string;
  branch: string;
  /** The branch's tip it was built with: the train is out of date once it moves. */
  tip: string;
  commit?: string;
  conflicts?: string[];
  /** Its commits are in the train already (a ticket ahead of it has them): its commit is that of the one before. */
  contained?: boolean;
  /** Its conflicts were resolved by a resolution git recorded before (rerere). */
  reused?: boolean;
}

/** The train as last built: on which base tip, and each queued ticket's place in it. Saved in backlog.json. */
export interface MergeTrain {
  base: string;
  baseTip: string;
  /** The train's tip: baseTip when nothing merged. */
  tip: string;
  /** ISO 8601. */
  built: string;
  entries: TrainEntry[];
}

/** The queue as it stands: the saved order, without tickets that aren't ready to merge any more. */
export function queuedItems(data: Pick<BacklogData, 'items' | 'mergeQueue'>): BacklogItem[] {
  const byId = new Map(data.items.map((i) => [i.id, i]));
  return (data.mergeQueue ?? []).map((id) => byId.get(id)).filter((i): i is BacklogItem => !!i && readyToMerge(i));
}

/** The queue with id at its end (or kept where it is, if it's in it already). */
export function enqueue(queue: readonly string[] | undefined, ids: readonly string[]): string[] {
  const out = [...(queue ?? [])];
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out;
}

/** The queue without ids. */
export function dequeue(queue: readonly string[] | undefined, ids: readonly string[]): string[] {
  return (queue ?? []).filter((q) => !ids.includes(q));
}

/** Whether the train was built on these tips: the base's, and each queued branch's, in this order. */
export function trainIsCurrent(train: MergeTrain | undefined, baseTip: string, entries: ReadonlyArray<{ id: string; branch: string; tip: string }>): boolean {
  if (!train || train.baseTip !== baseTip || train.entries.length !== entries.length) return false;
  return entries.every((e, i) => train.entries[i].id === e.id && train.entries[i].branch === e.branch && train.entries[i].tip === e.tip);
}

/**
 * What landing id moves the base to: its merge commit in the train, and the tickets that land with it (those ahead of
 * it in the train, and itself). Undefined when it isn't in the train (not queued, or it conflicts).
 */
export function landing(train: MergeTrain, id: string): { commit: string; lands: TrainEntry[] } | undefined {
  const at = train.entries.findIndex((e) => e.id === id);
  const entry = train.entries[at];
  if (!entry?.commit) return undefined;
  return { commit: entry.commit, lands: train.entries.slice(0, at + 1).filter((e) => e.commit) };
}

/** The last ticket of the train that's in it: landing it lands the whole train (Land All). */
export function lastInTrain(train: MergeTrain): TrainEntry | undefined {
  return train.entries.filter((e) => e.commit).at(-1);
}

/** "2nd" for 2. */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/** What a ticket's place in the train says ("Merges cleanly onto main + BL-122"). */
export function trainState(train: MergeTrain, id: string): string | undefined {
  const at = train.entries.findIndex((e) => e.id === id);
  const entry = train.entries[at];
  if (!entry) return undefined;
  const ahead = train.entries.slice(0, at).filter((e) => e.commit).map((e) => e.id);
  const onto = [train.base, ...ahead].join(' + ');
  if (entry.contained) return `Its commits come in with ${ahead.at(-1) ?? train.base} ahead of it: nothing of its own to merge.`;
  if (entry.conflicts) return `Conflicts with ${onto} in ${entry.conflicts.map((f) => `\`${f}\``).join(', ')}.`;
  return `Merges cleanly onto ${onto}${entry.reused ? ' (with a resolution recorded before)' : ''}.`;
}

/** The train's commit a ticket merges onto: that of the last one ahead of it in the train, else the base's tip. */
export function trainOnto(train: MergeTrain, id: string): { commit: string; ahead: string[] } | undefined {
  const at = train.entries.findIndex((e) => e.id === id);
  if (at < 0) return undefined;
  const ahead = train.entries.slice(0, at).filter((e) => e.commit);
  return { commit: ahead.at(-1)?.commit ?? train.baseTip, ahead: ahead.map((e) => e.id) };
}

/** git's options that record and reuse resolutions (rerere), for the train's merges only. */
const RERERE = ['-c', 'rerere.enabled=true', '-c', 'rerere.autoUpdate=true'];
const MERGE_ENV = { GIT_MERGE_AUTOEDIT: 'no', GIT_EDITOR: ':' };

/**
 * Starts merging a train entry in a new temporary worktree at dir, detached at onto (the train's commit before it),
 * with rerere on: the conflicted files, left there to resolve (BL-146). Any other outcome removes the worktree.
 */
export async function startTrainMerge(cwd: string, o: { dir: string; onto: string; branch: string; message: string }): Promise<string[]> {
  await runGit(['worktree', 'add', '--detach', o.dir, o.onto], { cwd, timeoutMs: 120_000 });
  const merged = await runGit([...RERERE, 'merge', '--no-ff', '--no-edit', '-m', o.message, `refs/heads/${o.branch}`], { cwd: o.dir, timeoutMs: 120_000, env: MERGE_ENV }).then(
    () => true,
    () => false,
  );
  const files = merged ? [] : await conflictedFiles(o.dir).catch(() => []);
  if (!files.length) await removeMergeWorktree(cwd, o.dir).catch(() => undefined);
  return files;
}

/**
 * Records a resolved train merge for rerere (BL-146): in dir, the merge of tip onto onto is made again, each file it
 * conflicts on is taken as it is in resolved (the approved merge commit), and rerere records that. A rebuild of the
 * train then merges the entry with it. The files recorded; dir is left at resolved.
 */
export async function recordResolution(dir: string, o: { onto: string; tip: string; resolved: string; message: string }): Promise<string[]> {
  await runGit(['checkout', '-q', '--detach', '--force', o.onto], { cwd: dir });
  // Without autoUpdate, a file an older resolution resolves stays unmerged, so it's recorded again.
  await runGit(['-c', 'rerere.enabled=true', 'merge', '--no-ff', '--no-edit', '-m', o.message, o.tip], { cwd: dir, timeoutMs: 120_000, env: MERGE_ENV }).catch(() => undefined);
  const files = await conflictedFiles(dir).catch(() => []);
  try {
    if (files.length) {
      // An older resolution of the same conflicts is forgotten: the approved one replaces it.
      await runGit(['-c', 'rerere.enabled=true', 'rerere', 'forget', '--', ...files], { cwd: dir }).catch(() => undefined);
      for (const f of files) {
        const kept = await runGit(['cat-file', '-e', `${o.resolved}:${f}`], { cwd: dir }).then(() => true, () => false);
        await runGit(kept ? ['checkout', o.resolved, '--', f] : ['rm', '-q', '--force', '--', f], { cwd: dir });
      }
      await runGit(['-c', 'rerere.enabled=true', 'rerere'], { cwd: dir });
    }
  } finally {
    await runGit(['merge', '--abort'], { cwd: dir }).catch(() => undefined);
    await runGit(['checkout', '-q', '--detach', '--force', o.resolved], { cwd: dir }).catch(() => undefined);
  }
  return files;
}

/**
 * Builds the train in a new temporary worktree at dir, detached at baseTip: each entry's branch merged on in order
 * (`git merge --no-ff`, rerere on for these merges only, so a resolution recorded once is reused). An entry that
 * conflicts is aborted and left out. The train branch is moved to the result, and the worktree removed.
 */
export async function buildTrain(
  cwd: string,
  o: { dir: string; base: string; baseTip: string; entries: ReadonlyArray<{ id: string; branch: string; message: string }>; now?: Date },
): Promise<MergeTrain> {
  const entries: TrainEntry[] = [];
  const env = MERGE_ENV;
  const rerere = RERERE;
  await runGit(['worktree', 'add', '--detach', o.dir, o.baseTip], { cwd, timeoutMs: 120_000 }).catch(async (e: unknown) => {
    await removeMergeWorktree(cwd, o.dir).catch(() => undefined);
    throw e;
  });
  try {
    for (const e of o.entries) {
      const tip = (await runGit(['rev-parse', `refs/heads/${e.branch}^{commit}`], { cwd })).trim();
      if (await runGit(['merge-base', '--is-ancestor', tip, 'HEAD'], { cwd: o.dir }).then(() => true, () => false)) {
        entries.push({ id: e.id, branch: e.branch, tip, commit: await head(o.dir), contained: true });
        continue;
      }
      const merged = await runGit([...rerere, 'merge', '--no-ff', '--no-edit', '-m', e.message, tip], { cwd: o.dir, timeoutMs: 120_000, env }).then(
        () => true,
        () => false,
      );
      if (merged) {
        entries.push({ id: e.id, branch: e.branch, tip, commit: await head(o.dir) });
        continue;
      }
      const files = await conflictedFiles(o.dir).catch(() => []);
      const inMerge = await runGit(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd: o.dir }).then(() => true, () => false);
      if (!files.length && inMerge) {
        // rerere resolved every conflict (and staged it): the merge is committed with it.
        await runGit([...rerere, 'commit', '--no-edit'], { cwd: o.dir, env });
        entries.push({ id: e.id, branch: e.branch, tip, commit: await head(o.dir), reused: true });
        continue;
      }
      await runGit(['merge', '--abort'], { cwd: o.dir }).catch(() => undefined);
      await runGit(['reset', '--hard', '-q'], { cwd: o.dir }).catch(() => undefined);
      entries.push({ id: e.id, branch: e.branch, tip, conflicts: files.length ? files : ['(the merge failed)'] });
    }
    const tip = await head(o.dir);
    await runGit(['update-ref', '-m', 'flotilla: merge train', `refs/heads/${TRAIN_BRANCH}`, tip], { cwd });
    return { base: o.base, baseTip: o.baseTip, tip, built: (o.now ?? new Date()).toISOString(), entries };
  } finally {
    await removeMergeWorktree(cwd, o.dir).catch(() => undefined);
  }
}

const head = async (dir: string) => (await runGit(['rev-parse', 'HEAD'], { cwd: dir })).trim();

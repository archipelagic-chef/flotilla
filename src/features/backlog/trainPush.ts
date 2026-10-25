import { GitError, runGit } from '../../core/git/gitCli';
import { PUSH_REMOTE } from './branchPush';
import type { MergeTrain } from './mergeTrain';

/**
 * The merge train on origin (BL-145): when CI decides, each ticket's merge commit in the train is pushed to a branch
 * of its own (GitHub runs CI on a push's tip only), so each ticket lands on CI's result for its own commit. They're
 * forced onto whatever was there, and the ones of tickets no longer in the train are deleted: they never pile up.
 */

/** Where the train's branches go on origin. */
export const TRAIN_REMOTE_PREFIX = 'flotilla/merge-queue/';

/** The branch on origin a ticket's train commit is pushed to. */
export const trainRef = (id: string): string => `${TRAIN_REMOTE_PREFIX}${id}`;

/** The train's commits to push, by branch: each ticket's that merges something of its own. */
export function trainPushes(train: MergeTrain | undefined): Map<string, string> {
  return new Map((train?.entries ?? []).filter((e) => e.commit && !e.contained).map((e) => [trainRef(e.id), e.commit!]));
}

export type TrainPushResult = { pushed: string[]; deleted: string[] } | { error: string };

const message = (e: unknown) => (e instanceof GitError ? e.stderr || e.message : e instanceof Error ? e.message : String(e)).trim();

/** Makes origin's train branches the train's: changed ones forced, new ones made, stale ones deleted. */
export async function pushTrain(cwd: string, train: MergeTrain | undefined): Promise<TrainPushResult> {
  let listed: string;
  try {
    listed = await runGit(['ls-remote', PUSH_REMOTE, `refs/heads/${TRAIN_REMOTE_PREFIX}*`], { cwd, timeoutMs: 60_000 });
  } catch (e) {
    return { error: `Reading origin's train branches failed: ${message(e)}` };
  }
  const remote = new Map(
    listed
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t'))
      .map(([sha, ref]) => [ref.replace(/^refs\/heads\//, ''), sha] as const),
  );
  const wanted = trainPushes(train);
  const pushed = [...wanted].filter(([ref, sha]) => remote.get(ref) !== sha).map(([ref]) => ref);
  const deleted = [...remote.keys()].filter((ref) => !wanted.has(ref));
  if (!pushed.length && !deleted.length) return { pushed, deleted };
  const specs = [...pushed.map((ref) => `+${wanted.get(ref)}:refs/heads/${ref}`), ...deleted.map((ref) => `:refs/heads/${ref}`)];
  try {
    await runGit(['push', '--quiet', PUSH_REMOTE, ...specs], { cwd, timeoutMs: 120_000 });
  } catch (e) {
    return { error: `Pushing the merge train failed: ${message(e)}` };
  }
  // Origin's remote-tracking refs, as a fetch would leave them (CI's decision reads them, and when they moved).
  for (const ref of pushed) await runGit(['update-ref', '-m', 'flotilla: merge train pushed', `refs/remotes/${PUSH_REMOTE}/${ref}`, wanted.get(ref)!], { cwd });
  for (const ref of deleted) await runGit(['update-ref', '-d', `refs/remotes/${PUSH_REMOTE}/${ref}`], { cwd }).catch(() => undefined);
  return { pushed, deleted };
}

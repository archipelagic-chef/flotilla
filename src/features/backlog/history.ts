import { runGit } from '../../core/git/gitCli';

/**
 * Clean-ups of a ticket's commit history. The work's branch keeps its name; its history is rewritten on a branch of
 * its own (in a worktree of its own), from where the branch started, until it ends at exactly the same files. Then the
 * old history is kept under a hidden ref (refs/flotilla/history/<id>/v<n>: not a branch, not pushed, never collected),
 * and the branch moves to the clean commits.
 */
export const HISTORY_REFS = 'refs/flotilla/history';

/** A history clean-up in progress for an item. */
export interface HistoryRewrite {
  /** The work's branch, whose history is rewritten. */
  branch: string;
  /** The branch the clean history is written on (in a worktree of its own). */
  clean: string;
  /** Where the branch started (its merge base with the base branch): the clean history starts there too. */
  base: string;
  /** Who writes it: an agent (in a chat the user can talk to), or the user. */
  by: 'agent' | 'you';
  agent?: string;
  /** ISO 8601. */
  started: string;
}

/** An earlier history of an item's branch, kept when it was cleaned up. */
export interface HistoryVersion {
  /** 1 for the first history kept. */
  version: number;
  branch: string;
  /** The hidden ref that keeps it. */
  ref: string;
  /** Its last commit, and where it started. */
  tip: string;
  base: string;
  /** How many commits it had, and how many the clean history has. */
  commits: number;
  cleanCommits: number;
  /** ISO 8601. */
  archived: string;
}

export function historyRef(id: string, version: number): string {
  return `${HISTORY_REFS}/${id}/v${version}`;
}

const rev = async (cwd: string, ref: string) => (await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd })).trim();

/** A free name for the clean branch: "<branch>-clean", numbered if it's taken. */
export function cleanBranchName(branch: string, taken: readonly string[]): string {
  let name = `${branch}-clean`;
  for (let n = 2; taken.includes(name); n++) name = `${branch}-clean-${n}`;
  return name;
}

/** Where a branch started: its merge base with the base branch (the clean history starts there). */
export async function branchStart(cwd: string, branch: string, base: string): Promise<string> {
  return (await runGit(['merge-base', base, `refs/heads/${branch}`], { cwd })).trim();
}

export async function countCommits(cwd: string, from: string, to: string): Promise<number> {
  return Number((await runGit(['rev-list', '--count', `${from}..${to}`], { cwd })).trim()) || 0;
}

/** How the clean history compares to the branch: the files that differ at their ends (none: it can be finished). */
export async function compareRewrite(
  cwd: string,
  rewrite: Pick<HistoryRewrite, 'branch' | 'clean' | 'base'>,
): Promise<{ differs: string[]; commits: number; cleanCommits: number }> {
  const [differs, commits, cleanCommits] = await Promise.all([
    runGit(['diff', '--name-only', '--no-renames', `refs/heads/${rewrite.branch}`, `refs/heads/${rewrite.clean}`, '--'], { cwd }).then((o) =>
      o.split('\n').filter(Boolean),
    ),
    countCommits(cwd, rewrite.base, `refs/heads/${rewrite.branch}`),
    countCommits(cwd, rewrite.base, `refs/heads/${rewrite.clean}`),
  ]);
  return { differs, commits, cleanCommits };
}

/**
 * Finishes a clean-up: keeps the branch's history under the version's hidden ref, and moves the branch to the clean
 * commits. In its worktree (worktree: its path), with `reset --keep`: the files are the same, so nothing there changes
 * (uncommitted changes stay). Refuses when the files differ. The clean branch and its worktree are the caller's to
 * remove.
 */
export async function finishRewrite(
  cwd: string,
  o: { id: string; version: number; rewrite: Pick<HistoryRewrite, 'branch' | 'clean' | 'base'>; worktree?: string; now: Date },
): Promise<HistoryVersion> {
  const { branch, clean, base } = o.rewrite;
  const compared = await compareRewrite(cwd, o.rewrite);
  if (compared.differs.length) {
    throw new Error(
      `The clean history doesn't end at the same files as ${branch}: ${compared.differs.length} differ (${compared.differs.slice(0, 5).join(', ')}).`,
    );
  }
  const tip = await rev(cwd, `refs/heads/${branch}`);
  const cleanTip = await rev(cwd, `refs/heads/${clean}`);
  const ref = historyRef(o.id, o.version);
  // Created only if it doesn't exist (the empty old value): a kept history is never overwritten.
  await runGit(['update-ref', '-m', `flotilla: ${o.id} history v${o.version} (${branch})`, ref, tip, ''], { cwd });
  try {
    if (o.worktree) await runGit(['reset', '--keep', cleanTip], { cwd: o.worktree });
    // Only if the branch is still where it was checked.
    else await runGit(['update-ref', '-m', `flotilla: ${o.id} clean history`, `refs/heads/${branch}`, cleanTip, tip], { cwd });
  } catch (error) {
    await runGit(['update-ref', '-d', ref, tip], { cwd }).catch(() => undefined);
    throw error;
  }
  return { version: o.version, branch, ref, tip, base, commits: compared.commits, cleanCommits: compared.cleanCommits, archived: o.now.toISOString() };
}

/** What the agent cleaning up a history is told (after its lead line, which names it and the item). */
export function cleanUpPrompt(o: { id: string; ticket: string; branch: string; clean: string; base: string; commits: number; agent: string }): string {
  const short = o.base.slice(0, 12);
  return [
    `Your task: with the user, rewrite the commit history of ${o.id}'s work into a clean one. The work is on branch ${o.branch}: ${o.commits} commit${o.commits === 1 ? '' : 's'} since it started at ${short} (see them with \`git log --reverse --stat ${short}..${o.branch}\`). Many may be back-and-forth (fixes of fixes, review rounds) that the end result doesn't need. Read the ticket ${o.ticket} for what the work is.`,
    `This git worktree is on branch ${o.clean}, at ${short}, where ${o.branch} started. Write the clean history here: a few commits, each one logical step a reviewer can follow (building and passing its tests where practical), with messages starting with "${o.id}: ". It must end at exactly the same files as ${o.branch}: check that \`git diff ${o.branch}\` prints nothing before you finish.`,
    `Work it out with the user, in this chat: first propose the commits you'd make (their messages, and what goes in each), and wait for their OK or their changes before you commit anything. Ask them whenever a choice is theirs.`,
    `To build the commits, take the files from ${o.branch} (e.g. \`git restore --source ${o.branch} --staged --worktree -- <paths>\`, or \`git diff ${short} ${o.branch} -- <paths> | git apply --index\`, then edit as needed), and commit. Don't change ${o.branch}, don't reset or delete branches, and don't push.`,
    `When the files are the same, report in the ticket: append an entry at the end of its "## Activity" section, a heading "### YYYY-MM-DD HH:MM · Agent ${o.agent}" (local time) followed by the new commits and how they map to the old ones. Then tell the user to finish it from the ticket (Finish Clean-Up): Flotilla keeps ${o.branch}'s old history (as a hidden ref), moves ${o.branch} to these commits, and removes this worktree.`,
  ].join('\n\n');
}

/** What Discard says about a ticket's started work (BL-210): its confirmation, and the entry once it's done. */

import type {
  BacklogData,
  BacklogItem,
} from './backlog';
import type { TicketEntry } from './ticket';
import {
  dependencyDiscardedEntry,
  dependsOn,
} from './mainDrift';

const code = (names: readonly string[]) => names.map((n) => `\`${n}\``).join(', ');

/** A worktree of the ticket to remove: its label, and how many uncommitted or untracked files it has. */
export interface DiscardWorktree {
  label: string;
  changedFiles: number;
}

/** The confirmation's detail: the plain one (BL-209) with nothing started, else the agents that stop and worktrees that go. */
export function discardDetail(o: { agents: readonly string[]; worktrees: readonly DiscardWorktree[] }): string {
  const lines = ['It leaves the lanes; its ticket and activity are kept, and you can reopen it from the Discarded section.'];
  if (!o.agents.length && !o.worktrees.length) return lines[0];
  if (o.agents.length) lines.push(`${o.agents.length === 1 ? 'Its agent stops' : 'Its agents stop'}: ${o.agents.join(', ')}.`);
  if (o.worktrees.length) {
    lines.push(
      `${o.worktrees.length === 1 ? 'Its worktree is removed' : 'Its worktrees are removed'}, keeping the branch: ${o.worktrees.map((w) => w.label).join(', ')}.`,
    );
    for (const w of o.worktrees.filter((w) => w.changedFiles > 0))
      lines.push(`${w.label}: ${w.changedFiles} uncommitted or untracked file(s) will be deleted.`);
    lines.push('If a worktree is open in another window (including another environment), that window will lose its folder.');
  }
  return lines.join('\n');
}

/**
 * The entry after a discard: what stopped, which worktrees went (`removing`: the current window's, removed once main
 * opens), the branches kept, and what was left as it was.
 */
export function discardEntry(o: {
  stopped: readonly string[];
  removed: readonly string[];
  removing?: string;
  branches: readonly string[];
  left: readonly string[];
}): string | undefined {
  const lines: string[] = [];
  if (o.stopped.length) lines.push(`Discarding it stopped ${o.stopped.join(', ')}.`);
  if (o.removed.length) lines.push(`It removed ${o.removed.length === 1 ? 'the worktree' : 'the worktrees'} of ${code(o.removed)}.`);
  if (o.removing) lines.push(`The worktree of \`${o.removing}\` is removed as this window opens the main worktree.`);
  if (o.branches.length)
    lines.push(
      `${o.branches.length === 1 ? 'Its branch stays' : 'Its branches stay'}: ${code(o.branches)}. Reopen it, and Start picks the work up there again.`,
    );
  if (o.left.length) lines.push(`Left as it was:\n${o.left.map((l) => `- ${l}`).join('\n')}`);
  return lines.length ? lines.join('\n\n') : undefined;
}

/** The entry after a reopen, when branches of its earlier work are still there. */
export function reopenEntry(branches: readonly string[]): string | undefined {
  if (!branches.length) return undefined;
  return `${branches.length === 1 ? 'Its branch from before is still there' : 'Its branches from before are still there'}: ${code(branches)}. Start picks the work up there again.`;
}

/**
 * The open tickets that depend on one just discarded stop waiting for it (BL-235): each gets an entry saying so, to
 * check that it still makes sense without that work.
 */
export async function noteDependents(
  backlog: {
    read(): Promise<BacklogData>;
    readTicketCached(item: BacklogItem): Promise<{ description: string }>;
    appendActivity(item: BacklogItem, entry: TicketEntry): Promise<void>;
  },
  id: string,
  date: string,
): Promise<void> {
  const open = (await backlog.read()).items.filter((i) => i.id !== id && i.status !== 'done' && !i.discarded);
  for (const item of open) {
    const { description } = await backlog.readTicketCached(item);
    if (dependsOn(description, item.id).includes(id.toUpperCase())) {
      await backlog.appendActivity(item, { date, author: 'Flotilla', body: dependencyDiscardedEntry(id) });
    }
  }
}

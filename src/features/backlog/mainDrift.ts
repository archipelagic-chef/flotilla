import {
  type BacklogData,
  type BacklogItem,
  ID_PATTERN,
  itemBranches,
} from './backlog';

/**
 * Open tickets' branches against main (BL-55): when main or a branch moves, the branch is merged with main in memory,
 * and a ticket whose branch would conflict says so (on its card, and in its ticket), while its agent is still around.
 * A ticket that needs another's work says "Depends on: BL-12" in its description, and waits for that one.
 */

/** A branch of the item as last checked against the base (heads: the commits checked). */
export interface BranchCheck {
  branch: string;
  head: string;
  /** The files a merge of the base into it conflicts in (none: it merges cleanly). */
  conflicts: string[];
}

/** The last check of an item's branches against the base (`main`, `origin/main`), at the base's commit baseHead. */
export interface MainCheck {
  base: string;
  baseHead: string;
  branches: BranchCheck[];
}

/** Tickets whose branches are checked: worked on or in review, and accepted. */
export function isOpen(item: Pick<BacklogItem, 'status' | 'proposed'>): boolean {
  return (item.status === 'doing' || item.status === 'review') && !item.proposed;
}

/** What a check of the item's branches needs: the branches of it that exist, at their heads (now). */
export function branchesToCheck(item: BacklogItem, heads: ReadonlyMap<string, string>): Array<{ branch: string; head: string }> {
  return itemBranches(item).flatMap((branch) => {
    const head = heads.get(branch);
    return head ? [{ branch, head }] : [];
  });
}

/** A branch's earlier check, if it checked the same commits (nothing to do again). */
export function reusable(prev: MainCheck | undefined, baseHead: string, branch: string, head: string): BranchCheck | undefined {
  if (prev?.baseHead !== baseHead) return undefined;
  return prev.branches.find((b) => b.branch === branch && b.head === head);
}

/** The branches that conflict with the base, with their files: none once the ticket isn't open (its check is stale). */
export function conflictsOf(item: Pick<BacklogItem, 'mainCheck' | 'status' | 'proposed'>): BranchCheck[] {
  if (!isOpen(item)) return [];
  return (item.mainCheck?.branches ?? []).filter((b) => b.conflicts.length > 0);
}

/** "a.ts, b.ts and 3 more". */
export function fileList(files: readonly string[], max = 3): string {
  const shown = files.slice(0, max).map((f) => `\`${f}\``);
  return files.length > max ? `${shown.join(', ')} and ${files.length - max} more` : shown.join(', ');
}

/** A short name for the base, as people say it: "origin/main" is main. */
export function baseLabel(base: string): string {
  return base.replace(/^(refs\/(heads|remotes)\/)?(origin\/)?/, '');
}

/**
 * What the ticket notes when a check changes how its branches merge with the base: a branch that now conflicts, or
 * one that merges cleanly again. Nothing for the first check that finds no conflicts, or a list of files that changes.
 */
export function driftNotes(prev: MainCheck | undefined, next: MainCheck): string[] {
  const label = baseLabel(next.base);
  return next.branches.flatMap((b) => {
    const was = prev?.branches.find((p) => p.branch === b.branch);
    const before = (was?.conflicts.length ?? 0) > 0;
    const now = b.conflicts.length > 0;
    if (now && !before) {
      return [
        `Branch \`${b.branch}\` now conflicts with ${label} (${fileList(b.conflicts, 10)}): ${label} moved on since it branched. **Update from ${capitalize(label)}** merges ${label} into it, handing the conflicts to its agent.`,
      ];
    }
    if (!now && before) return [`Branch \`${b.branch}\` merges cleanly with ${label} again.`];
    return [];
  });
}

/** What the ticket's agent is told when merging the base into its branch conflicts (Update from Main). */
export function mergeBasePrompt(o: { id: string; base: string; branch: string; files: readonly string[]; ticket: string }): string {
  const label = baseLabel(o.base);
  return [
    `${label} moved on, and rebasing your branch ${o.branch} onto it conflicts${o.files.length ? ` in ${o.files.join(', ')}` : ''}. The user asked to bring the branch up to date with ${label}.`,
    `Rebase your branch onto ${o.base} (\`git rebase ${o.base}\`; don't merge ${o.base} into it), resolve the conflicts commit by commit so both sides' changes keep working (\`git add\` the files, then \`GIT_EDITOR=true git rebase --continue\`), and run the project's checks (build, tests) on the result. Your commits keep their messages (starting with "${o.id}: "). The branch is rewritten: if you push it, push with \`git push --force-with-lease\`.`,
    `Then report in the ticket (${o.ticket}) which conflicts you resolved and how. If your work on the ticket was done, end the report with a line "Ready for review."; if not, go on with it first.`,
  ].join('\n\n');
}

/** The tickets a description says it depends on: lines like "Depends on: BL-12, BL-13" (not itself). */
export function dependsOn(description: string, self?: string): string[] {
  const ids = new Set<string>();
  for (const m of description.matchAll(/^[\s>*_-]*depends on[*_]*\s*:?[*_]*\s*(.+)$/gim)) {
    for (const [id] of m[1].matchAll(/\b[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7}\b/g)) {
      if (ID_PATTERN.test(id) && id.toUpperCase() !== self?.toUpperCase()) ids.add(id.toUpperCase());
    }
  }
  return [...ids];
}

const TICKET = String.raw`[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7}`;
const TICKETS = String.raw`${TICKET}(?:\s*(?:,|&|and|or)\s*${TICKET})*`;
/** "BL-182 is merged", "BL-182 and BL-183 are merged", "BL-135 merges", "BL-1 has landed"; "waiting for BL-182". */
const WAIT_PHRASES = [
  new RegExp(String.raw`\b(${TICKETS})\s+(?:(?:is|are|has|have|gets|get)\s+)?(?:been\s+)?(?:merged|merges|merge|landed|lands|land)\b`, 'gi'),
  new RegExp(String.raw`\bwait(?:s|ing)?\s+(?:on|for)\s+(${TICKETS})\b`, 'gi'),
];

/**
 * The tickets a report says its agent waits for to be merged (BL-198): "Resume me once BL-182 is merged", "after
 * BL-135 merges", "Waiting for BL-182". Not itself.
 */
export function resumeWaits(text: string, self?: string): string[] {
  const ids = new Set<string>();
  for (const phrase of WAIT_PHRASES) {
    for (const m of text.matchAll(phrase)) {
      for (const [id] of m[1].matchAll(new RegExp(String.raw`\b${TICKET}\b`, 'g'))) {
        if (ID_PATTERN.test(id) && id.toUpperCase() !== self?.toUpperCase()) ids.add(id.toUpperCase());
      }
    }
  }
  return [...ids];
}

/** The tickets of those it depends on that aren't done yet (merged): what it waits for. Unknown ids are ignored. */
export function waitingFor(data: BacklogData, deps: readonly string[]): Array<Pick<BacklogItem, 'id' | 'title' | 'status'>> {
  return deps.flatMap((id) => {
    const dep = data.items.find((i) => i.id.toUpperCase() === id);
    return dep && dep.status !== 'done' ? [{ id: dep.id, title: dep.title, status: dep.status }] : [];
  });
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

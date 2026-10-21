import * as vscode from 'vscode';
import { GitError, runGit } from '../../core/git/gitCli';
import { mergeConflicts } from '../../core/git/mergeCheck';
import type { Repository } from '../../core/repository';
import { branchMatches, type BacklogItem } from '../../features/backlog/backlog';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import { baseLabel, branchesToCheck, capitalize, conflictsOf, driftNotes, isOpen, mergeBasePrompt, reusable, type BranchCheck, type MainCheck } from '../../features/backlog/mainDrift';
import { entryDate } from '../../features/backlog/ticket';
import { resolveBase, resolveCommit } from '../../features/workstreams/progress';
import type { Workstream } from '../../features/workstreams/workstream';
import { readSettings } from '../settings';
import type { ReviewLoop } from './reviewLoop';

export interface MainSyncDeps {
  backlog: LocalBacklog;
  repository: Repository<Workstream>;
  reviews: ReviewLoop;
  mainRoot: string;
  /** Only the leading window checks (and notes what it finds in the tickets). */
  isLeader: () => boolean;
  output: vscode.OutputChannel;
}

/**
 * Keeps open tickets' branches current with main (BL-55). When main or a branch moves, each open ticket's branch is
 * merged with main in memory; what it finds is kept on the item (its card and ticket show it) and a branch that comes
 * to conflict, or stops conflicting, is noted in its ticket. Update from Main merges main into a ticket's branch, or
 * has its agent do it when that conflicts.
 */
export class MainSync implements vscode.Disposable {
  private readonly subscriptions: Array<{ dispose(): void }> = [];
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private again = false;

  constructor(private readonly deps: MainSyncDeps) {
    // The repository's refresh sees commits on main and on the branches (it runs on file and ref changes).
    this.subscriptions.push(deps.repository.onDidChange(() => this.schedule()));
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.subscriptions.forEach((s) => s.dispose());
  }

  /** A check soon: a burst of changes (a rebase, a pull) checks once. */
  schedule(delayMs = 3000): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.check(), delayMs);
  }

  /** Main's name (the base work merges into): `main`, `origin/main`. */
  base(): Promise<string | undefined> {
    return resolveBase(this.deps.mainRoot, readSettings().defaultBase);
  }

  /** Checks the open tickets' branches whose commits (or main's) changed since their last check. */
  async check(): Promise<void> {
    if (!this.deps.isLeader()) return;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.checkNow()
      .catch((e: unknown) => this.deps.output.appendLine(`Checking branches against main: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        this.running = undefined;
        if (this.again) {
          this.again = false;
          this.schedule(0);
        }
      });
    return this.running;
  }

  private async checkNow(): Promise<void> {
    const cwd = this.deps.mainRoot;
    const base = await this.base();
    const baseHead = base && (await resolveCommit(cwd, base));
    if (!base || !baseHead) return;
    const data = await this.deps.backlog.read();
    // A ticket that's no longer open (done, back in To Do) drops its last check: it isn't checked any more.
    if (data.items.some((i) => i.mainCheck && !isOpen(i))) {
      await this.deps.backlog.change((d) => ({ ...d, items: d.items.map((i) => (i.mainCheck && !isOpen(i) ? withoutCheck(i) : i)) }));
    }
    const open = data.items.filter(isOpen);
    if (!open.length) return;
    const heads = await branchHeads(cwd);
    const checks = new Map<string, MainCheck>();
    for (const item of open) {
      const branches: BranchCheck[] = [];
      for (const { branch, head } of branchesToCheck(item, heads)) {
        const known = reusable(item.mainCheck, baseHead, branch, head);
        if (known) branches.push(known);
        else if (head === baseHead) branches.push({ branch, head, conflicts: [] });
        else {
          try {
            branches.push({ branch, head, conflicts: await mergeConflicts(cwd, head, baseHead) });
          } catch (e) {
            // One branch that can't be checked (a timeout, a corrupt object) keeps what was known of it.
            this.deps.output.appendLine(`Checking ${branch} against ${base}: ${e instanceof Error ? e.message : String(e)}`);
            const was = item.mainCheck?.branches.find((b) => b.branch === branch);
            if (was) branches.push(was);
          }
        }
      }
      const next: MainCheck = { base, baseHead, branches };
      if (JSON.stringify(next) !== JSON.stringify(item.mainCheck)) checks.set(item.id, next);
    }
    if (!checks.size) return;
    const before = new Map(open.map((i) => [i.id, i.mainCheck]));
    await this.deps.backlog.change((d) => ({ ...d, items: d.items.map((i) => (checks.has(i.id) ? { ...i, mainCheck: checks.get(i.id) } : i)) }));
    for (const [id, next] of checks) {
      const item = open.find((i) => i.id === id)!;
      const notes = driftNotes(before.get(id), next);
      if (notes.length) await this.deps.backlog.appendActivity(item, { date: entryDate(new Date()), author: 'Flotilla', body: notes.join('\n\n') });
    }
  }

  /**
   * Update from Main: merges main into the item's branch in its worktree. When that conflicts (known from the last
   * check, or found by the merge), the merge is left to the ticket's agent: its chat resumed with the task.
   */
  async update(id: string): Promise<void> {
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    if (!item) return;
    const ws = this.worktreeOf(item);
    if (!ws?.worktree.path || !ws.worktree.branch) {
      void vscode.window.showWarningMessage(`${id} has no worktree to merge main into: check out its branch first.`);
      return;
    }
    const cwd = ws.worktree.path;
    const branch = ws.worktree.branch;
    const base = await this.base();
    if (!base) {
      void vscode.window.showWarningMessage(`No main branch found to merge (set flotilla.defaultBase).`);
      return;
    }
    const label = baseLabel(base);
    const busy = ws.chats.find((c) => c.open && (c.state === 'working' || c.state === 'waiting-for-input'));
    if (busy || this.deps.reviews.isRunning(id)) {
      void vscode.window.showWarningMessage(`An agent is working in ${branch}: update it from ${label} when it's done.`);
      return;
    }
    // With uncommitted changes, a merge is the agent's to do (it knows what they are), if it's known to conflict anyway.
    if (ws.changes.length) {
      const expected = conflictsOf(item).find((b) => b.branch === branch);
      if (expected) return this.handToAgent(item, base, branch, expected.conflicts);
      void vscode.window.showWarningMessage(`${branch} has uncommitted changes: commit them (or set them aside) before updating it from ${label}.`);
      return;
    }
    try {
      const out = await runGit(['merge', '--no-edit', '-m', `${id}: Merge ${label} into ${branch}`, base], { cwd, timeoutMs: 300_000 });
      const upToDate = /Already up to date/i.test(out);
      const note = upToDate ? `\`${branch}\` is already up to date with ${label}.` : `Merged ${label} into \`${branch}\` (Update from ${capitalize(label)}).`;
      await this.deps.backlog.appendActivity(item, { date: entryDate(new Date()), author: 'Flotilla', body: note });
      void vscode.window.showInformationMessage(`${id}: ${upToDate ? `${branch} is already up to date with ${label}.` : `Merged ${label} into ${branch}.`}`);
      this.schedule(0);
    } catch (e) {
      // Conflicts: back to where it was, and the agent takes it. Anything else (a hook refusing it): the user sees why.
      const conflicted = await conflictedFiles(cwd);
      await runGit(['merge', '--abort'], { cwd }).catch(() => undefined);
      if (!conflicted.length) throw e instanceof GitError ? new Error(`Merging ${label} into ${branch} failed: ${e.stderr.trim() || e.message}`) : e;
      await this.handToAgent(item, base, branch, conflicted);
    }
  }

  private async handToAgent(item: BacklogItem, base: string, branch: string, files: string[]): Promise<void> {
    const label = baseLabel(base);
    const handed = await this.deps.reviews.handToImplementer(item.id, {
      prompt: mergeBasePrompt({ id: item.id, base, branch, files, ticket: this.deps.backlog.docPath(item.id) }),
      why: `merging ${label} into \`${branch}\` conflicts`,
      aside: true,
    });
    const conflicts = `${item.id}: merging ${label} into ${branch} conflicts (${files.join(', ')})`;
    if (handed) void vscode.window.showInformationMessage(`${conflicts}, so its agent is merging it and resolving the conflicts.`);
    else void vscode.window.showWarningMessage(`${conflicts}, and an agent is already working on it: update it from ${label} when it's done.`);
  }

  /** The item's worktree: the review's, else its first. */
  private worktreeOf(item: BacklogItem): Workstream | undefined {
    const all = this.deps.repository.current.filter((w) => !w.worktree.isMain && w.worktree.path && w.worktree.branch && branchMatches(item, w.worktree.branch));
    return all.find((w) => w.key === item.review?.worktree) ?? all[0];
  }
}

/** The local branches' commits, by branch name. */
async function branchHeads(cwd: string): Promise<Map<string, string>> {
  const out = await runGit(['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads'], { cwd });
  return new Map(
    out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const at = l.indexOf(' ');
        return [l.slice(at + 1), l.slice(0, at)] as const;
      }),
  );
}

/** The files a merge in progress left conflicted. */
async function conflictedFiles(cwd: string): Promise<string[]> {
  const out = await runGit(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd }).catch(() => '');
  return out.split('\0').filter(Boolean);
}

function withoutCheck(item: BacklogItem): BacklogItem {
  const { mainCheck: _dropped, ...rest } = item;
  return rest;
}

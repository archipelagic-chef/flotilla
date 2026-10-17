import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from '../core/repository';
import { branchMatches, type BacklogItem } from '../features/backlog/backlog';
import type { Leader } from '../features/backlog/leader';
import type { LocalBacklog } from '../features/backlog/localBacklog';
import { entryDate } from '../features/backlog/ticket';
import { FINISHED_SWEEP_MS, formatBytes, freedBytes, removalDecision, type RemovalDecision } from '../features/storage/finished';
import type { Workstream } from '../features/workstreams/workstream';
import type { WorktreeService } from '../features/worktrees/worktreeService';
import { workstreamLabel } from './format';
import { readSettings } from './settings';
import { extraWorkspaceFolder } from './workspaceFolders';

/** Tickets whose worktree the user chose to keep (workspace state). */
const KEPT_KEY = 'flotilla.finishedWorktrees.kept';
/** Leftover folders in .worktrees/ the user chose to keep (their names; workspace state). */
const KEPT_LEFTOVERS_KEY = 'flotilla.finishedWorktrees.keptLeftovers';
/** Set once the user answered the first question about the worktrees that were already finished. */
const INTRODUCED_KEY = 'flotilla.finishedWorktrees.introduced';
/** The first question measures what removing would free for at most this long, all worktrees together. */
const INTRO_MEASURE_MS = 10_000;

export interface FinishedWorktreesDeps {
  backlog: Pick<LocalBacklog, 'read' | 'watch' | 'appendActivity'>;
  repository: Pick<Repository<Workstream>, 'current' | 'refresh' | 'onDidChange'>;
  service: Pick<WorktreeService, 'removalRisks' | 'remove' | 'leftovers' | 'deleteLeftover'>;
  leader: Pick<Leader, 'isLeader'>;
  workspaceState: vscode.Memento;
  output: vscode.OutputChannel;
  /** The Remove command's own flow (it confirms when files would be lost), for "Remove Anyway". */
  removeAnyway: (ws: Workstream) => Promise<void>;
}

interface Candidate {
  ws: Workstream;
  item: BacklogItem;
  decision: RemovalDecision;
}

/**
 * Removes the worktrees of tickets that are done (`flotilla.removeFinishedWorktrees`), keeping their branches: when a
 * ticket moves to Done, and every half hour. A worktree is removed on its own only when nothing in it can be lost and
 * nobody is using it; otherwise the user is asked once. Only the leading window does it.
 */
export class FinishedWorktrees implements vscode.Disposable {
  private readonly subscriptions: Array<{ dispose(): void }> = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private queue: Promise<void> = Promise.resolve();
  /** Tickets asked about in this session (a question isn't repeated every sweep). */
  private readonly asked = new Set<string>();
  /** The first question was answered "Not now" in this session. */
  private introPostponed = false;
  /** Why each done ticket's worktree stays, as last said in the output (said again only when it changes). */
  private readonly said = new Map<string, string>();

  constructor(private readonly deps: FinishedWorktreesDeps) {
    this.subscriptions.push(deps.backlog.watch((changed) => changed.has('backlog.json') && void this.sweep()));
    // The first sweep waits for the worktrees to be read.
    const first = deps.repository.onDidChange(() => {
      first.dispose();
      void this.sweep();
    });
    this.subscriptions.push(first);
    this.timer = setInterval(() => void this.sweep(), FINISHED_SWEEP_MS);
  }

  /** Looks for finished worktrees and removes or asks about them. One sweep at a time; never rejects. */
  sweep(): Promise<void> {
    return this.enqueue(() => this.run());
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.queue = this.queue
      .then(work)
      .catch((error) => this.deps.output.appendLine(`Removing finished worktrees failed: ${error instanceof Error ? error.message : String(error)}`));
    return this.queue;
  }

  private async run(): Promise<void> {
    const mode = readSettings().removeFinishedWorktrees;
    if (mode === 'off' || !this.deps.leader.isLeader) return;
    await this.askAboutLeftovers();
    const candidates = await this.candidates();
    for (const c of candidates) if (c.decision.action === 'ask') this.explain(c.item.id, c.ws, c.decision.reason);
    if (!candidates.length) return;
    if (!this.deps.workspaceState.get<boolean>(INTRODUCED_KEY)) return this.introduce(candidates);
    for (const c of candidates) {
      if (c.decision.action === 'remove' && mode === 'auto') await this.remove(c);
      else if (c.decision.action !== 'skip') void this.ask(c, c.decision.action === 'ask' ? c.decision.reason : undefined);
    }
  }

  /** Each worktree whose tickets are done, with what to do about it. */
  private async candidates(): Promise<Candidate[]> {
    const items = (await this.deps.backlog.read()).items;
    const kept = new Set(this.deps.workspaceState.get<string[]>(KEPT_KEY) ?? []);
    const result: Candidate[] = [];
    for (const ws of this.deps.repository.current) {
      const branch = ws.worktree.branch;
      if (ws.worktree.isMain || !branch) continue;
      const tickets = items.filter((i) => branchMatches(i, branch));
      const item = tickets.find((i) => i.status === 'done' && !i.proposed);
      if (!item) continue;
      // A history clean-up in progress works in its own worktree, and compares and finishes there.
      if (tickets.some((i) => i.rewrite)) {
        this.explain(item.id, ws, 'a history clean-up is in progress');
        continue;
      }
      const input = {
        status: item.status,
        proposed: !!item.proposed,
        isMain: ws.worktree.isMain,
        reachable: !!ws.worktree.path,
        openTicketOnBranch: tickets.some((i) => i.status !== 'done'),
        kept: kept.has(item.id),
        changedFiles: ws.changes.length,
        agentRunning: (ws.agent?.state === 'working' || ws.agent?.state === 'waiting-for-input') && !ws.agentStale,
        windowOpen: ws.windowOpen || ws.isCurrent || !!extraWorkspaceFolder(ws.worktree.path),
        recentlyActive: ws.activity === 'active',
      };
      let decision = removalDecision(input);
      // The list can be a little old, and counts what removal doesn't lose (an untracked link): git is asked again.
      if (decision.action !== 'skip') decision = removalDecision({ ...input, changedFiles: (await this.deps.service.removalRisks(ws.worktree)).changedFiles });
      if (decision.action !== 'skip') result.push({ ws, item, decision });
      else if (decision.reason) this.explain(item.id, ws, decision.reason);
    }
    return result;
  }

  /** Says in the output why a done ticket's worktree stays, when that's news. */
  private explain(id: string, ws: Workstream, reason: string): void {
    if (this.said.get(ws.key) === reason) return;
    this.said.set(ws.key, reason);
    this.deps.output.appendLine(`${id} is done, but its worktree '${workstreamLabel(ws)}' stays: ${reason}.`);
  }

  /** Asks once about each folder in .worktrees/ that a removal left behind halfway (git no longer knows it). */
  private async askAboutLeftovers(): Promise<void> {
    const kept = new Set(this.deps.workspaceState.get<string[]>(KEPT_LEFTOVERS_KEY) ?? []);
    for (const dir of await this.deps.service.leftovers()) {
      const name = path.basename(dir);
      if (kept.has(name) || this.asked.has(`leftover:${name}`)) continue;
      this.asked.add(`leftover:${name}`);
      void this.askAboutLeftover(dir, name);
    }
  }

  private async askAboutLeftover(dir: string, name: string): Promise<void> {
    const size = await freedBytes(dir);
    const choice = await vscode.window.showInformationMessage(
      `'${name}' in .worktrees was left behind by a worktree removal that stopped halfway: git no longer knows it${size ? `, and it takes ${formatBytes(size)}` : ''}. Delete it?`,
      'Delete',
      'Keep',
    );
    if (choice === 'Keep') {
      const kept = new Set(this.deps.workspaceState.get<string[]>(KEPT_LEFTOVERS_KEY) ?? []);
      await this.deps.workspaceState.update(KEPT_LEFTOVERS_KEY, [...kept.add(name)]);
    } else if (choice === 'Delete') {
      await this.enqueue(async () => {
        await this.deps.service.deleteLeftover(dir);
        this.deps.output.appendLine(`Deleted the leftover folder ${dir}${size ? `: ${formatBytes(size)} freed` : ''}.`);
      });
    }
  }

  /** The first time: one question for all the worktrees that were already finished, before anything is removed. */
  private async introduce(candidates: Candidate[]): Promise<void> {
    if (this.introPostponed) return;
    const removable = candidates.filter((c) => c.decision.action === 'remove');
    if (!removable.length) return;
    const deadline = Date.now() + INTRO_MEASURE_MS;
    let bytes = 0;
    for (const c of removable) {
      const left = deadline - Date.now();
      const size = left > 0 ? await freedBytes(c.ws.worktree.path!, left) : undefined;
      if (size === undefined) {
        bytes = 0; // too slow to say: the question says no size
        break;
      }
      bytes += size;
    }
    const n = removable.length;
    const what = n === 1 ? `The worktree of ${removable[0].item.id} belongs to a ticket that is done` : `${n} worktrees belong to tickets that are done`;
    const choice = await vscode.window.showInformationMessage(
      `${what}${bytes ? ` and take ${formatBytes(bytes)}` : ''}. Remove ${n === 1 ? 'it' : 'them'}? Branches are kept, and Flotilla removes finished worktrees from now on.`,
      'Remove',
      'Not Now',
      'Never',
    );
    if (choice === 'Never') {
      await vscode.workspace.getConfiguration('flotilla').update('removeFinishedWorktrees', 'off', vscode.ConfigurationTarget.Workspace);
      await this.deps.workspaceState.update(INTRODUCED_KEY, true);
      return;
    }
    if (choice !== 'Remove') {
      this.introPostponed = true;
      return;
    }
    await this.deps.workspaceState.update(INTRODUCED_KEY, true);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Removing finished worktrees…' }, async (progress) => {
      for (const c of removable) {
        progress.report({ message: workstreamLabel(c.ws), increment: 100 / n });
        await this.remove(c);
      }
    });
  }

  /** Asks once per ticket and session: Remove (the Remove command when something's at stake) or Keep (remembered). */
  private async ask(c: Candidate, reason: string | undefined): Promise<void> {
    if (this.asked.has(c.item.id)) return;
    this.asked.add(c.item.id);
    const choice = await vscode.window.showInformationMessage(
      reason
        ? `${c.item.id} is done, but its worktree wasn't removed: ${reason}.`
        : `${c.item.id} is done. Remove its worktree '${workstreamLabel(c.ws)}'? The branch is kept.`,
      reason ? 'Remove Anyway' : 'Remove',
      'Keep',
    );
    if (choice === 'Keep') {
      const kept = new Set(this.deps.workspaceState.get<string[]>(KEPT_KEY) ?? []);
      await this.deps.workspaceState.update(KEPT_KEY, [...kept.add(c.item.id)]);
    } else if (choice === 'Remove Anyway') {
      await this.deps.removeAnyway(c.ws);
    } else if (choice === 'Remove') {
      await this.enqueue(() => this.remove(c));
    }
  }

  private async remove(c: Candidate): Promise<void> {
    const { ws } = c;
    const branch = ws.worktree.branch!;
    const freed = await freedBytes(ws.worktree.path!);
    try {
      await this.deps.service.remove(ws.worktree, { force: false });
    } catch (error) {
      this.deps.output.appendLine(`Couldn't remove the worktree of ${branch}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const size = freed === undefined ? '' : `: ${formatBytes(freed)} freed`;
    this.deps.output.appendLine(`Removed the worktree of ${branch}, whose ticket is done${size}.`);
    for (const item of (await this.deps.backlog.read()).items.filter((i) => i.status === 'done' && branchMatches(i, branch))) {
      await this.deps.backlog.appendActivity(item, {
        date: entryDate(new Date()),
        author: 'Flotilla',
        body: `Removed the worktree of \`${branch}\` now that the ticket is done; the branch stays${size}.`,
      });
    }
    await this.deps.repository.refresh();
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const s of this.subscriptions) s.dispose();
  }
}

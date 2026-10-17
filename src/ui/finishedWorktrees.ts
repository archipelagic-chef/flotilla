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
/** Where a Keep is taken back. */
const KEPT_COMMAND = "'Flotilla: Kept Worktrees and Folders…'";

/** What the user chose to keep: done tickets (their worktrees) and leftover folders in .worktrees/ (their names). */
export interface KeptChoices {
  tickets: string[];
  leftovers: string[];
}

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
      this.deps.output.appendLine(`Keeping the leftover folder '${name}' in .worktrees; ${KEPT_COMMAND} takes that back.`);
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
      this.deps.output.appendLine(`Keeping the worktree of ${c.item.id}; ${KEPT_COMMAND} takes that back.`);
    } else if (choice === 'Remove Anyway') {
      await this.deps.removeAnyway(c.ws);
    } else if (choice === 'Remove') {
      await this.enqueue(() => this.remove(c));
    }
  }

  /** What the user chose Keep for, in this workspace. */
  kept(): KeptChoices {
    return {
      tickets: this.deps.workspaceState.get<string[]>(KEPT_KEY) ?? [],
      leftovers: this.deps.workspaceState.get<string[]>(KEPT_LEFTOVERS_KEY) ?? [],
    };
  }

  /** Takes Keep back for these: they're asked about again, in a sweep that starts now. */
  async forget(choices: Partial<KeptChoices>): Promise<void> {
    const tickets = new Set(choices.tickets ?? []);
    const leftovers = new Set(choices.leftovers ?? []);
    const { tickets: keptTickets, leftovers: keptLeftovers } = this.kept();
    await this.deps.workspaceState.update(KEPT_KEY, keptTickets.filter((id) => !tickets.has(id)));
    await this.deps.workspaceState.update(KEPT_LEFTOVERS_KEY, keptLeftovers.filter((name) => !leftovers.has(name)));
    for (const id of tickets) this.asked.delete(id);
    for (const name of leftovers) this.asked.delete(`leftover:${name}`);
    for (const id of tickets) this.deps.output.appendLine(`No longer keeping the worktree of ${id}: Flotilla asks about it again.`);
    for (const name of leftovers) this.deps.output.appendLine(`No longer keeping the leftover folder '${name}': Flotilla asks about it again.`);
    await this.sweep();
  }

  /** The Kept Worktrees and Folders command: lists what was kept, and takes back the ones picked. */
  async showKept(): Promise<void> {
    const { tickets, leftovers } = this.kept();
    if (!tickets.length && !leftovers.length) {
      void vscode.window.showInformationMessage('You haven’t kept any finished worktree or leftover folder: Flotilla asks about all of them.');
      return;
    }
    const items = (await this.deps.backlog.read()).items;
    const present = new Set((await this.deps.service.leftovers()).map((dir) => path.basename(dir)));
    type Pick = vscode.QuickPickItem & { ticket?: string; leftover?: string };
    const picks: Pick[] = [
      ...tickets.map((id): Pick => {
        const item = items.find((i) => i.id === id);
        const ws = item && this.deps.repository.current.find((w) => !w.worktree.isMain && w.worktree.branch && branchMatches(item, w.worktree.branch));
        return {
          label: id,
          description: item?.title ?? 'no longer in the backlog',
          detail: ws ? `Worktree '${workstreamLabel(ws)}'` : 'Its worktree is gone',
          ticket: id,
        };
      }),
      ...leftovers.map((name): Pick => ({
        label: name,
        description: 'Leftover folder in .worktrees',
        detail: present.has(name) ? undefined : 'No longer there',
        leftover: name,
      })),
    ];
    const chosen = await vscode.window.showQuickPick(picks, {
      canPickMany: true,
      title: 'Kept Worktrees and Folders',
      placeHolder: 'Pick the ones Flotilla should ask about again',
    });
    if (!chosen?.length) return;
    await this.forget({
      tickets: chosen.flatMap((p) => (p.ticket ? [p.ticket] : [])),
      leftovers: chosen.flatMap((p) => (p.leftover ? [p.leftover] : [])),
    });
    if (readSettings().removeFinishedWorktrees === 'off') {
      void vscode.window.showInformationMessage('Taken back. Flotilla asks again once flotilla.removeFinishedWorktrees is no longer off.');
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

import * as vscode from 'vscode';
import type { Repository } from '../core/repository';
import type { BacklogItem } from '../features/backlog/backlog';
import type { LocalBacklog } from '../features/backlog/localBacklog';
import type { Leader } from '../features/backlog/leader';
import {
  isWarning,
  type NeedsYou,
  needsYouList,
  needsYouMessage,
  newNeeds,
  phrase,
  subject,
} from '../features/needsYou';
import type { Workstream } from '../features/workstreams/workstream';
import { workstreamLabel } from './format';
import { readSettings } from './settings';
import type { NoteAgents } from './backlog/notes';
import type { ReviewLoop } from './backlog/reviewLoop';

/** How long needs are gathered before one notification says them all (`needsYou`). */
const BATCH_MS = 60_000;

/**
 * Keeps the list of what needs the user (see features/needsYou.ts) and tells them about it: one notification for the
 * needs gathered in a minute (`flotilla.notify` `needsYou`), or one per need at once (`all`), or nothing (`off`; the
 * list still counts). Only the leading window notifies, so several windows don't repeat it.
 */
export class NeedsYouNotifier implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private list: NeedsYou[] = [];
  private previous: Set<string> | undefined;
  private pending: NeedsYou[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly subscriptions: Array<{ dispose(): void }>;

  constructor(
    private readonly deps: {
      backlog: LocalBacklog;
      repository: Repository<Workstream>;
      reviews: Pick<ReviewLoop, 'onDidChange'>;
      notes: Pick<NoteAgents, 'views' | 'onDidChange'>;
      leader: Pick<Leader, 'isLeader'>;
      openTicket: (id: string) => void;
      /** Shows the note's card in the backlog (where you answer it). */
      openNote: (id: string) => void;
      openWorktree: (ws: Workstream, newWindow: boolean) => Promise<void>;
    },
  ) {
    this.subscriptions = [
      deps.repository.onDidChange(() => void this.refresh()),
      deps.reviews.onDidChange(() => void this.refresh()),
      deps.notes.onDidChange(() => void this.refresh()),
      deps.backlog.watch(() => void this.refresh()),
    ];
    // The first list is a baseline: what was already there when the window opened isn't news.
    void this.refresh();
  }

  /** What needs the user now, in the order of the "Needs you" list. */
  get current(): readonly NeedsYou[] {
    return this.list;
  }

  /** Reads the list again and notifies about what is new in it. One refresh runs at a time. */
  refresh(): Promise<void> {
    // A failed refresh doesn't hold up the next one.
    this.queue = this.queue.then(() => this.apply()).catch(() => undefined);
    return this.queue;
  }

  private async apply(): Promise<void> {
    let items: BacklogItem[];
    try {
      items = (await this.deps.backlog.read()).items;
    } catch {
      return; // the backlog can't be read right now: the list stays as it was
    }
    const worktrees = this.deps.repository.current.map((ws) => ({
      key: ws.key,
      label: workstreamLabel(ws),
      attention: ws.attention,
      current: ws.isCurrent,
    }));
    // Notes that can't be read right now ask nothing: the tickets and worktrees still count.
    const notes = await this.deps.notes.views().catch(() => []);
    const next = needsYouList(items, worktrees, notes);
    const fresh = newNeeds(this.previous, next);
    this.previous = new Set(next.map((n) => n.key));
    this.list = next;
    this.changed.fire();
    if (fresh.length && this.deps.leader.isLeader) this.notify(fresh.filter((n) => !n.worktree?.current));
  }

  private notify(fresh: NeedsYou[]): void {
    const mode = readSettings().notify;
    if (mode === 'off' || !fresh.length) return;
    if (mode === 'all') {
      for (const n of fresh) void this.notifyOne(n);
      return;
    }
    this.pending.push(...fresh);
    this.timer ??= setTimeout(() => this.flush(), BATCH_MS);
  }

  /** The gathered needs, as one notification (those still needing the user; the rest were dealt with meanwhile). */
  private flush(): void {
    this.timer = undefined;
    const open = new Set(this.list.map((n) => n.key));
    const batch = this.pending.splice(0).filter((n) => open.has(n.key));
    if (!batch.length || readSettings().notify === 'off') return;
    const text = needsYouMessage(batch);
    const choice = batch.some((n) => isWarning(n.kind)) ? vscode.window.showWarningMessage(text, 'Show') : vscode.window.showInformationMessage(text, 'Show');
    void choice.then((c) => c && this.showList());
  }

  private async notifyOne(n: NeedsYou): Promise<void> {
    const text = needsYouMessage([n]);
    if (n.ticket) {
      const id = n.ticket.id;
      const choice = await (isWarning(n.kind) ? vscode.window.showWarningMessage(text, 'Open') : vscode.window.showInformationMessage(text, 'Open'));
      if (choice) this.deps.openTicket(id);
      return;
    }
    if (n.note) {
      const id = n.note.id;
      if (await vscode.window.showInformationMessage(text, 'Open')) this.deps.openNote(id);
      return;
    }
    const ws = this.workstream(n);
    if (!ws?.worktree.path) return;
    const choice = await (isWarning(n.kind)
      ? vscode.window.showWarningMessage(text, 'Open Window', 'Switch Here')
      : vscode.window.showInformationMessage(text, 'Open Window', 'Switch Here'));
    if (choice) await this.deps.openWorktree(ws, choice === 'Open Window');
  }

  private workstream(n: NeedsYou): Workstream | undefined {
    return this.deps.repository.current.find((ws) => ws.key === n.worktree?.key);
  }

  /** The "Needs you" list: picking a ticket or a note opens it, picking a worktree switches to it here. */
  async showList(): Promise<void> {
    await this.refresh();
    if (!this.list.length) {
      void vscode.window.showInformationMessage('Nothing needs you right now.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      this.list.map((n) => ({
        label: n.ticket ? `${n.ticket.id}  ${n.ticket.title}` : n.note ? `${n.note.id}  ${n.note.title}` : subject(n),
        description: phrase(n.kind),
        need: n,
      })),
      { title: 'Needs you', placeHolder: 'Pick one to open it' },
    );
    if (!pick) return;
    if (pick.need.ticket) return this.deps.openTicket(pick.need.ticket.id);
    if (pick.need.note) return this.deps.openNote(pick.need.note.id);
    const ws = this.workstream(pick.need);
    if (ws?.worktree.path) await this.deps.openWorktree(ws, false);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.subscriptions.forEach((s) => s.dispose());
    this.changed.dispose();
  }
}

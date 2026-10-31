import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import { currentPrefix } from '../../features/backlog/backlog';
import {
  installCommitHook,
  markWorktree,
} from '../../features/backlog/commitHook';
import {
  agentGuide,
  type AgentTicketMode,
  GUIDE,
  INBOX,
  takeInbox,
} from '../../features/backlog/inbox';
import type { NoteStore } from '../../features/backlog/notes';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import type { Workstream } from '../../features/workstreams/workstream';
import { commitPrefixMode } from '../commands';
import type { BacklogIntegrations } from './integrations';

export function agentTicketMode(): AgentTicketMode {
  return vscode.workspace.getConfiguration('flotilla').get<AgentTicketMode>('backlog.agentTickets', 'propose');
}

/**
 * Keeps the agents' guide (AGENTS.md) current and takes in the tickets agents write to the inbox, telling the user
 * about them. Agents that start on a ticket they added get its worktree marked (their commits then carry its id).
 */
export class BacklogInbox implements vscode.Disposable {
  private readonly timer: ReturnType<typeof setInterval>;
  private busy = false;

  constructor(
    private readonly backlog: LocalBacklog,
    private readonly integrations: BacklogIntegrations,
    private readonly repository: Repository<Workstream>,
    private readonly roots: { mainRoot: string; commonDir: string },
    /** The notes (BL-182): a proposal from one is recorded in it. */
    private readonly notes?: NoteStore,
  ) {
    void this.writeGuide();
    this.timer = setInterval(() => void this.take(), 2000);
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  /** Writes the guide (with the inbox folder, so agents can add tickets now). */
  async writeGuide(): Promise<void> {
    try {
      await this.backlog.ensureDir();
      await fs.promises.mkdir(path.join(this.backlog.dir, INBOX), { recursive: true });
      const file = path.join(this.backlog.dir, GUIDE);
      const text = agentGuide(this.backlog.dir, agentTicketMode());
      if ((await fs.promises.readFile(file, 'utf8').catch(() => '')) !== text) await fs.promises.writeFile(file, text);
    } catch {
      // no backlog folder possible (read-only checkout): agents just can't add tickets
    }
  }

  get guidePath(): string {
    return path.join(this.backlog.dir, GUIDE);
  }

  private async take(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const mode = agentTicketMode();
      const prefix = currentPrefix(await this.backlog.read(), vscode.workspace.getConfiguration('flotilla').get<string>('backlog.idPrefix', 'BL'));
      // What the agents added is news for "Needs you" (proposals), not a notification of its own.
      await takeInbox(this.backlog, {
        prefix,
        mode,
        taken: this.integrations.issues().map((i) => i.id),
        onStarted: async (item, branch) => {
          // The main worktree isn't marked: the mark would stay on everything committed there.
          const ws = this.repository.current.find((w) => w.worktree.branch === branch && !w.worktree.isMain);
          if (!ws) return;
          await markWorktree(ws.worktree.adminDir, item.id);
          await installCommitHook(this.roots.mainRoot, this.roots.commonDir, commitPrefixMode()).catch(() => undefined);
        },
        onFromNotes: async (notes, item) => this.notes?.recordBecame(notes, { id: item.id, kind: 'proposal' }),
      });
    } catch {
      // try again on the next round
    } finally {
      this.busy = false;
    }
  }
}

import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import type { Merger } from './merge';
import {
  checksDetail,
  checksQuestion,
  mergePaused,
  type PausedAgent,
  type PausedAllStore,
  pausedMessage,
  resumedMessage,
  resumeOrder,
} from '../../features/backlog/pausedAll';
import type { ReviewLoop } from './reviewLoop';
import type { Shaping } from './shaping';

export interface PauseAllDeps {
  backlog: LocalBacklog;
  reviews: Pick<ReviewLoop, 'pauseForAll' | 'resumeForAll'>;
  shaping?: Pick<Shaping, 'isRunning' | 'control'>;
  /** Merges' agents and checks (BL-164). */
  merges?: Pick<Merger, 'pauseForAll' | 'resumeForAll' | 'checksRunning' | 'stopChecks'>;
  store: PausedAllStore;
  /** The hold is lifted (Resume All, here or in another window): the queue and the autopilot go on. */
  lifted?(): void;
}

/** What Pause All did: the agents it paused, and those in Claude Code's panel it couldn't. */
export interface PauseAllResult {
  paused: PausedAgent[];
  inChats: Array<{ id: string; agent: string; key?: string; chatId: string }>;
}

/**
 * Pause All and Resume All (BL-160): every agent working on a ticket paused as its ticket's Pause does (BL-81), the set
 * saved (see PausedAllStore) so that Resume All resumes exactly those, and nothing starts on its own meanwhile.
 */
export class PauseAll implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  private held: boolean;

  constructor(private readonly deps: PauseAllDeps) {
    this.held = deps.store.held;
    // Another window paused or resumed: the views show it, and the queue goes on once it's lifted.
    fs.watchFile(deps.store.file, { interval: 2000 }, () => this.refresh());
  }

  dispose(): void {
    fs.unwatchFile(this.deps.store.file);
    this.changed.dispose();
  }

  /** The record changed: the views show it anew, and when the hold's lifted, the queue goes on. */
  private refresh(): void {
    const held = this.deps.store.held;
    if (this.held && !held) this.deps.lifted?.();
    this.held = held;
    this.changed.fire();
  }

  /** How many agents Pause All paused, while it holds; undefined when it doesn't. */
  get pausedCount(): number | undefined {
    return this.deps.store.read()?.agents.length;
  }

  /**
   * Pauses every agent working on a ticket (merges' too), top of the backlog first; the set is added to one already
   * paused. stopChecks: merges' checks running now stop as well (their merges can be run again); else they finish.
   */
  async pause(o: { stopChecks?: boolean } = {}): Promise<PauseAllResult> {
    const before = this.deps.store.read()?.agents ?? [];
    // Held first: nothing starts while the agents are paused one by one.
    await this.deps.store.write({ at: new Date().toISOString(), agents: before });
    this.refresh();
    const paused: PausedAgent[] = [];
    const inChats: PauseAllResult['inChats'] = [];
    if (o.stopChecks) for (const id of this.deps.merges?.checksRunning() ?? []) this.deps.merges?.stopChecks(id);
    for (const item of (await this.deps.backlog.read()).items) {
      try {
        const merge = item.merging?.state === 'resolving' ? await this.deps.merges?.pauseForAll(item.id) : undefined;
        if (merge) paused.push({ id: item.id, kind: 'merge', session: merge });
        if (item.shaping && !item.shaping.held && this.deps.shaping?.isRunning(item.id)) {
          await this.deps.shaping.control(item.id, 'pause');
          paused.push({ id: item.id, kind: 'discussion' });
          continue;
        }
        const r = await this.deps.reviews.pauseForAll(item.id);
        if (r && 'paused' in r) paused.push({ id: item.id, kind: 'agent', session: r.paused });
        else if (r) inChats.push({ id: item.id, ...r.panel });
      } finally {
        // Saved as it goes: a reload halfway still resumes those already paused.
        if (paused.length) await this.deps.store.write({ at: new Date().toISOString(), agents: mergePaused(before, paused) });
      }
    }
    this.refresh();
    return { paused, inChats };
  }

  /**
   * Resumes the agents Pause All paused, top of the backlog first, within flotilla.agents.maxRunning (the rest wait in
   * the queue), and lets agents start again. Those paused by hand, or resumed or stopped since, are left as they are.
   */
  async resume(): Promise<{ resumed: number; waiting: number }> {
    const set = this.deps.store.read()?.agents ?? [];
    let resumed = 0;
    let waiting = 0;
    for (const a of resumeOrder((await this.deps.backlog.read()).items, set)) {
      if (a.kind === 'discussion') {
        const item = (await this.deps.backlog.read()).items.find((i) => i.id === a.id);
        if (item?.shaping?.held?.kind !== 'paused') continue;
        await this.deps.shaping?.control(a.id, 'resume');
        resumed++;
        continue;
      }
      if (a.kind === 'merge') {
        if ((await this.deps.merges?.resumeForAll(a.id, a.session)) === 'running') resumed++;
        continue;
      }
      const r = await this.deps.reviews.resumeForAll(a.id, a.session);
      if (r === 'running') resumed++;
      else if (r === 'waiting') waiting++;
    }
    // Lifted once they're on their way: they take the free slots before the starts that waited.
    await this.deps.store.clear();
    this.refresh();
    return { resumed, waiting };
  }

  /**
   * The command: asks first while merges' checks run (let them finish, or stop them), pauses, and says what it did
   * (with Open Chat for the agents it couldn't pause).
   */
  async pauseCommand(): Promise<void> {
    const checks = this.deps.merges?.checksRunning() ?? [];
    let stopChecks = false;
    if (checks.length) {
      const finish = 'Let Them Finish';
      const choice = await vscode.window.showWarningMessage(checksQuestion(checks), { modal: true, detail: checksDetail(checks) }, finish, 'Stop Them');
      if (!choice) return;
      stopChecks = choice !== finish;
    }
    const { paused, inChats } = await this.pause({ stopChecks });
    const chat = inChats[0];
    // Not awaited: the button stops working when the agents are paused, not when the message goes.
    void vscode.window
      .showInformationMessage(pausedMessage(paused.length, inChats.length), ...(chat?.key ? ['Open Chat'] : []))
      .then((choice) => choice && chat?.key && vscode.commands.executeCommand('flotilla.openChat', { key: chat.key, chatId: chat.chatId }));
  }

  /** The command: resumes, and says what it did. */
  async resumeCommand(): Promise<void> {
    const { resumed, waiting } = await this.resume();
    void vscode.window.showInformationMessage(resumedMessage(resumed, waiting));
  }
}

import * as vscode from 'vscode';
import type { Repository } from '../core/repository';
import type { Leader } from '../features/backlog/leader';
import { FINISHED_SWEEP_MS, formatBytes } from '../features/storage/finished';
import type { Workstream } from '../features/workstreams/workstream';
import { shareLinkedFolder, type ShareResult } from '../features/worktrees/setup';
import { workstreamLabel } from './format';
import { readSettings } from './settings';

/**
 * When each worktree's linked folders were last shared (worktree key → ms; workspace state). v2: every worktree is swept
 * again at once, so files written in place that were shared before become copies again.
 */
const SHARED_AT_KEY = 'flotilla.sharedFolders.sharedAt.v2';
/** A worktree's linked folders are shared again after this long: installs in it may have copied files meanwhile. */
const SHARE_EVERY_MS = 24 * 60 * 60_000;

export interface SharedFoldersDeps {
  repository: Pick<Repository<Workstream>, 'current' | 'onDidChange'>;
  leader: Pick<Leader, 'isLeader'>;
  mainRoot: string;
  workspaceState: vscode.Memento;
  output: vscode.OutputChannel;
}

/**
 * Keeps the worktrees' copies of `flotilla.linkFolders` sharing the main worktree's files (shareLinkedFolder): worktrees
 * made before the setting, or where an install copied files, take the space of one copy again. In the background in the
 * leading window, each worktree at most once a day; and at once by a command.
 */
export class SharedFolders implements vscode.Disposable {
  private readonly subscriptions: Array<{ dispose(): void }> = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SharedFoldersDeps) {
    const first = deps.repository.onDidChange(() => {
      first.dispose();
      void this.sweep();
    });
    this.subscriptions.push(first);
    this.timer = setInterval(() => void this.sweep(), FINISHED_SWEEP_MS);
  }

  /** Shares the worktrees not shared in the last day. Never rejects. */
  sweep(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.deps.leader.isLeader) return;
      await this.share(false);
    });
  }

  /** The command: shares every worktree now, and says what it freed. */
  async shareNow(): Promise<void> {
    if (!readSettings().linkFolders.length) {
      const choice = await vscode.window.showInformationMessage('Set flotilla.linkFolders first, e.g. ["node_modules"].', 'Open Setting');
      if (choice) await vscode.commands.executeCommand('workbench.action.openSettings', 'flotilla.linkFolders');
      return;
    }
    const results = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Sharing linked folders…' },
      () => this.enqueue(() => this.share(true)),
    );
    const files = results.reduce((n, r) => n + r.files, 0);
    const bytes = results.reduce((n, r) => n + r.bytes, 0);
    const unshared = results.reduce((n, r) => n + r.unshared, 0);
    const copied = unshared ? ` Copied ${unshared} files that installs or tools write in place.` : '';
    void vscode.window.showInformationMessage(
      (files ? `Shared ${files} files with the main worktree: ${formatBytes(bytes)} freed.` : 'Nothing to share: the worktrees already share every file they can.') + copied,
    );
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch((error) => this.deps.output.appendLine(`Sharing linked folders failed: ${error instanceof Error ? error.message : String(error)}`));
    return run;
  }

  private async share(all: boolean): Promise<ShareResult[]> {
    const folders = readSettings().linkFolders;
    if (!folders.length) return [];
    const sharedAt = { ...(this.deps.workspaceState.get<Record<string, number>>(SHARED_AT_KEY) ?? {}) };
    const now = Date.now();
    const results: ShareResult[] = [];
    for (const ws of this.deps.repository.current) {
      if (ws.worktree.isMain || !ws.worktree.path) continue;
      if (!all && now - (sharedAt[ws.key] ?? 0) < SHARE_EVERY_MS) continue;
      for (const folder of folders) {
        const r = await shareLinkedFolder(this.deps.mainRoot, ws.worktree.path, folder);
        results.push(r);
        if (r.unshared) {
          this.deps.output.appendLine(`Copied ${r.unshared} files of ${folder} in '${workstreamLabel(ws)}' that were linked to the main worktree's: installs or tools write them in place.`);
        }
        if (r.files || r.skipped) {
          const skipped = r.skipped ? ` (${r.skipped} in use, left as they were)` : '';
          this.deps.output.appendLine(`Shared ${r.files} files of ${folder} in '${workstreamLabel(ws)}' with the main worktree: ${formatBytes(r.bytes)} freed${skipped}.`);
        }
      }
      sharedAt[ws.key] = now;
    }
    // Worktrees that are gone are forgotten.
    const keys = new Set(this.deps.repository.current.map((w) => w.key));
    for (const key of Object.keys(sharedAt)) if (!keys.has(key)) delete sharedAt[key];
    await this.deps.workspaceState.update(SHARED_AT_KEY, sharedAt);
    return results;
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const s of this.subscriptions) s.dispose();
  }
}

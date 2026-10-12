import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import { notifies, type FinishedRun } from '../../features/ci/notify';
import type { Workstream } from '../../features/workstreams/workstream';
import { workstreamLabel } from '../format';
import { readSettings } from '../settings';

export interface CiNotifierDeps {
  repository: Repository<Workstream>;
  /** Only the leading window tells the user, so several windows don't all notify. */
  isLeader(): boolean;
  /** Shows the worktree's CI/CD view (the Show button). */
  show(key: string): void;
}

/** Tells the user when a run they watched on a worktree's branch finishes (one notice per run, from the leading window). */
export class CiNotifier {
  constructor(private readonly deps: CiNotifierDeps) {}

  notify(items: readonly FinishedRun[]): void {
    if (!this.deps.isLeader()) return;
    const mode = readSettings().ciNotify;
    for (const item of items) {
      if (!notifies(item.run, mode)) continue;
      const ws = this.deps.repository.current.find((w) => w.key === item.key);
      const what = `${item.run.workflow} #${item.run.number} on ${ws ? workstreamLabel(ws) : item.branch}`;
      const failed = item.run.status === 'failure';
      const text = failed ? `CI failed: ${what}.` : `CI ${item.run.status === 'success' ? 'passed' : item.run.status}: ${what}.`;
      const choice = failed ? vscode.window.showWarningMessage(text, 'Show') : vscode.window.showInformationMessage(text, 'Show');
      void choice.then((picked) => {
        if (picked === 'Show') this.deps.show(item.key);
      });
    }
  }
}

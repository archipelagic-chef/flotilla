import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import { failedJob } from '../../features/ci/failureTask';
import type { GitHubActions } from '../../features/ci/githubActions';
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
  /** The GitHub client of a repository (the job and its log, for Fix with Agent). */
  actions(owner: string, repo: string): GitHubActions;
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
      const buttons = failed ? ['Show', 'Fix with Agent'] : ['Show'];
      const choice = failed ? vscode.window.showWarningMessage(text, ...buttons) : vscode.window.showInformationMessage(text, ...buttons);
      void choice.then((picked) => {
        if (picked === 'Show') this.deps.show(item.key);
        else if (picked === 'Fix with Agent') void this.fix(item);
      });
    }
  }

  /** Starts the agent that fixes the run's failed job (BL-7's command), with the job's steps and log. */
  private async fix(item: FinishedRun): Promise<void> {
    try {
      const [owner, repo] = item.repo.split('/');
      const client = this.deps.actions(owner, repo);
      const failure = await failedJob(client, item.branch, item.run);
      if (!failure) {
        void vscode.window.showWarningMessage(`No job of ${item.run.workflow} #${item.run.number} failed, so there's nothing for an agent to fix.`);
        return;
      }
      await vscode.commands.executeCommand('flotilla.ci.fixWithAgent', failure);
    } catch (error) {
      void vscode.window.showErrorMessage(`Fix with Agent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

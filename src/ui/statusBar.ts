import * as vscode from 'vscode';
import type { Repository } from '../core/repository';
import type { Workstream } from '../features/workstreams/workstream';
import type { ActiveWorktree } from './activeWorktree';
import { workstreamLabel } from './format';

/** Shows the active worktree (or All) and how many worktrees need you; click to switch. */
export class WorkstreamStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('flotilla.current', vscode.StatusBarAlignment.Left, 50);
  private readonly subscriptions: Array<{ dispose(): void }>;

  constructor(
    private readonly repository: Repository<Workstream>,
    private readonly active: ActiveWorktree,
  ) {
    this.item.name = 'Flotilla';
    // Always visible: the way back to Flotilla when VS Code's activity bar is hidden.
    this.item.command = 'flotilla.showSidebar';
    this.subscriptions = [repository.onDidChange(() => this.update()), active.onDidChange(() => this.update())];
    this.update();
    this.item.show();
  }

  private update(): void {
    const items = this.repository.current;
    const current = items.find((ws) => ws.key === this.active.key);
    const waiting = items.filter((ws) => ws.key !== this.active.key && (ws.attention === 'waiting-for-input' || ws.attention === 'error')).length;
    this.item.text = `$(${current ? 'git-branch' : 'layers'}) ${current ? workstreamLabel(current) : 'All worktrees'}${waiting ? `  $(bell-dot) ${waiting}` : ''}`;
    const tooltip = new vscode.MarkdownString(
      `${waiting ? `${waiting} other worktree(s) need attention.\n\n` : ''}Click to show Flotilla.\n\n[Switch active worktree…](command:flotilla.selectWorktree) (Ctrl+Alt+0…9)`,
    );
    tooltip.isTrusted = { enabledCommands: ['flotilla.selectWorktree'] };
    this.item.tooltip = tooltip;
    this.item.backgroundColor = waiting ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
    this.item.dispose();
  }
}

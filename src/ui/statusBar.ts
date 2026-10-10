import * as vscode from 'vscode';
import type { Repository } from '../core/repository';
import type { Workstream } from '../features/workstreams/workstream';
import { workstreamLabel } from './format';

export class WorkstreamStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('flotilla.current', vscode.StatusBarAlignment.Left, 50);
  private readonly subscription: { dispose(): void };

  constructor(private readonly repository: Repository<Workstream>) {
    this.item.name = 'Flotilla';
    this.item.command = 'flotilla.quickSwitch';
    this.subscription = repository.onDidChange(() => this.update());
    this.update();
    this.item.show();
  }

  private update(): void {
    const items = this.repository.current;
    const current = items.find((ws) => ws.isCurrent);
    const waiting = items.filter((ws) => !ws.isCurrent && (ws.attention === 'waiting-for-input' || ws.attention === 'error')).length;
    this.item.text = `$(git-branch) ${current ? workstreamLabel(current) : 'Flotilla'}${waiting ? `  $(bell-dot) ${waiting}` : ''}`;
    this.item.tooltip = waiting ? `${waiting} workstream(s) need attention. Click to switch.` : 'Switch workstream';
    this.item.backgroundColor = waiting ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}

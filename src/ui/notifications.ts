import * as vscode from 'vscode';
import type { Repository } from '../core/repository';
import { attentionTransitions, type AttentionState } from '../features/workstreams/attention';
import type { Workstream } from '../features/workstreams/workstream';
import { workstreamLabel } from './format';
import { readSettings } from './settings';

export class AttentionNotifier implements vscode.Disposable {
  private previous: Map<string, AttentionState> | undefined;
  private readonly subscription: { dispose(): void };

  constructor(
    private readonly repository: Repository<Workstream>,
    private readonly open: (ws: Workstream, newWindow: boolean) => Promise<void>,
  ) {
    this.subscription = repository.onDidChange(() => this.onChange());
  }

  private onChange(): void {
    const items = this.repository.current;
    const keys = attentionTransitions(this.previous, items.map((ws) => ({ key: ws.key, attention: ws.attention })));
    this.previous = new Map(items.map((ws) => [ws.key, ws.attention]));
    if (!readSettings().notifyOnAttention) return;
    for (const key of keys) {
      const ws = items.find((w) => w.key === key);
      if (ws && !ws.isCurrent && ws.worktree.path) void this.notify(ws);
    }
  }

  private async notify(ws: Workstream): Promise<void> {
    const label = workstreamLabel(ws);
    const detail = ws.agent?.message ? `: ${ws.agent.message}` : '';
    const text = ws.attention === 'error' ? `'${label}' reported an error${detail}` : `'${label}' is waiting for input${detail}`;
    const buttons = ['Open Window', 'Switch Here'];
    const choice =
      ws.attention === 'error'
        ? await vscode.window.showWarningMessage(text, ...buttons)
        : await vscode.window.showInformationMessage(text, ...buttons);
    if (choice) await this.open(ws, choice === 'Open Window');
  }

  dispose(): void {
    this.subscription.dispose();
  }
}

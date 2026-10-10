import * as vscode from 'vscode';

import { ALL } from '../webview/protocol';

export { ALL };

const STATE_KEY = 'flotilla.activeWorktree';

/**
 * The worktree this window works in, picked with the sidebar's worktree tabs (or ALL). New terminals and chats start
 * there, and the status bar shows it. Remembered per window.
 */
export class ActiveWorktree implements vscode.Disposable {
  private value: string;
  private readonly emitter = new vscode.EventEmitter<string>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly state: vscode.Memento) {
    this.value = state.get<string>(STATE_KEY) ?? ALL;
    void vscode.commands.executeCommand('setContext', STATE_KEY, this.value);
  }

  get key(): string {
    return this.value;
  }

  set(key: string): void {
    if (key === this.value) return;
    this.value = key;
    void this.state.update(STATE_KEY, key);
    void vscode.commands.executeCommand('setContext', STATE_KEY, key);
    this.emitter.fire(key);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

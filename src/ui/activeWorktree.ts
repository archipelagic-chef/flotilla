import * as vscode from 'vscode';

import { ALL } from '../webview/protocol';

export { ALL };

const STATE_KEY = 'flotilla.activeWorktree';
const CLOSED_KEY = 'flotilla.closedTabs';

/**
 * The worktree this window works in, picked with the sidebar's worktree tabs (or ALL). New terminals and chats start
 * there, and the status bar shows it. Also keeps which worktree tabs are closed (they are still listed in the
 * Overview, and opening one there reopens its tab). Both are remembered per window.
 */
export class ActiveWorktree implements vscode.Disposable {
  private value: string;
  private closed: Set<string>;
  private readonly emitter = new vscode.EventEmitter<string>();
  readonly onDidChange = this.emitter.event;
  private readonly tabsEmitter = new vscode.EventEmitter<readonly string[]>();
  readonly onDidChangeTabs = this.tabsEmitter.event;

  constructor(private readonly state: vscode.Memento) {
    this.value = state.get<string>(STATE_KEY) ?? ALL;
    this.closed = new Set(state.get<string[]>(CLOSED_KEY) ?? []);
    if (this.closed.has(this.value)) this.value = ALL;
    void vscode.commands.executeCommand('setContext', STATE_KEY, this.value);
  }

  get key(): string {
    return this.value;
  }

  get closedTabs(): readonly string[] {
    return [...this.closed];
  }

  isOpen(key: string): boolean {
    return !this.closed.has(key);
  }

  /** Closes a worktree's tab; if it was active, the next open tab (or the one before, or All) becomes active. */
  close(keys: readonly string[], order: readonly string[]): void {
    const shut = keys.filter((k) => k !== ALL && !this.closed.has(k));
    if (!shut.length) return;
    if (shut.includes(this.value)) {
      const open = order.filter((k) => !this.closed.has(k));
      const at = open.indexOf(this.value);
      const remaining = open.filter((k) => !shut.includes(k));
      const next = open.slice(at + 1).find((k) => !shut.includes(k)) ?? remaining.filter((k) => open.indexOf(k) < at).pop() ?? ALL;
      this.set(next);
    }
    shut.forEach((k) => this.closed.add(k));
    this.saveTabs();
  }

  private saveTabs(): void {
    void this.state.update(CLOSED_KEY, [...this.closed]);
    this.tabsEmitter.fire([...this.closed]);
  }

  /** Makes a worktree (or ALL) active, reopening its tab if it was closed. */
  set(key: string): void {
    if (this.closed.delete(key)) this.saveTabs();
    if (key === this.value) return;
    this.value = key;
    void this.state.update(STATE_KEY, key);
    void vscode.commands.executeCommand('setContext', STATE_KEY, key);
    this.emitter.fire(key);
  }

  dispose(): void {
    this.emitter.dispose();
    this.tabsEmitter.dispose();
  }
}

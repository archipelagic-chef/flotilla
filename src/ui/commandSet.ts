import * as vscode from 'vscode';
import type { Workstream } from '../features/workstreams/workstream';
import type { Target } from '../webview/protocol';

// Each feature's module says which commands it has (`mergeCommands(deps)`: id → handler), and extension.ts registers
// them: a new command goes to its feature's list, not to one list every ticket adds to the end of (BL-185).

export type Handler = (...args: any[]) => unknown;
/** A feature's commands: package.json's command id → what it runs. */
export type Commands = Record<string, Handler>;
/** Commands get a Target from the sidebar (or its context menus), a folder Uri from the Explorer, or nothing from the palette. */
export type Arg = Target | vscode.Uri | undefined;

export interface PickFilter {
  includeUnreachable?: boolean;
  excludeMain?: boolean;
}

/** A command on a worktree: the one it was given, the active one, or the one the user picks. */
export type WithWorkstream = (handler: (ws: Workstream, arg: Arg) => unknown, filter?: PickFilter) => (arg?: Arg) => Promise<void>;

export function isTarget(arg: unknown): arg is Target {
  return typeof arg === 'object' && arg !== null && !(arg instanceof vscode.Uri) && typeof (arg as Target).key === 'string';
}

/** Features' commands as one set; an id two features both have is a mistake, said at once. */
export function joinCommands(...sets: Commands[]): Commands {
  const all: Commands = {};
  for (const set of sets) {
    for (const [id, handler] of Object.entries(set)) {
      if (id in all) throw new Error(`Command ${id} is registered twice`);
      all[id] = handler;
    }
  }
  return all;
}

/** Registers the commands, each wrapped (e.g. to report its errors), disposed with the extension. */
export function registerAll(subscriptions: { dispose(): unknown }[], commands: Commands, wrap: (handler: Handler) => Handler = (h) => h): void {
  for (const [id, handler] of Object.entries(commands)) subscriptions.push(vscode.commands.registerCommand(id, wrap(handler)));
}

/** A command's failure, said to the user. */
export function showError(e: unknown): void {
  void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
}

import type { Target, WebviewMessage } from '../protocol';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();

export function send(message: WebviewMessage): void {
  vscode.postMessage(message);
}

/** Runs a `flotilla.*` command in the extension with the target as its argument. */
export function run(command: string, target?: Target): void {
  send({ type: 'command', command, target });
}

/** The `data-vscode-context` attribute VS Code reads for native context menus; the object is also passed to the command. */
export function menuContext(section: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ webviewSection: section, preventDefaultContextMenuItems: true, ...fields });
}

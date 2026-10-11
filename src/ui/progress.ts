import * as vscode from 'vscode';
import type { Tool } from '../webview/protocol';

/**
 * What's in progress, per sidebar tool (a commit or a pull for Version Control, a review agent for the Backlog), so
 * the tool strip can show it on the tools' icons.
 */
const running = new Map<number, { tool: Tool; title: string }>();
let next = 1;
const changed = new vscode.EventEmitter<void>();
export const onDidChangeProgress = changed.event;

/** The titles of what's in progress, per tool. */
export function progressByTool(): Partial<Record<Tool, string[]>> {
  const out: Partial<Record<Tool, string[]>> = {};
  for (const { tool, title } of running.values()) (out[tool] ??= []).push(title);
  return out;
}

/** Marks something in progress for a tool until it settles. */
export async function trackProgress<T>(tool: Tool, title: string, task: () => PromiseLike<T>): Promise<T> {
  const id = next++;
  running.set(id, { tool, title });
  changed.fire();
  try {
    return await task();
  } finally {
    running.delete(id);
    changed.fire();
  }
}

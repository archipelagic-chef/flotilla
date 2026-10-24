import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FileChange } from '../git/porcelain';
import { toWorkspaceUri } from '../uris';
import { makeGitUri } from './gitContentProvider';
import { sideRefsFor, WORKING, type DiffSide } from './refs';

export async function openChangeDiff(
  reference: vscode.Uri,
  worktreeDir: string,
  change: FileChange,
  leftRef: string,
  rightRef: string,
  label: string,
): Promise<void> {
  const { left, right } = sideRefsFor(change, leftRef, rightRef);
  const toUri = (side: DiffSide) =>
    side.ref === WORKING ? toWorkspaceUri(reference, path.join(worktreeDir, side.path)) : makeGitUri({ worktree: worktreeDir, ref: side.ref, path: side.path });
  await vscode.commands.executeCommand('vscode.diff', toUri(left), toUri(right), `${path.posix.basename(change.path)} (${label})`);
}

/** Opens VS Code's multi-file diff editor on the changes (one entry per file). */
export async function openChangesEditor(
  reference: vscode.Uri,
  worktreeDir: string,
  changes: readonly FileChange[],
  leftRef: string,
  rightRef: string,
  title: string,
): Promise<void> {
  const toUri = (side: DiffSide) =>
    side.ref === WORKING ? toWorkspaceUri(reference, path.join(worktreeDir, side.path)) : makeGitUri({ worktree: worktreeDir, ref: side.ref, path: side.path });
  const resources = changes.map((change) => {
    const { left, right } = sideRefsFor(change, leftRef, rightRef);
    return [toWorkspaceUri(reference, path.join(worktreeDir, change.path)), toUri(left), toUri(right)];
  });
  await vscode.commands.executeCommand('vscode.changes', title, resources);
}

/** Opens the multi-file diff editor on changes from several comparisons: each file with its own folder and sides. */
export async function openChangeEntries(
  reference: vscode.Uri,
  entries: ReadonlyArray<{ worktreeDir: string; change: FileChange; leftRef: string; rightRef: string }>,
  title: string,
): Promise<void> {
  const resources = entries.map(({ worktreeDir, change, leftRef, rightRef }) => {
    const toUri = (side: DiffSide) =>
      side.ref === WORKING ? toWorkspaceUri(reference, path.join(worktreeDir, side.path)) : makeGitUri({ worktree: worktreeDir, ref: side.ref, path: side.path });
    const { left, right } = sideRefsFor(change, leftRef, rightRef);
    return [toWorkspaceUri(reference, path.join(worktreeDir, change.path)), toUri(left), toUri(right)];
  });
  await vscode.commands.executeCommand('vscode.changes', title, resources);
}

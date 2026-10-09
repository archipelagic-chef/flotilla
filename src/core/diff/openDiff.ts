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

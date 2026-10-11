import * as vscode from 'vscode';
import { openChangeDiff, openChangesEditor } from '../core/diff/openDiff';
import { runGit } from '../core/git/gitCli';
import { commitChanges } from '../features/history/log';

/** Opens what a commit changed (against its first parent): all its files, or the one at path. */
export async function openCommit(reference: vscode.Uri, cwd: string, hash: string, path?: string): Promise<void> {
  if (!/^[0-9a-f]{4,64}$/.test(hash)) return;
  const { changes, parent } = await commitChanges(cwd, hash);
  const subject = (await runGit(['log', '-n', '1', '--format=%h %s', hash, '--'], { cwd })).trim();
  if (path !== undefined) {
    const change = changes.find((c) => c.path === path);
    if (change) await openChangeDiff(reference, cwd, change, parent, hash, subject);
    return;
  }
  if (!changes.length) {
    void vscode.window.showInformationMessage(`${subject} changes no files.`);
    return;
  }
  await openChangesEditor(reference, cwd, changes, parent, hash, subject);
}

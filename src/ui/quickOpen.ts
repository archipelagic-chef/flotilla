import * as path from 'node:path';
import * as vscode from 'vscode';
import { runGit } from '../core/git/gitCli';
import { isInside, samePath, toGitPath } from '../core/paths';
import { toWorkspaceUri } from '../core/uris';
import type { Workstream } from '../features/workstreams/workstream';
import { workstreamLabel } from './format';

/** Tracked and untracked (not ignored) files of a worktree; other worktrees in `.worktrees/` are ignored there. */
export async function worktreeFiles(dir: string): Promise<string[]> {
  const out = await runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: dir, timeoutMs: 60_000 });
  return [...new Set(out.split('\0').filter(Boolean))];
}

type Item = vscode.QuickPickItem & { rel?: string };

/** Ctrl+P for the active worktree: its files, with the ones open in editors first. */
export async function quickOpenInWorktree(ws: Workstream, reference: vscode.Uri): Promise<void> {
  const root = ws.worktree.path;
  if (!root) return;
  const picker = vscode.window.createQuickPick<Item>();
  picker.title = `Go to File in ${workstreamLabel(ws)}`;
  picker.placeholder = 'Search files by name';
  picker.matchOnDescription = true;
  picker.busy = true;
  picker.show();

  const toItem = (rel: string): Item => {
    const dir = path.posix.dirname(rel);
    return { label: path.posix.basename(rel), description: dir === '.' ? '' : dir, rel, iconPath: vscode.ThemeIcon.File };
  };
  const files = await worktreeFiles(root).catch(() => [] as string[]);
  const open = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .map((t) => (t.input instanceof vscode.TabInputText ? t.input.uri : undefined))
    .filter((u): u is vscode.Uri => u !== undefined && (samePath(path.dirname(u.fsPath), root) || isInside(root, u.fsPath)))
    .map((u) => toGitPath(path.relative(root, u.fsPath)));
  const recent = [...new Set(open)];
  const recentSet = new Set(recent);
  picker.items = [
    ...(recent.length ? [{ label: 'open editors', kind: vscode.QuickPickItemKind.Separator } as Item, ...recent.map(toItem)] : []),
    ...(recent.length ? [{ label: 'files', kind: vscode.QuickPickItemKind.Separator } as Item] : []),
    ...files.filter((f) => !recentSet.has(f)).map(toItem),
  ];
  picker.busy = false;

  const picked = await new Promise<Item | undefined>((resolve) => {
    picker.onDidAccept(() => resolve(picker.selectedItems[0]));
    picker.onDidHide(() => resolve(undefined));
  });
  picker.dispose();
  if (!picked?.rel) return;
  await vscode.window.showTextDocument(toWorkspaceUri(reference, path.join(root, picked.rel)), { preview: true });
}

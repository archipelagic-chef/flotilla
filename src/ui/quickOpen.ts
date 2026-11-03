import * as path from 'node:path';
import * as vscode from 'vscode';
import { runGit } from '../core/git/gitCli';
import {
  isInside,
  samePath,
  toGitPath,
} from '../core/paths';
import { toWorkspaceUri } from '../core/uris';
import type { Workstream } from '../features/workstreams/workstream';
import { workstreamLabel } from './format';

/** Tracked and untracked (not ignored) files of a worktree; other worktrees in `.worktrees/` are ignored there. */
export async function worktreeFiles(dir: string): Promise<string[]> {
  const out = await runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: dir, timeoutMs: 60_000 });
  return [...new Set(out.split('\0').filter(Boolean))];
}

/**
 * The open editors' files that belong to the worktree at `root`, relative to it: those inside it, but not inside
 * another worktree in its folder (main's `.worktrees/*`), whose files are that worktree's own (BL-277).
 */
export function worktreeOpenFiles(root: string, open: readonly string[], worktrees: readonly string[]): string[] {
  const nested = worktrees.filter((w) => isInside(root, w));
  const own = open.filter((f) => (samePath(path.dirname(f), root) || isInside(root, f)) && !nested.some((w) => samePath(w, f) || isInside(w, f)));
  return [...new Set(own.map((f) => toGitPath(path.relative(root, f))))];
}

type Item = vscode.QuickPickItem & { rel?: string };

/** Ctrl+P for the active worktree: its files, with the ones open in editors first; `worktrees` are all the repository's. */
export async function quickOpenInWorktree(ws: Workstream, reference: vscode.Uri, worktrees: readonly string[] = []): Promise<void> {
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
    .filter((u): u is vscode.Uri => u !== undefined)
    .map((u) => u.fsPath);
  const recent = worktreeOpenFiles(root, open, worktrees);
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

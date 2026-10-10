import * as path from 'node:path';
import * as vscode from 'vscode';
import { toGitPath } from '../../core/paths';
import { toWorkspaceUri } from '../../core/uris';
import type { Workstream } from '../../features/workstreams/workstream';
import type { HostMessage, Target } from '../../webview/protocol';
import { workstreamLabel } from '../format';
import { copyName, isSelfOrInside, nameProblem } from './fileNames';

export interface FileOpsDeps {
  reference: vscode.Uri;
  find(key: string): Workstream | undefined;
  post(message: HostMessage): void;
  /** Tells the webview to re-list these folders (the file watcher may lag or miss worktrees outside the window's folder). */
  dirsChanged(key: string, dirs: string[]): void;
}

interface Item {
  key: string;
  path: string;
}

const posixDir = (rel: string) => (path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel));

/** New file/folder, rename, delete, move, copy/cut/paste in the sidebar's Files tab. */
export class FileOps {
  private clipboard: { mode: 'copy' | 'cut'; items: Item[] } | undefined;

  constructor(private readonly deps: FileOpsDeps) {}

  private root(key: string): string {
    const ws = this.deps.find(key);
    if (!ws?.worktree.path) throw new Error('That worktree is not reachable from this environment.');
    return ws.worktree.path;
  }

  private uri(key: string, rel: string): vscode.Uri {
    return toWorkspaceUri(this.deps.reference, path.join(this.root(key), rel));
  }

  private async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  /** The folder a "New File…" on target goes into: the folder itself, a file's folder, or the worktree root. */
  static dirOf(target: Target): string {
    if (!target.path) return '';
    return target.isDir ? target.path : posixDir(target.path);
  }

  startCreate(target: Target, kind: 'file' | 'folder'): void {
    this.deps.post({ type: 'edit', key: target.key, kind, dir: FileOps.dirOf(target) });
  }

  startRename(target: Target): void {
    if (target.path) this.deps.post({ type: 'edit', key: target.key, kind: 'rename', path: target.path });
  }

  /** Creates from the inline box; returns the problem to show there, or undefined on success. */
  async create(key: string, kind: 'file' | 'folder', dir: string, name: string): Promise<string | undefined> {
    const problem = nameProblem(name);
    if (problem) return problem;
    const rel = toGitPath(path.posix.join(dir, name.trim().replace(/\\/g, '/')));
    const uri = this.uri(key, rel);
    if (await this.exists(uri)) return `A file or folder **${name.trim()}** already exists at this location.`;
    if (kind === 'folder') {
      await vscode.workspace.fs.createDirectory(uri);
    } else {
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(uri, { ignoreIfExists: false });
      if (!(await vscode.workspace.applyEdit(edit))) return `Could not create ${rel}.`;
    }
    this.deps.dirsChanged(key, [dir, posixDir(rel)]);
    if (kind === 'file') await vscode.window.showTextDocument(uri, { preview: false });
    return undefined;
  }

  async rename(key: string, rel: string, name: string): Promise<string | undefined> {
    const problem = nameProblem(name);
    if (problem) return problem;
    const target = toGitPath(path.posix.join(posixDir(rel), name.trim().replace(/\\/g, '/')));
    if (target === rel) return undefined;
    const from = this.uri(key, rel);
    const to = this.uri(key, target);
    // A case-only rename is allowed on case-insensitive file systems.
    if (target.toLowerCase() !== rel.toLowerCase() && (await this.exists(to))) {
      return `A file or folder **${name.trim()}** already exists at this location.`;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(from, to, { overwrite: false });
    if (!(await vscode.workspace.applyEdit(edit))) return `Could not rename ${rel}.`;
    this.deps.dirsChanged(key, [posixDir(rel), posixDir(target)]);
    return undefined;
  }

  async delete(items: Item[]): Promise<void> {
    if (!items.length) return;
    const what = items.length === 1 ? `'${path.posix.basename(items[0].path)}'` : `the ${items.length} selected files and folders`;
    const choice = await vscode.window.showWarningMessage(
      `Are you sure you want to delete ${what}?`,
      { modal: true, detail: 'You can restore it from the Trash.' },
      'Move to Trash',
    );
    if (!choice) return;
    for (const item of items) {
      const uri = this.uri(item.key, item.path);
      try {
        await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
      } catch (error) {
        // Remote file systems (e.g. a devcontainer) often have no trash.
        const permanent = await vscode.window.showWarningMessage(
          `'${path.posix.basename(item.path)}' could not be moved to the Trash. Delete it permanently?`,
          { modal: true, detail: error instanceof Error ? error.message : String(error) },
          'Delete Permanently',
        );
        if (!permanent) return;
        await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
      }
      this.deps.dirsChanged(item.key, [posixDir(item.path)]);
    }
  }

  /** Drag and drop: moves a file or folder into a folder of the same or another worktree. */
  async move(from: Item, to: { key: string; dir: string }): Promise<void> {
    const name = path.posix.basename(from.path);
    const target = toGitPath(path.posix.join(to.dir, name));
    if (from.key === to.key && (target === from.path || posixDir(from.path) === to.dir)) return;
    const source = this.uri(from.key, from.path);
    const destination = this.uri(to.key, target);
    if (from.key === to.key && isSelfOrInside(from.path, to.dir || '.')) {
      void vscode.window.showWarningMessage(`Can't move '${name}' into itself.`);
      return;
    }
    if (vscode.workspace.getConfiguration('explorer').get<boolean>('confirmDragAndDrop', true)) {
      const into = to.dir ? `'${path.posix.basename(to.dir)}'` : 'the top folder';
      const other = from.key === to.key ? '' : ` of '${workstreamLabel(this.deps.find(to.key)!)}'`;
      const choice = await vscode.window.showWarningMessage(`Are you sure you want to move '${name}' into ${into}${other}?`, { modal: true }, 'Move');
      if (!choice) return;
    }
    if (await this.exists(destination)) {
      void vscode.window.showWarningMessage(`A file or folder '${name}' already exists in the destination folder.`);
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(source, destination, { overwrite: false });
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`Could not move ${from.path}.`);
    this.deps.dirsChanged(from.key, [posixDir(from.path)]);
    this.deps.dirsChanged(to.key, [to.dir]);
  }

  setClipboard(mode: 'copy' | 'cut', items: Item[]): void {
    this.clipboard = items.length ? { mode, items } : undefined;
    void vscode.commands.executeCommand('setContext', 'flotilla.canPaste', this.clipboard !== undefined);
  }

  /** Pastes into dir of the worktree: copies get "copy" names when taken; cut items are moved (once). */
  async paste(key: string, dir: string): Promise<void> {
    const clip = this.clipboard;
    if (!clip) return;
    const names = new Set((await vscode.workspace.fs.readDirectory(this.uri(key, dir))).map(([n]) => n));
    for (const item of clip.items) {
      const base = path.posix.basename(item.path);
      if (item.key === key && isSelfOrInside(item.path, dir || '.') && clip.mode === 'cut') continue;
      const name = clip.mode === 'copy' ? copyName(base, names) : base;
      if (clip.mode === 'cut' && names.has(name)) {
        void vscode.window.showWarningMessage(`A file or folder '${name}' already exists in the destination folder.`);
        continue;
      }
      names.add(name);
      const destination = this.uri(key, path.posix.join(dir, name));
      if (clip.mode === 'copy') {
        await vscode.workspace.fs.copy(this.uri(item.key, item.path), destination, { overwrite: false });
      } else {
        const edit = new vscode.WorkspaceEdit();
        edit.renameFile(this.uri(item.key, item.path), destination, { overwrite: false });
        await vscode.workspace.applyEdit(edit);
        this.deps.dirsChanged(item.key, [posixDir(item.path)]);
      }
    }
    if (clip.mode === 'cut') this.setClipboard('cut', []);
    this.deps.dirsChanged(key, [dir]);
  }
}

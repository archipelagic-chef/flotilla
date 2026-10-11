import * as path from 'node:path';
import * as vscode from 'vscode';
import { readFileBytesAtRef } from './refs';

export const GIT_SCHEME = 'flotilla-git';

export interface GitUriParams {
  worktree: string;
  ref: string;
  path: string;
}

/** A file at a ref. Its path is the file's own (so editors show where it is); the query says which version. */
export function makeGitUri(p: GitUriParams): vscode.Uri {
  return vscode.Uri.file(path.join(p.worktree, p.path)).with({ scheme: GIT_SCHEME, query: JSON.stringify(p) });
}

export function parseGitUri(uri: vscode.Uri): GitUriParams {
  return JSON.parse(uri.query) as GitUriParams;
}

/**
 * Serves files at a ref, read-only. A file system rather than a text content provider, so that editors that read
 * bytes (VS Code's image preview, the hex editor) can open them too.
 */
export class GitFileSystemProvider implements vscode.FileSystemProvider {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;
  /** stat and readFile come in pairs: the bytes read for one serve the other. */
  private readonly recent = new Map<string, Promise<Uint8Array>>();

  private read(uri: vscode.Uri): Promise<Uint8Array> {
    const key = uri.toString();
    let bytes = this.recent.get(key);
    if (!bytes) {
      const p = parseGitUri(uri);
      bytes = readFileBytesAtRef(p.worktree, p.ref, p.path);
      this.recent.set(key, bytes);
      setTimeout(() => this.recent.delete(key), 5000);
    }
    return bytes;
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const bytes = await this.read(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: bytes.byteLength, permissions: vscode.FilePermission.Readonly };
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.read(uri);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  readDirectory(): never {
    throw vscode.FileSystemError.FileNotADirectory();
  }

  createDirectory(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  writeFile(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
}

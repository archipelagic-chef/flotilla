import * as vscode from 'vscode';
import { readFileAtRef } from './refs';

export const GIT_SCHEME = 'switchyard-git';

export interface GitUriParams {
  worktree: string;
  ref: string;
  path: string;
}

export function makeGitUri(p: GitUriParams): vscode.Uri {
  return vscode.Uri.from({ scheme: GIT_SCHEME, path: `/${p.path}`, query: JSON.stringify(p) });
}

export function parseGitUri(uri: vscode.Uri): GitUriParams {
  return JSON.parse(uri.query) as GitUriParams;
}

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const p = parseGitUri(uri);
    return readFileAtRef(p.worktree, p.ref, p.path);
  }
}

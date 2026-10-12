import * as vscode from 'vscode';
import { fakeApiOrigin } from '../../features/ci/githubActions';

/**
 * The fake GitHub's address (flotilla.dev.githubApi, npm run fake-github), for trying the CI/CD view offline. It's read
 * only in the Extension Development Host, and only for a loopback address: a released build always asks GitHub.
 */
export function devGitHubApi(mode: vscode.ExtensionMode): string | undefined {
  if (mode !== vscode.ExtensionMode.Development) return undefined;
  return fakeApiOrigin(vscode.workspace.getConfiguration('flotilla').get<string>('dev.githubApi', ''));
}

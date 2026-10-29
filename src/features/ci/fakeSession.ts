import * as vscode from 'vscode';

/**
 * The fake GitHub's sign-in (BL-245): signed in, unless flotilla.dev.githubSignedOut starts it signed out, so that the
 * GitHub sign-in prompts can be tried and demoed. Sign In signs it in and fires onDidChange, as a real sign-in fires
 * vscode.authentication.onDidChangeSessions. It's kept for the window: a reload starts it from the setting again.
 */
export class FakeGitHubSession {
  private out: boolean | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  get signedIn(): boolean {
    this.out ??= vscode.workspace.getConfiguration('flotilla').get<boolean>('dev.githubSignedOut', false);
    return !this.out;
  }

  signIn(): void {
    if (this.signedIn) return;
    this.out = false;
    this.changed.fire();
  }
}

export const fakeGitHubSession = new FakeGitHubSession();

import * as vscode from 'vscode';
import { gitHubName } from '../backlog/sources/github';
import type { Fetch } from '../backlog/sources/source';
import { cleanLog, GitHubActions } from './githubActions';

export const JOB_LOG_SCHEME = 'flotilla-ci-log';

const GITHUB_SCOPES = ['repo'];

export interface JobLogRef {
  owner: string;
  repo: string;
  jobId: number;
  /** For the document's name only. */
  jobName: string;
}

/** A job's ref as it comes in (from a URI, or from the webview): a repository and a job id, checked before they go in a URL. */
export function checkJobLogRef(value: unknown): JobLogRef {
  const v = (value ?? {}) as Partial<Record<keyof JobLogRef, unknown>>;
  if (typeof v.owner !== 'string' || !gitHubName(v.owner) || typeof v.repo !== 'string' || !gitHubName(v.repo)) {
    throw new Error('Not a GitHub repository.');
  }
  if (typeof v.jobId !== 'number' || !Number.isSafeInteger(v.jobId) || v.jobId <= 0) throw new Error(`Not a GitHub Actions job id: ${String(v.jobId)}.`);
  return { owner: v.owner, repo: v.repo, jobId: v.jobId, jobName: typeof v.jobName === 'string' ? v.jobName : '' };
}

/** A job's log, as a read-only document. Its path is readable (the job's name); its query says which job. */
export function makeJobLogUri(ref: JobLogRef): vscode.Uri {
  const name =
    ref.jobName
      .replace(/[^\w .()-]+/g, '-')
      .trim()
      .slice(0, 80) || `job-${ref.jobId}`;
  return vscode.Uri.from({ scheme: JOB_LOG_SCHEME, path: `/${name}.log`, query: JSON.stringify(checkJobLogRef(ref)) });
}

export function parseJobLogUri(uri: Pick<vscode.Uri, 'query'>): JobLogRef {
  return checkJobLogRef(JSON.parse(uri.query));
}

/** The line of the first error in a cleaned log (cleanLog writes errors as "ERROR: "), or -1. */
export function firstErrorLine(text: string): number {
  return text.split('\n').findIndex((l) => l.startsWith('ERROR: '));
}

/** Serves the logs of jobs, cleaned. A text provider, so the document can't be saved to disk. */
export class JobLogProvider implements vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly actions: (owner: string, repo: string) => GitHubActions) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const ref = parseJobLogUri(uri);
    return cleanLog(await this.actions(ref.owner, ref.repo).log(ref.jobId));
  }

  /** Read the log again (a running job's log grows). */
  refresh(uri: vscode.Uri): void {
    this.changed.fire(uri);
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/** The GitHub client for a repository, through the user's GitHub sign-in in VS Code. */
export function signedInActions(fetch: Fetch, fakeApi?: string): (owner: string, repo: string) => GitHubActions {
  return (owner, repo) =>
    new GitHubActions(
      owner,
      repo,
      async () => {
        // The fake GitHub (debug window only) needs no sign-in, and never gets a real token.
        if (fakeApi) return 'fake-token';
        const session = await vscode.authentication.getSession('github', GITHUB_SCOPES, { silent: true });
        if (!session) throw new Error('Sign in to GitHub to read the log.');
        return session.accessToken;
      },
      fetch,
      fakeApi,
    );
}

/** Opens a job's log, read-only, with the cursor on its first error. */
export async function showJobLog(arg: unknown, provider: JobLogProvider): Promise<void> {
  let ref: JobLogRef;
  try {
    ref = checkJobLogRef(arg);
  } catch (error) {
    void vscode.window.showErrorMessage(`Can't show the log: ${(error as Error).message}`);
    return;
  }
  const uri = makeJobLogUri(ref);
  provider.refresh(uri);
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    const line = Math.max(firstErrorLine(doc.getText()), 0);
    const at = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(at, at);
    editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.AtTop);
  } catch (error) {
    void vscode.window.showErrorMessage(`Can't read the log: ${(error as Error).message}`);
  }
}

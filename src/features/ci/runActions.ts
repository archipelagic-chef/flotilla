import { fetchJson, type Fetch } from '../backlog/sources/source';

/** What the CI/CD view can do to a run. */
export type RunAction = 'rerun' | 'rerunFailed' | 'cancel';

/** Which actions a run offers: re-runs once it has finished, cancel while it's queued or running. */
export function runActions(run: { active: boolean; failed: boolean }): RunAction[] {
  if (run.active) return ['cancel'];
  return run.failed ? ['rerun', 'rerunFailed'] : ['rerun'];
}

/** A GitHub owner or repository name (no paths into other API routes); as github.ts's gitHubName. */
const gitHubName = (n: string) => /^[A-Za-z0-9_.-]+$/.test(n) && n !== '.' && n !== '..';

/** A run's id, as the view sends it: a positive whole number, nothing else in a URL. */
function runId(n: number): number {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Not a GitHub Actions run id: ${n}.`);
  return n;
}

/** GitHub's answer to a run action that didn't work, as the message the user sees (what to do next). */
export function explainRunError(action: RunAction, status: number, detail: string, repo: string): string {
  const name = action === 'cancel' ? 'cancel' : 're-run';
  switch (status) {
    case 401:
      return `GitHub doesn't accept the sign-in any more. Sign in to GitHub again and retry the ${name}.`;
    case 403:
      if (/old|days|expired|deleted|not allowed/i.test(detail)) {
        return `GitHub won't ${name} this run: it's too old, or its logs were deleted. Start a new run instead: push a commit, or run the workflow by hand.`;
      }
      return `Flotilla's GitHub sign-in may not ${name} workflow runs in ${repo}. Check that you have write access to the repository and that the sign-in has the repo scope, then retry.`;
    case 404:
      return `GitHub doesn't find this run in ${repo}: it may have been deleted, or the sign-in has no access to the repository.`;
    case 409:
      return action === 'cancel'
        ? `This run has already finished, so there's nothing to cancel. Refresh the view to see its result.`
        : `GitHub can't ${name} this run yet: it's still running. Wait until it finishes, then retry.`;
    case 422:
      return `GitHub can't re-run the failed jobs: no job in this run failed. Use Re-run to run it all again.`;
    default:
      return `GitHub didn't ${name} the run (${status}${detail ? `: ${detail}` : ''}). Try again in a moment.`;
  }
}

/** A run's re-run and cancel, through the user's GitHub sign-in in VS Code. */
export class RunControls {
  constructor(
    readonly owner: string,
    readonly repo: string,
    private readonly token: () => Promise<string>,
    private readonly fetch: Fetch,
  ) {
    if (!gitHubName(owner) || !gitHubName(repo)) throw new Error(`Not a GitHub repository: ${owner}/${repo}.`);
  }

  /** Re-runs a run's jobs, or only its failed ones. */
  async rerun(run: number, failedOnly: boolean): Promise<void> {
    await this.post(failedOnly ? 'rerunFailed' : 'rerun', `runs/${runId(run)}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`);
  }

  /** Cancels a queued or running run. */
  async cancel(run: number): Promise<void> {
    await this.post('cancel', `runs/${runId(run)}/cancel`);
  }

  private async post(action: RunAction, path: string): Promise<void> {
    const url = `https://api.github.com/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/actions/${path}`;
    const headers = { Authorization: `Bearer ${await this.token()}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    try {
      await fetchJson(this.fetch, url, { method: 'POST', headers });
    } catch (error) {
      // fetchJson reports a status other than 2xx as "<status> <text>: <detail>".
      const m = /^(\d{3}) [^:]*(?::\s*([\s\S]*))?$/.exec(error instanceof Error ? error.message : '');
      if (!m) throw error;
      throw new Error(explainRunError(action, Number(m[1]), (m[2] ?? '').slice(0, 300), `${this.owner}/${this.repo}`));
    }
  }
}

import { gitHubName } from '../backlog/sources/github';
import { fetchJson, type Fetch } from '../backlog/sources/source';
import { explainRunError, type RunAction } from './runActions';

/** Where a run is: waiting to start, running, or how it ended. */
export type CiStatus = 'queued' | 'running' | 'success' | 'failure' | 'cancelled' | 'skipped' | 'neutral';

export interface CiRun {
  id: number;
  /** The workflow's name ("CI"), and the run's number in it. */
  workflow: string;
  number: number;
  /** What it runs for: the commit's subject, or the pull request's title. */
  title: string;
  /** push, pull_request, workflow_dispatch, schedule, … */
  event: string;
  status: CiStatus;
  url: string;
  sha: string;
  /** Which attempt of the run this is: a re-run makes a new one (2, 3…). */
  attempt: number;
  /** ISO 8601. */
  created: string;
}

interface ApiRun {
  id: number;
  name?: string | null;
  run_number: number;
  display_title?: string;
  head_commit?: { message?: string } | null;
  event: string;
  status: string | null;
  conclusion: string | null;
  html_url: string;
  head_sha: string;
  run_attempt?: number;
  created_at: string;
}

const API = 'https://api.github.com';

/** A run that is still going (queued or running). */
export const isActive = (s: CiStatus) => s === 'queued' || s === 'running';

/** GitHub's status and conclusion as one. */
export function ciStatus(status: string | null | undefined, conclusion: string | null | undefined): CiStatus {
  if (status !== 'completed') return status === 'in_progress' ? 'running' : 'queued';
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'cancelled':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
    case 'neutral':
      return 'neutral';
    // failure, timed_out, action_required, startup_failure, stale
    default:
      return 'failure';
  }
}

/** GitHub Actions of one repository, through the user's GitHub sign-in in VS Code. */
export class GitHubActions {
  constructor(
    readonly owner: string,
    readonly repo: string,
    private readonly token: () => Promise<string>,
    private readonly fetch: Fetch,
  ) {
    if (!gitHubName(owner) || !gitHubName(repo)) throw new Error(`Not a GitHub repository: ${owner}/${repo}.`);
  }

  /** A branch's latest runs, newest first. */
  async runs(branch: string, limit = 10): Promise<CiRun[]> {
    const url = `${API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=${limit}`;
    const headers = { Authorization: `Bearer ${await this.token()}`, 'X-GitHub-Api-Version': '2022-11-28' };
    const data = await fetchJson<{ workflow_runs: ApiRun[] }>(this.fetch, url, { headers });
    return data.workflow_runs.map((r) => ({
      id: r.id,
      workflow: r.name ?? 'Workflow',
      number: r.run_number,
      title: r.display_title ?? r.head_commit?.message?.split('\n')[0] ?? '',
      event: r.event,
      status: ciStatus(r.status, r.conclusion),
      url: r.html_url,
      sha: r.head_sha,
      attempt: r.run_attempt ?? 1,
      created: r.created_at,
    }));
  }

  /** Re-runs a run's jobs, or only its failed ones. */
  async rerun(run: number, failedOnly: boolean): Promise<void> {
    await this.act(failedOnly ? 'rerunFailed' : 'rerun', `runs/${runId(run)}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`);
  }

  /** Cancels a queued or running run. */
  async cancel(run: number): Promise<void> {
    await this.act('cancel', `runs/${runId(run)}/cancel`);
  }

  private async act(action: RunAction, path: string): Promise<void> {
    const url = `${API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/actions/${path}`;
    const headers = { Authorization: `Bearer ${await this.token()}`, 'X-GitHub-Api-Version': '2022-11-28' };
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

/** A run's id, as the view sends it: a positive whole number, nothing else in a URL. */
function runId(n: number): number {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Not a GitHub Actions run id: ${n}.`);
  return n;
}

/** A remote branch, as git names its upstream ("origin/feat/x"), split by the remotes there are. */
export function splitUpstream(upstream: string, remotes: readonly string[]): { remote: string; branch: string } | undefined {
  // The longest remote that fits: "origin/x" isn't remote "origin/x"'s branch.
  const remote = [...remotes].sort((a, b) => b.length - a.length).find((r) => upstream.startsWith(`${r}/`));
  return remote ? { remote, branch: upstream.slice(remote.length + 1) } : undefined;
}

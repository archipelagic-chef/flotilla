import { gitHubName } from '../backlog/sources/github';
import { fetchJson, fetchText, TIMEOUT_MS, type Fetch } from '../backlog/sources/source';

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
  /** ISO 8601. */
  created: string;
}

export interface CiStep {
  number: number;
  name: string;
  status: CiStatus;
}

export interface CiJob {
  id: number;
  name: string;
  status: CiStatus;
  url: string;
  /** ISO 8601. */
  started?: string;
  completed?: string;
  steps: CiStep[];
}

interface ApiJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  steps?: Array<{ number: number; name: string; status: string; conclusion: string | null }>;
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
  created_at: string;
}

const API = 'https://api.github.com';

/** Pages of jobs read at most: 100 each, where a run has a few hundred at the most. Past that, the view says how many were left out. */
const MAX_JOB_PAGES = 20;

/** A run's or job's id, as the webview sends it: a positive whole number, nothing else in a URL. */
function id(n: number): number {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Not a GitHub Actions id: ${n}.`);
  return n;
}

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
      created: r.created_at,
    }));
  }

  /** A run's jobs (of its latest attempt), with their steps: every page of them, not only the first. */
  async jobs(runId: number): Promise<CiJob[]> {
    const found: ApiJob[] = [];
    let total = 0;
    let next: string | undefined = `${this.base}/runs/${id(runId)}/jobs?per_page=100`;
    for (let pages = 0; next !== undefined; pages++) {
      if (pages === MAX_JOB_PAGES) throw new Error(`Read ${found.length} of ${total} jobs; the rest weren't read.`);
      const page: { body: { total_count?: number; jobs: ApiJob[] }; next?: string } = await this.page(next);
      found.push(...page.body.jobs);
      total = page.body.total_count ?? total;
      next = page.next;
    }
    return found.map((j) => ({
      id: j.id,
      name: j.name,
      status: ciStatus(j.status, j.conclusion),
      url: j.html_url ?? '',
      ...(j.started_at ? { started: j.started_at } : {}),
      ...(j.completed_at ? { completed: j.completed_at } : {}),
      steps: (j.steps ?? []).map((st) => ({ number: st.number, name: st.name, status: ciStatus(st.status, st.conclusion) })),
    }));
  }

  /** A job's log, as GitHub keeps it (a line per output line, each with its time). */
  async log(jobId: number): Promise<string> {
    const location = await this.logLocation(`${this.base}/jobs/${id(jobId)}/logs`);
    // The storage is on another host, and it gets no token.
    return fetchText(this.fetch, location, { headers: {} });
  }

  /** One page of the API, and the address of the next one (from its Link header). The token only goes to api.github.com. */
  private async page<T>(url: string): Promise<{ body: T; next?: string }> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetch(url, { headers: { Accept: 'application/json', ...(await this.headers()) }, signal: abort.signal });
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
      }
      const next = /<([^>]+)>\s*;\s*rel="next"/.exec(res.headers?.get('link') ?? '')?.[1];
      if (next !== undefined && !next.startsWith(`${API}/`)) throw new Error(`GitHub's next page isn't on api.github.com.`);
      return { body: (await res.json()) as T, next };
    } catch (error) {
      if (abort.signal.aborted) throw new Error(`api.github.com didn't answer within ${TIMEOUT_MS / 1000} seconds.`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Where GitHub keeps a job's log: its redirect, read here (not followed) so that the token stays with GitHub. */
  private async logLocation(url: string): Promise<string> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetch(url, { headers: await this.headers(), redirect: 'manual', signal: abort.signal });
      const location = res.headers?.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        const target = new URL(location, url);
        if (target.protocol !== 'https:') throw new Error(`The log is kept at ${target.protocol}//${target.host}, not over https.`);
        return target.href;
      }
      if (res.ok) throw new Error("GitHub didn't send the log's location.");
      throw new Error(`${res.status} ${res.statusText}`.trim());
    } catch (error) {
      if (abort.signal.aborted) throw new Error(`api.github.com didn't answer within ${TIMEOUT_MS / 1000} seconds.`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.token()}`, 'X-GitHub-Api-Version': '2022-11-28' };
  }

  private get base(): string {
    return `${API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/actions`;
  }
}

/** A job's log made readable: without each line's time, colors, or GitHub's ##[group] markers. */
export function cleanLog(log: string): string {
  return log
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z ?/, '')
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
        .replace(/^##\[(group|endgroup)\]/, (_, g: string) => (g === 'group' ? '▸ ' : ''))
        .replace(/^##\[(error|warning|notice)\]/, (_, k: string) => `${k.toUpperCase()}: `),
    )
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n');
}

/** A remote branch, as git names its upstream ("origin/feat/x"), split by the remotes there are. */
export function splitUpstream(upstream: string, remotes: readonly string[]): { remote: string; branch: string } | undefined {
  // The longest remote that fits: "origin/x" isn't remote "origin/x"'s branch.
  const remote = [...remotes].sort((a, b) => b.length - a.length).find((r) => upstream.startsWith(`${r}/`));
  return remote ? { remote, branch: upstream.slice(remote.length + 1) } : undefined;
}

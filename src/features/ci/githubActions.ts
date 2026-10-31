import { gitHubName } from '../backlog/sources/github';
import {
  type Fetch,
  fetchJson,
  fetchText,
  TIMEOUT_MS,
} from '../backlog/sources/source';
import {
  explainRunError,
  type RunAction,
} from './runActions';

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
  /** When its latest attempt started, and when GitHub last changed it (its end, once it's finished): ISO 8601. */
  started?: string;
  updated?: string;
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
  run_attempt?: number;
  created_at: string;
  run_started_at?: string | null;
  updated_at?: string | null;
}

const API = 'https://api.github.com';

/** Pages of jobs read at most: 100 each, where a run has a few hundred at the most. Past that, the view says how many were left out. */
const MAX_JOB_PAGES = 20;

/** A run's or job's id, as the webview sends it: a positive whole number, nothing else in a URL. */
function id(n: number): number {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Not a GitHub Actions id: ${n}.`);
  return n;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The origin of the fake GitHub's API (npm run fake-github), if the address is one: plain http on this machine. Anything
 * else is not a fake, so a token is never sent to it.
 */
export function fakeApiOrigin(address: string): string | undefined {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return undefined;
  }
  return url.protocol === 'http:' && LOOPBACK.has(url.hostname) ? url.origin : undefined;
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
    /** The API's address: GitHub's, or the fake one (flotilla.dev.githubApi) in the debug window. */
    private readonly api = API,
  ) {
    if (!gitHubName(owner) || !gitHubName(repo)) throw new Error(`Not a GitHub repository: ${owner}/${repo}.`);
  }

  /** A branch's latest runs, newest first. */
  async runs(branch: string, limit = 10): Promise<CiRun[]> {
    const url = `${this.api}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=${limit}`;
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
      ...(r.run_started_at ? { started: r.run_started_at } : {}),
      ...(r.updated_at ? { updated: r.updated_at } : {}),
    }));
  }

  /** The repository's active workflows. */
  async workflows(): Promise<CiWorkflow[]> {
    const url = `${this.base}/workflows?per_page=100`;
    const data = await fetchJson<{ workflows: Array<CiWorkflow & { state: string }> }>(this.fetch, url, { headers: await this.headers() });
    return data.workflows.filter((w) => w.state === 'active').map((w) => ({ id: w.id, name: w.name, path: w.path }));
  }

  /** The full SHA of a branch's head on GitHub: the commit a run of the branch uses (not this clone's copy of it). */
  async branchHead(branch: string): Promise<string> {
    const url = `${this.api}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/branches/${branch.split('/').map(encodeURIComponent).join('/')}`;
    const data = await fetchJson<{ commit: { sha: string } }>(this.fetch, url, { headers: await this.headers() });
    return data.commit.sha;
  }

  /** Starts a workflow that has a workflow_dispatch trigger, on a branch of the repository, with its inputs. */
  async dispatch(workflowId: number, ref: string, inputs: Record<string, string> = {}): Promise<void> {
    if (!Number.isSafeInteger(workflowId) || workflowId <= 0) throw new Error(`Not a GitHub Actions workflow id: ${workflowId}.`);
    const url = `${this.base}/workflows/${workflowId}/dispatches`;
    await fetchJson(this.fetch, url, { method: 'POST', headers: await this.headers(), body: { ref, inputs } });
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

  /** One page of the API, and the address of the next one (from its Link header). The token only goes to this API. */
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
      if (next !== undefined && !next.startsWith(`${this.api}/`)) throw new Error(`GitHub's next page isn't on ${new URL(this.api).host}.`);
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

  /** Re-runs a run's jobs, or only its failed ones. */
  async rerun(run: number, failedOnly: boolean): Promise<void> {
    await this.act(failedOnly ? 'rerunFailed' : 'rerun', `runs/${runId(run)}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`);
  }

  /** Cancels a queued or running run. */
  async cancel(run: number): Promise<void> {
    await this.act('cancel', `runs/${runId(run)}/cancel`);
  }

  private async act(action: RunAction, path: string): Promise<void> {
    const url = `${this.api}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/actions/${path}`;
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

  private async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.token()}`, 'X-GitHub-Api-Version': '2022-11-28' };
  }

  private get base(): string {
    return `${this.api}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/actions`;
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

/** A run's id, as the view sends it: a positive whole number, nothing else in a URL. */
function runId(n: number): number {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Not a GitHub Actions run id: ${n}.`);
  return n;
}

export interface CiWorkflow {
  id: number;
  name: string;
  /** In the repository: .github/workflows/ci.yml. */
  path: string;
}

const indentOf = (l: string) => /^\s*/.exec(l)![0].length;
const isContent = (l: string) => l.trim() !== '' && !l.trim().startsWith('#');

/** The line of the workflow_dispatch trigger in the on: block (at the block's own level), or -1. */
function dispatchLine(lines: readonly string[]): number {
  const at = lines.findIndex((l) => /^on\s*:/.test(l));
  if (at < 0) return -1;
  const block: number[] = [];
  for (let i = at + 1; i < lines.length && !(isContent(lines[i]) && indentOf(lines[i]) === 0); i++) if (isContent(lines[i])) block.push(i);
  if (!block.length) return -1;
  const level = indentOf(lines[block[0]]);
  return block.find((i) => indentOf(lines[i]) === level && /^workflow_dispatch\s*:/.test(lines[i].trim())) ?? -1;
}

/** Whether a workflow file can be run by hand: its on: block has a workflow_dispatch trigger (not one in a job or a comment). */
export function isDispatchable(workflowYaml: string): boolean {
  const lines = workflowYaml.split(/\r?\n/);
  const on = lines.find((l) => /^on\s*:/.test(l));
  // on: [push, workflow_dispatch], written on one line
  if (on !== undefined && /\bworkflow_dispatch\b/.test(on.replace(/\s#.*$/, ''))) return true;
  return dispatchLine(lines) >= 0;
}

export interface DispatchInput {
  name: string;
  description?: string;
  /** string, boolean, choice, number or environment, as the workflow file says (string when it doesn't). */
  type: string;
  required: boolean;
  default?: string;
  /** The choices of a choice input. */
  options?: string[];
}

/** The inputs a workflow asks for when run by hand, with their defaults and whether they're required. */
export function dispatchInputs(workflowYaml: string): DispatchInput[] {
  const lines = workflowYaml.split(/\r?\n/);
  const start = dispatchLine(lines);
  if (start < 0) return [];
  const indent = indentOf;
  const base = indent(lines[start]);
  const inputsAt = lines.findIndex((l, i) => i > start && /^\s*inputs\s*:/.test(l) && indent(l) > base);
  if (inputsAt < 0 || lines.slice(start + 1, inputsAt).some((l) => isContent(l) && indent(l) <= base)) return [];
  const level = indent(lines[inputsAt]);
  const inputs: DispatchInput[] = [];
  let current: DispatchInput | undefined;
  let inputIndent = -1;
  let inOptions = false;
  const value = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, '$2');
  for (const line of lines.slice(inputsAt + 1)) {
    if (!isContent(line)) continue;
    const at = indent(line);
    if (at <= level) break;
    const key = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (inputIndent < 0) inputIndent = at;
    if (at === inputIndent && key) {
      current = { name: key[1], type: 'string', required: false };
      inputs.push(current);
      inOptions = false;
      continue;
    }
    if (!current) continue;
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (item && inOptions) {
      (current.options ??= []).push(value(item[1]));
      continue;
    }
    if (!key) continue;
    inOptions = key[1] === 'options';
    if (key[1] === 'description') current.description = value(key[2]);
    else if (key[1] === 'type') current.type = value(key[2]);
    else if (key[1] === 'required') current.required = value(key[2]) === 'true';
    else if (key[1] === 'default') current.default = value(key[2]);
    else if (key[1] === 'options' && key[2].trim().startsWith('[')) current.options = key[2].trim().slice(1, -1).split(',').map(value).filter(Boolean);
  }
  return inputs;
}

/** A remote branch, as git names its upstream ("origin/feat/x"), split by the remotes there are. */
export function splitUpstream(upstream: string, remotes: readonly string[]): { remote: string; branch: string } | undefined {
  // The longest remote that fits: "origin/x" isn't remote "origin/x"'s branch.
  const remote = [...remotes].sort((a, b) => b.length - a.length).find((r) => upstream.startsWith(`${r}/`));
  return remote ? { remote, branch: upstream.slice(remote.length + 1) } : undefined;
}

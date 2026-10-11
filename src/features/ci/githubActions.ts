import { gitHubName } from '../backlog/sources/github';
import { fetchJson, type Fetch } from '../backlog/sources/source';

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

  /** The repository's active workflows. */
  async workflows(): Promise<CiWorkflow[]> {
    const url = `${API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/actions/workflows?per_page=100`;
    const data = await fetchJson<{ workflows: Array<CiWorkflow & { state: string }> }>(this.fetch, url, { headers: await this.headers() });
    return data.workflows.filter((w) => w.state === 'active').map((w) => ({ id: w.id, name: w.name, path: w.path }));
  }

  /** Starts a workflow that has a workflow_dispatch trigger, on a branch of the repository, with its inputs. */
  async dispatch(workflowId: number, ref: string, inputs: Record<string, string> = {}): Promise<void> {
    if (!Number.isSafeInteger(workflowId) || workflowId <= 0) throw new Error(`Not a GitHub Actions workflow id: ${workflowId}.`);
    const url = `${API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/actions/workflows/${workflowId}/dispatches`;
    await fetchJson(this.fetch, url, { method: 'POST', headers: await this.headers(), body: { ref, inputs } });
  }

  private async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.token()}`, 'X-GitHub-Api-Version': '2022-11-28' };
  }
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

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runGit } from '../../core/git/gitCli';
import { gitHubRepo } from '../../features/backlog/sources/github';
import type { Fetch } from '../../features/backlog/sources/source';
import {
  type CiWorkflow,
  type DispatchInput,
  dispatchInputs,
  GitHubActions,
  isDispatchable,
  splitUpstream,
} from '../../features/ci/githubActions';

const GITHUB_SCOPES = ['repo'];
const FAKE_TOKEN = 'fake-token';
/** The choice that leaves an optional input out, so the workflow's own default applies. */
const WORKFLOW_DEFAULT = '(workflow default)';

/** Where a worktree's branch is on GitHub: the repository and the branch's name there. */
export interface DispatchTarget {
  owner: string;
  repo: string;
  branch: string;
}

/**
 * The GitHub repository and branch the worktree's upstream is. A run uses the branch's head on GitHub, not this
 * worktree's files, so a branch with commits that aren't pushed yet can't be run: push them first.
 */
export async function dispatchTarget(worktree: string): Promise<DispatchTarget> {
  const local = (await runGit(['branch', '--show-current'], { cwd: worktree })).trim();
  if (!local) throw new Error('This worktree has no branch: check out a branch to run its workflows.');
  let upstream = '';
  try {
    upstream = (await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: worktree })).trim();
  } catch {
    // no upstream: not published
  }
  if (!upstream) throw new Error('Publish this branch to run its CI.');
  const unpushed = Number((await runGit(['rev-list', '--count', '@{u}..HEAD'], { cwd: worktree })).trim());
  if (unpushed > 0)
    throw new Error(
      `${unpushed} commit${unpushed === 1 ? '' : 's'} on ${local} ${unpushed === 1 ? "isn't" : "aren't"} pushed: push them first, a run uses what's on GitHub.`,
    );
  const remotes = (await runGit(['remote'], { cwd: worktree })).split(/\r?\n/).filter(Boolean);
  const split = splitUpstream(upstream, remotes);
  if (!split) throw new Error(`${upstream} isn't on a remote of this repository.`);
  const repo = gitHubRepo(await runGit(['remote', 'get-url', split.remote], { cwd: worktree }));
  if (!repo) throw new Error('CI/CD supports GitHub Actions only for now.');
  return { ...repo, branch: split.branch };
}

/**
 * Asks for one input: a quick pick for a choice or a boolean (the default first), an input box otherwise (a required
 * one can't be left empty). '' when an optional input is left out; null when cancelled.
 */
async function askInput(input: DispatchInput): Promise<string | null> {
  const title = `Run Workflow: ${input.name}`;
  if (input.options?.length || input.type === 'boolean') {
    const choices = input.options?.length ? input.options : ['true', 'false'];
    // The default first; an optional choice without one can be left out.
    const leave = input.options?.length && !input.required && input.default === undefined ? [WORKFLOW_DEFAULT] : [];
    const items = [...choices.filter((c) => c === input.default), ...choices.filter((c) => c !== input.default), ...leave];
    const picked = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: input.description ?? (input.required ? 'Required' : 'Optional'),
      ignoreFocusOut: true,
    });
    if (picked === undefined) return null;
    return picked === WORKFLOW_DEFAULT ? '' : picked;
  }
  const typed = await vscode.window.showInputBox({
    title,
    prompt: input.description ?? input.name,
    value: input.default ?? '',
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (input.required && !v.trim()) return 'This input is required.';
      if (input.type === 'number' && v.trim() && !Number.isFinite(Number(v))) return 'Enter a number.';
      return undefined;
    },
  });
  return typed ?? null;
}

/**
 * Asks for each input in turn. Values left empty (not required) are left out, so the workflow's defaults apply.
 * undefined when cancelled.
 */
export async function askInputs(inputs: readonly DispatchInput[]): Promise<Record<string, string> | undefined> {
  const values: Record<string, string> = {};
  for (const input of inputs) {
    const value = await askInput(input);
    if (value === null) return undefined;
    if (value.trim()) values[input.name] = value.trim();
  }
  return values;
}

/** The workflows of the repository that can be started by hand, with their inputs, as this worktree's files say. */
export async function runnableWorkflows(client: GitHubActions, worktree: string): Promise<Array<CiWorkflow & { inputs: DispatchInput[] }>> {
  const found: Array<CiWorkflow & { inputs: DispatchInput[] }> = [];
  for (const w of await client.workflows()) {
    // The file in the worktree: the one the branch has (or the one being written).
    let yaml: string;
    try {
      yaml = await fs.promises.readFile(path.join(worktree, w.path), 'utf8');
    } catch {
      continue;
    }
    if (isDispatchable(yaml)) found.push({ ...w, inputs: dispatchInputs(yaml) });
  }
  return found;
}

/**
 * Run Workflow…: picks a workflow that can be started by hand, asks for its inputs, confirms (a deploy can't be undone)
 * and starts it on the worktree's branch. Resolves true when GitHub took the run, false when the user stopped before.
 */
export async function runWorkflowByHand(worktree: string, api?: string, fetch: Fetch = globalThis.fetch as unknown as Fetch): Promise<boolean> {
  const target = await dispatchTarget(worktree);
  // The fake GitHub (debug window only) takes any token: no sign-in, and nothing real is started.
  const token = api ? FAKE_TOKEN : (await vscode.authentication.getSession('github', GITHUB_SCOPES, { createIfNone: true })).accessToken;
  const client = new GitHubActions(target.owner, target.repo, async () => token, fetch, api);
  // What GitHub has now, not this clone's copy of the branch (which may be behind): that's the commit a run uses.
  const head = (await client.branchHead(target.branch)).slice(0, 7);
  const workflows = await runnableWorkflows(client, worktree);
  if (!workflows.length) {
    void vscode.window.showInformationMessage(`No workflow in ${target.owner}/${target.repo} can be started by hand: none has a workflow_dispatch trigger.`);
    return false;
  }
  const picked = await vscode.window.showQuickPick(
    workflows.map((w) => ({ label: w.name, description: w.path, workflow: w })),
    { title: `Run Workflow on ${target.branch}`, placeHolder: 'Which workflow to start', ignoreFocusOut: true },
  );
  if (!picked) return false;
  const inputs = await askInputs(picked.workflow.inputs);
  if (!inputs) return false;
  const shown = Object.entries(inputs).map(([k, v]) => `${k}: ${v}`);
  const answer = await vscode.window.showWarningMessage(
    `Run "${picked.workflow.name}" on ${target.branch}?`,
    {
      modal: true,
      detail: [
        `${target.owner}/${target.repo}, branch ${target.branch}: it runs commit ${head}, the branch's head on GitHub.`,
        ...(shown.length ? ['', ...shown] : []),
        '',
        "It can't be undone: a deploy that runs can't be taken back.",
      ].join('\n'),
    },
    'Run',
  );
  if (answer !== 'Run') return false;
  await client.dispatch(picked.workflow.id, target.branch, inputs);
  void vscode.window.showInformationMessage(`Started "${picked.workflow.name}" on ${target.branch}. Its run shows in the CI/CD view once GitHub lists it.`);
  return true;
}

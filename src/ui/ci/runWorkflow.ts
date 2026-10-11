import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runGit } from '../../core/git/gitCli';
import { gitHubRepo } from '../../features/backlog/sources/github';
import type { Fetch } from '../../features/backlog/sources/source';
import { GitHubActions, dispatchInputs, isDispatchable, splitUpstream, type CiWorkflow, type DispatchInput } from '../../features/ci/githubActions';

const GITHUB_SCOPES = ['repo'];

/** Where a worktree's branch is on GitHub: the repository, and the branch's name there. */
export interface DispatchTarget {
  owner: string;
  repo: string;
  branch: string;
}

/** The GitHub repository and branch the worktree's upstream is (it has to be pushed to run by hand). */
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
  const remotes = (await runGit(['remote'], { cwd: worktree })).split(/\r?\n/).filter(Boolean);
  const split = splitUpstream(upstream, remotes);
  if (!split) throw new Error(`${upstream} isn't on a remote of this repository.`);
  const repo = gitHubRepo(await runGit(['remote', 'get-url', split.remote], { cwd: worktree }));
  if (!repo) throw new Error('CI/CD supports GitHub Actions only for now.');
  return { ...repo, branch: split.branch };
}

/**
 * Asks for one input: a quick pick for a choice or a boolean (the default first), an input box otherwise (a required
 * one can't be left empty). undefined when cancelled.
 */
async function askInput(input: DispatchInput): Promise<string | undefined> {
  const title = `Run Workflow: ${input.name}`;
  if (input.options?.length || input.type === 'boolean') {
    // The default first.
    const choices = input.options?.length ? input.options : ['true', 'false'];
    const items = [...choices.filter((c) => c === input.default), ...choices.filter((c) => c !== input.default)];
    const picked = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: input.description ?? (input.required ? 'Required' : 'Optional'),
      ignoreFocusOut: true,
    });
    return picked;
  }
  return vscode.window.showInputBox({
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
}

/**
 * Asks for each input in turn. Values left empty (not required) are left out, so the workflow's defaults apply.
 * undefined when cancelled.
 */
export async function askInputs(inputs: readonly DispatchInput[]): Promise<Record<string, string> | undefined> {
  const values: Record<string, string> = {};
  for (const input of inputs) {
    const value = await askInput(input);
    if (value === undefined) return undefined;
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
 * and starts it on the worktree's branch.
 */
export async function runWorkflowByHand(worktree: string, fetch: Fetch = globalThis.fetch as unknown as Fetch): Promise<void> {
  const target = await dispatchTarget(worktree);
  const session = await vscode.authentication.getSession('github', GITHUB_SCOPES, { createIfNone: true });
  const client = new GitHubActions(target.owner, target.repo, async () => session.accessToken, fetch);
  const workflows = await runnableWorkflows(client, worktree);
  if (!workflows.length) {
    void vscode.window.showInformationMessage(`No workflow in ${target.owner}/${target.repo} can be started by hand: none has a workflow_dispatch trigger.`);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    workflows.map((w) => ({ label: w.name, description: w.path, workflow: w })),
    { title: `Run Workflow on ${target.branch}`, placeHolder: 'Which workflow to start', ignoreFocusOut: true },
  );
  if (!picked) return;
  const inputs = await askInputs(picked.workflow.inputs);
  if (!inputs) return;
  const shown = Object.entries(inputs).map(([k, v]) => `${k}: ${v}`);
  const answer = await vscode.window.showWarningMessage(
    `Run "${picked.workflow.name}" on ${target.branch}?`,
    { modal: true, detail: [`${target.owner}/${target.repo}, branch ${target.branch}.`, ...(shown.length ? ['', ...shown] : []), '', "It can't be undone: a deploy that runs can't be taken back."].join('\n') },
    'Run',
  );
  if (answer !== 'Run') return;
  await client.dispatch(picked.workflow.id, target.branch, inputs);
  void vscode.window.showInformationMessage(`Started "${picked.workflow.name}" on ${target.branch}. Its run shows in the CI/CD view once GitHub lists it.`);
}

import * as vscode from 'vscode';
import type { FileChange } from '../core/git/porcelain';
import * as scm from '../features/scm/operations';
import type { Repository } from '../core/repository';
import { withFreshStatus, type Workstream } from '../features/workstreams/workstream';
import { syncKind, workstreamLabel } from './format';

export interface ScmContext {
  /** Updates ws's git status at once (when given), then refreshes everything in the background. */
  refresh(ws?: Workstream): Promise<void>;
  /** Refreshes, then returns the latest snapshot of ws (the tree may show state up to a poll interval old). */
  fresh(ws: Workstream): Promise<Workstream>;
}

export function scmContext(repository: Repository<Workstream>): ScmContext {
  return {
    refresh: async (ws) => {
      if (ws) {
        try {
          const updated = await withFreshStatus(ws);
          repository.patch((items) => items.map((w) => (w.key === updated.key ? updated : w)));
        } catch {
          // the full refresh below shows the state
        }
        void repository.refresh();
        return;
      }
      await repository.refresh();
    },
    fresh: async (ws) => {
      await repository.refresh();
      return repository.current.find((w) => w.key === ws.key) ?? ws;
    },
  };
}

/** Commit messages of failed commits (e.g. a rejected hook), offered again on the next attempt. */
const drafts = new Map<string, string>();

function withProgress<T>(title: string, task: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: { viewId: 'flotilla.sidebar' }, title }, () =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, task),
  );
}

export async function stagePaths(ctx: ScmContext, ws: Workstream, paths: readonly string[]): Promise<void> {
  if (!paths.length) return;
  await scm.stage(ws.worktree.path!, paths);
  await ctx.refresh(ws);
}

/** Unstages the paths; a staged rename unstages both of its sides. */
export async function unstagePaths(ctx: ScmContext, ws: Workstream, paths: readonly string[]): Promise<void> {
  if (!paths.length) return;
  const all = paths.flatMap((p) => {
    const orig = ws.staged.find((c) => c.path === p)?.origPath;
    return orig ? [p, orig] : [p];
  });
  await scm.unstage(ws.worktree.path!, all);
  await ctx.refresh(ws);
}

export async function stageAll(ctx: ScmContext, ws: Workstream): Promise<void> {
  await scm.stageAll(ws.worktree.path!);
  await ctx.refresh(ws);
}

export async function unstageAll(ctx: ScmContext, ws: Workstream): Promise<void> {
  await scm.unstageAll(ws.worktree.path!);
  await ctx.refresh(ws);
}

/** Discards the given unstaged changes, or all of them. Only changes still unstaged with the same kind are touched. */
export async function discardChanges(ctx: ScmContext, stale: Workstream, changes?: readonly FileChange[]): Promise<void> {
  const ws = await ctx.fresh(stale);
  const current = ws.unstaged.filter((c) => !changes || changes.some((d) => d.path === c.path && d.kind === c.kind));
  const discardable = current.filter((c) => c.kind !== 'conflicted');
  if (!discardable.length) return;
  const untracked = discardable.filter((c) => c.kind === 'untracked').length;
  const what = discardable.length === 1 ? discardable[0].path : `${discardable.length} files`;
  const choice = await vscode.window.showWarningMessage(
    `Discard changes to ${what} in '${workstreamLabel(ws)}'?`,
    {
      modal: true,
      detail: `${untracked ? `${untracked} untracked file(s) will be DELETED. ` : ''}This can't be undone. Staged changes are kept.`,
    },
    'Discard',
  );
  if (!choice) return;
  await scm.discard(ws.worktree.path!, discardable);
  await ctx.refresh(ws);
}

/**
 * Commits the staged changes, or all changes after asking. Without a message, asks for one.
 * Returns true when a commit was made (the webview then clears its message box).
 */
export interface CommitOptions {
  /** Amend the last commit (staged changes only; an empty message keeps the old one). */
  amend?: boolean;
  /** Push or sync (pull, then push) after committing; an unpublished branch is published. */
  then?: 'push' | 'sync';
}

export async function commit(ctx: ScmContext, stale: Workstream, message?: string, opts: CommitOptions = {}): Promise<boolean> {
  const ws = await ctx.fresh(stale);
  const dir = ws.worktree.path!;
  const label = workstreamLabel(ws);
  if (opts.amend) {
    const text = message?.trim() ?? '';
    await withProgress(`Amending the last commit on ${label}…`, () => scm.commit(dir, text, { amend: true }));
    await ctx.refresh(ws);
    await afterCommit(ctx, ws, opts);
    return true;
  }
  let stageFirst = false;
  if (!ws.staged.length) {
    if (!ws.unstaged.length) {
      void vscode.window.showInformationMessage(`Nothing to commit in '${label}'.`);
      return false;
    }
    if (ws.unstaged.some((c) => c.kind === 'conflicted')) {
      void vscode.window.showWarningMessage(`'${label}' has merge conflicts. Resolve and stage them before committing.`);
      return false;
    }
    const choice = await vscode.window.showWarningMessage(
      `There are no staged changes in '${label}'.`,
      { modal: true, detail: `Stage all ${ws.unstaged.length} change(s) and commit them?` },
      'Stage All & Commit',
    );
    if (!choice) return false;
    stageFirst = true;
  }
  if (message === undefined || !message.trim()) {
    const count = stageFirst ? ws.unstaged.length : ws.staged.length;
    message = await vscode.window.showInputBox({
      title: `Commit to ${label}`,
      prompt: `${count} ${stageFirst ? '' : 'staged '}change(s)`,
      placeHolder: 'Commit message',
      value: drafts.get(ws.key),
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'Enter a commit message.'),
    });
    if (message === undefined) return false;
    drafts.set(ws.key, message);
  }
  const text = message.trim();
  await withProgress(`Committing to ${label}…`, async () => {
    if (stageFirst) await scm.stageAll(dir);
    await scm.commit(dir, text);
  });
  drafts.delete(ws.key);
  await ctx.refresh(ws);
  await afterCommit(ctx, ws, opts);
  return true;
}

async function afterCommit(ctx: ScmContext, ws: Workstream, opts: CommitOptions): Promise<void> {
  if (!opts.then) return;
  if (syncKind(ws) === 'publish') return publish(ctx, ws);
  if (syncKind(ws) === 'none') return;
  await network(ctx, ws, opts.then === 'push' ? 'Pushing' : 'Syncing', opts.then === 'push' ? scm.push : scm.sync);
}

export async function publish(ctx: ScmContext, ws: Workstream): Promise<void> {
  const branch = ws.worktree.branch;
  if (!branch) {
    void vscode.window.showInformationMessage('A detached HEAD cannot be published. Create a branch first.');
    return;
  }
  const dir = ws.worktree.path!;
  const remotes = await scm.listRemotes(dir);
  if (!remotes.length) {
    void vscode.window.showInformationMessage('This repository has no remotes to publish to.');
    return;
  }
  const remote = remotes.length === 1 ? remotes[0] : await vscode.window.showQuickPick(remotes, { title: `Publish '${branch}' to…` });
  if (!remote) return;
  await withProgress(`Publishing ${branch} to ${remote}…`, () => scm.publish(dir, branch, remote));
  await ctx.refresh(ws);
}

/** Publishes an unpublished branch; otherwise pulls then pushes. */
export async function sync(ctx: ScmContext, ws: Workstream): Promise<void> {
  if (syncKind(ws) === 'publish') return publish(ctx, ws);
  await network(ctx, ws, 'Syncing', scm.sync);
}

export async function network(ctx: ScmContext, ws: Workstream, verb: string, op: (dir: string) => Promise<void>): Promise<void> {
  await withProgress(`${verb} ${workstreamLabel(ws)}…`, () => op(ws.worktree.path!));
  await ctx.refresh(ws);
}

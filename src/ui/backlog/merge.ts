import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runGit } from '../../core/git/gitCli';
import type { Repository } from '../../core/repository';
import { agentChatItem, agentLead, agentName, branchMatches, readyToMerge, type BacklogItem } from '../../features/backlog/backlog';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import {
  blockingItems,
  checkBranch,
  checkCommand,
  commitsTouching,
  conflictedFiles,
  fastForward,
  fixChecksPrompt,
  hasUncommittedChanges,
  idsIn,
  isMergeDir,
  linkDependencies,
  localBase,
  mergeInWorktree,
  mergeMessage,
  mergeOrder,
  mergeResult,
  mergeRoot,
  outputTail,
  removeMergeWorktree,
  resolvePrompt,
  type MergeState,
} from '../../features/backlog/merge';
import { entryDate } from '../../features/backlog/ticket';
import { resolveBase } from '../../features/workstreams/progress';
import type { Workstream } from '../../features/workstreams/workstream';
import { trackProgress } from '../progress';
import { readSettings } from '../settings';
import { agentChoice, describeChoice, runAgentHeadless, type AgentRun } from './agentRunner';

export interface MergeDeps {
  backlog: LocalBacklog;
  repository: Repository<Workstream>;
  mainRoot: string;
  output: vscode.OutputChannel;
  openTicket(id: string): void;
}

/** How a merge ended: merged, or stopped (it needs a decision, failed, or was cancelled). */
export type MergeEnd = 'merged' | 'stopped';

export { readyToMerge };

const settings = () => vscode.workspace.getConfiguration('flotilla');

/**
 * Merges tickets' branches into the base branch from the ticket (see merge.ts): checks the branch, merges it in a
 * temporary worktree, runs the checks there (in a terminal), and fast-forwards the base to the merge. Conflicts are
 * resolved by an agent (the user approves its resolution in the ticket), or the merge is cancelled. One merge at a
 * time.
 */
export class Merger implements vscode.Disposable {
  private queue: Promise<unknown> = Promise.resolve();
  /** Agents resolving conflicts, by item. */
  private readonly runs = new Map<string, AgentRun>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly deps: MergeDeps) {}

  dispose(): void {
    this.runs.forEach((r) => r.stop());
    this.changed.dispose();
  }

  isRunning(id: string): boolean {
    return this.runs.has(id);
  }

  /** One at a time: merges move the base branch. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async item(id: string): Promise<BacklogItem | undefined> {
    return (await this.deps.backlog.read()).items.find((i) => i.id === id);
  }

  private async note(id: string, body: string): Promise<void> {
    const item = await this.item(id);
    if (item) await this.deps.backlog.appendActivity(item, { date: entryDate(new Date()), author: 'Flotilla', body });
  }

  private async setMerge(id: string, merge: MergeState | undefined): Promise<void> {
    await this.deps.backlog.change(
      (d) => ({
        ...d,
        items: d.items.map((i) => {
          if (i.id !== id) return i;
          const { merging: _old, ...rest } = i;
          return merge ? { ...rest, merging: merge } : rest;
        }),
      }),
      { by: 'Flotilla' },
    );
    this.changed.fire();
  }

  /** The worktree that has a branch checked out. */
  private worktreeOn(branch: string): Workstream | undefined {
    return this.deps.repository.current.find((w) => w.worktree.branch === branch && w.worktree.path);
  }

  /** The base branch to merge into (a local one). */
  async baseBranch(): Promise<string | undefined> {
    const root = this.deps.mainRoot;
    const base = await resolveBase(root, readSettings().defaultBase);
    return base && localBase(root, base);
  }

  /** The item's branch to merge: the one with commits base doesn't have (asks if there are several; batch: stops). */
  private async branchOf(item: BacklogItem, base: string, batch: boolean): Promise<string | undefined> {
    const root = this.deps.mainRoot;
    const local = (await runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: root })).split('\n').filter(Boolean);
    const candidates = local.filter((b) => b !== base && branchMatches(item, b) && !/-clean(-\d+)?$/.test(b));
    const withWork: string[] = [];
    for (const b of candidates) {
      const ahead = Number((await runGit(['rev-list', '--count', `refs/heads/${base}..refs/heads/${b}`], { cwd: root })).trim());
      if (ahead > 0) withWork.push(b);
    }
    if (withWork.length <= 1) return withWork[0] ?? candidates[0];
    if (batch) {
      void vscode.window.showWarningMessage(`${item.id} has ${withWork.length} branches with work: merge it from its ticket, to choose one.`);
      return undefined;
    }
    return vscode.window.showQuickPick(withWork, { title: `Merge ${item.id} into ${base}`, placeHolder: 'Which branch?' });
  }

  /** A new folder for a merge's worktree, in the OS's temp folder. */
  private mergeDir(id: string): string {
    const repo = path.basename(this.deps.mainRoot).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 30);
    return path.join(mergeRoot(os.tmpdir()), `${repo}-${id}-${crypto.randomBytes(4).toString('hex')}`);
  }

  /** Removes a merge's worktree; only ever one in the temp merge folder (the path may come from backlog.json). */
  private async removeDir(dir: string): Promise<void> {
    if (!isMergeDir(dir, os.tmpdir())) {
      this.deps.output.appendLine(`Merge: not removing ${dir}: it isn't a temporary merge worktree.`);
      return;
    }
    await removeMergeWorktree(this.deps.mainRoot, dir).catch((e: unknown) =>
      this.deps.output.appendLine(`Merge: couldn't remove ${dir}: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  /**
   * Merges an item's branch into the base branch. batch (Merge All Ready): nothing is asked; anything that needs a
   * decision stops it.
   */
  merge(id: string, o: { batch?: boolean } = {}): Promise<MergeEnd> {
    return this.serial(() => trackProgress('backlog', `Merging ${id}`, () => this.doMerge(id, !!o.batch)));
  }

  private async doMerge(id: string, batch: boolean): Promise<MergeEnd> {
    const item = await this.item(id);
    if (!item) return 'stopped';
    if (item.merging) {
      this.deps.openTicket(id);
      void vscode.window.showInformationMessage(`${id} is being merged already: its ticket says where it is.`);
      return 'stopped';
    }
    const root = this.deps.mainRoot;
    const base = await this.baseBranch();
    if (!base) {
      void vscode.window.showWarningMessage("Can't tell which branch to merge into: set flotilla.defaultBase to a local branch.");
      return 'stopped';
    }
    const branch = await this.branchOf(item, base, batch);
    if (!branch) {
      if (!batch) void vscode.window.showWarningMessage(`${id} has no branch to merge.`);
      return 'stopped';
    }
    const check = await checkBranch(root, base, branch);
    if (check.merged) {
      const done = batch ? undefined : await vscode.window.showInformationMessage(`${base} has all of ${branch}'s commits already: there's nothing to merge.`, 'Move to Done');
      if (done) await this.finish(item, { base, branch, commit: check.baseTip, already: true });
      return 'stopped';
    }
    const data = await this.deps.backlog.read();
    const blocking = blockingItems(item, check.commits.map((c) => c.message), data.items);
    if (blocking.length) {
      const list = blocking.map((b) => `${b.id} "${b.title}" (${b.status === 'review' ? 'in review' : b.status === 'doing' ? 'in progress' : 'to do'})`);
      void vscode.window.showErrorMessage(`${branch} can't be merged: it has commits of ${blocking.length === 1 ? 'another ticket that isn\'t' : 'other tickets that aren\'t'} done.`, {
        modal: !batch,
        detail: `${list.join('\n')}\n\nMerge ${blocking.length === 1 ? 'it' : 'them'} first, or take ${blocking.length === 1 ? 'its' : 'their'} commits out of ${branch}.`,
      });
      await this.note(id, `The merge was refused: \`${branch}\` has commits of ${blocking.map((b) => b.id).join(', ')}, which ${blocking.length === 1 ? "isn't" : "aren't"} done.`);
      return 'stopped';
    }
    if (check.superseded) {
      if (batch) {
        void vscode.window.showWarningMessage(`${id} looks superseded: nothing ${branch} changes differs from ${base}. Merge it from its ticket to decide.`);
        return 'stopped';
      }
      const choice = await vscode.window.showWarningMessage(
        `${id} looks superseded: nothing ${branch} changes differs from ${base}.`,
        { modal: true, detail: `${base} has the same files already (from other commits). Merging adds only a merge commit.` },
        'Merge Anyway',
        'Move to Done',
      );
      if (choice === 'Move to Done') await this.finish(item, { base, branch, commit: check.baseTip, already: true });
      if (choice !== 'Merge Anyway') return 'stopped';
    }
    const dir = this.mergeDir(id);
    const message = mergeMessage(item);
    this.deps.output.appendLine(`Merge: ${branch} into ${base} in ${dir}.`);
    const outcome = await mergeInWorktree(root, { dir, baseTip: check.baseTip, branch, message });
    if (outcome.kind === 'conflicts') {
      const state: MergeState = { dir, branch, base, baseTip: check.baseTip, state: 'failed', reason: conflictsReason(outcome.files), started: new Date().toISOString() };
      if (batch) {
        await this.setMerge(id, state);
        await this.note(id, `Merging \`${branch}\` into \`${base}\` stopped on conflicts in ${outcome.files.map((f) => `\`${f}\``).join(', ')}: resolve them with an agent, or cancel.`);
        this.deps.openTicket(id);
        return 'stopped';
      }
      const choice = await vscode.window.showWarningMessage(
        `Merging ${branch} into ${base} has conflicts.`,
        {
          modal: true,
          detail: `${outcome.files.join('\n')}\n\nResolve with Agent: an agent resolves them in the merge's temporary worktree, keeping both sides' intent, and reports in the ticket for you to approve. Cancel: nothing changes.`,
        },
        'Resolve with Agent',
      );
      if (choice !== 'Resolve with Agent') {
        await this.removeDir(dir);
        return 'stopped';
      }
      await this.setMerge(id, state);
      await this.startResolver(id);
      return 'stopped';
    }
    return this.complete(item, { dir, branch, base, baseTip: check.baseTip, commit: outcome.commit }, batch);
  }

  /**
   * After the merge commit: the checks, then the fast-forward and the ticket to Done. Failing checks keep the merge
   * (in its worktree, for an agent to fix or the user to cancel) with nothing changed; anything else that stops it
   * keeps only a resolved merge, for another try.
   */
  private async complete(
    item: BacklogItem,
    m: { dir: string; branch: string; base: string; baseTip: string; commit: string; merge?: string; fixes?: readonly string[]; resolved?: boolean },
    batch: boolean,
  ): Promise<MergeEnd> {
    const keep = async (reason: string) => {
      if (m.resolved) {
        const current = (await this.item(item.id))?.merging;
        if (current) await this.setMerge(item.id, { ...current, state: 'failed', reason, checks: undefined });
      } else await this.removeDir(m.dir);
    };
    const command = await checkCommand(m.dir, settings().get<string>('merge.checkCommand', ''));
    if (command) {
      const source = this.worktreeOn(m.base)?.worktree.path ?? this.deps.mainRoot;
      await linkDependencies(m.dir, source).catch((e: unknown) => this.deps.output.appendLine(`Merge: no node_modules link: ${String(e)}`));
      const title = `Checks: merge ${item.id} into ${m.base}`;
      const checks = await runChecks(m.dir, command, title).catch((e: unknown) => ({ passed: false, output: e instanceof Error ? e.message : String(e) }));
      if (!checks.passed) {
        // Kept: each side passed alone, so it's the two together; an agent can fix that on the merge.
        const current = (await this.item(item.id))?.merging;
        const state: MergeState = {
          ...(current ?? { dir: m.dir, branch: m.branch, base: m.base, baseTip: m.baseTip, started: new Date().toISOString() }),
          state: 'failed',
          reason: `the checks failed (\`${command}\`).`,
          checks: { command, output: checks.output },
        };
        await this.setMerge(item.id, state);
        const again = m.resolved ? ' again' : '';
        await this.note(
          item.id,
          `Merging \`${m.branch}\` into \`${m.base}\` stopped: the checks failed${again} on the merge (\`${command}\`; their output is in the terminal "${title}"). Nothing changed: the merge is kept in a temporary worktree. Fix with Agent, or cancel it.`,
        );
        if (!batch) {
          this.deps.openTicket(item.id);
          void vscode.window.showWarningMessage(`The checks failed${again} on the merge of ${item.id}: nothing changed. Fix with Agent from its ticket, or cancel.`, 'Fix with Agent').then(
            (c) => c && void this.resolveWithAgent(item.id).catch(showError),
          );
        }
        return 'stopped';
      }
    }
    const holder = this.worktreeOn(m.base);
    for (;;) {
      if (holder?.worktree.path && (await hasUncommittedChanges(holder.worktree.path))) {
        const where = holder.worktree.isMain ? 'the main worktree' : `worktree ${holder.worktree.path}`;
        const retry = batch
          ? undefined
          : await vscode.window.showWarningMessage(
              `${m.base} is checked out in ${where}, which has uncommitted changes: it can't be moved to the merge.`,
              { modal: true, detail: 'Commit or stash them there, then Try Again. Cancel leaves everything as it was.' },
              'Try Again',
            );
        if (retry) continue;
        await keep(`${m.base} is checked out in ${where}, which has uncommitted changes.`);
        await this.note(item.id, `Merging \`${m.branch}\` into \`${m.base}\` stopped: ${m.base} is checked out in ${where}, which has uncommitted changes. Nothing changed.`);
        return 'stopped';
      }
      break;
    }
    try {
      await fastForward(this.deps.mainRoot, { base: m.base, baseTip: m.baseTip, commit: m.commit, worktree: holder?.worktree.path, message: mergeMessage(item) });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      await keep(why);
      await this.note(item.id, `Merging \`${m.branch}\` into \`${m.base}\` stopped: ${why}`);
      void vscode.window.showErrorMessage(`${item.id} wasn't merged: ${why}`);
      return 'stopped';
    }
    await this.removeDir(m.dir);
    await this.finish(item, { base: m.base, branch: m.branch, commit: m.commit, merge: m.merge, fixes: m.fixes, checks: command });
    return 'merged';
  }

  /** The ticket to Done, saying what was merged; then Push and the worktree's clean-up are offered. */
  private async finish(
    item: BacklogItem,
    m: { base: string; branch: string; commit: string; merge?: string; fixes?: readonly string[]; checks?: string; already?: boolean },
  ): Promise<void> {
    const root = this.deps.mainRoot;
    const merge = m.merge ?? m.commit;
    const count = m.already ? 0 : Number((await runGit(['rev-list', '--count', `${merge}^1..${merge}^2`], { cwd: root }).catch(() => '0')).trim());
    const fixes = m.fixes?.length ? ` On top of it, the fix${m.fixes.length === 1 ? '' : 'es'} of the checks: ${m.fixes.map((f) => `"${f}"`).join(', ')}.` : '';
    await this.deps.backlog.change(
      (d) => ({
        ...d,
        items: d.items.map((i) => {
          if (i.id !== item.id) return i;
          const { merging: _m, ...rest } = i;
          return { ...rest, status: 'done' as const, ...(m.already ? {} : { merged: { into: m.base, commit: m.commit, date: new Date().toISOString() } }) };
        }),
      }),
      { by: 'Flotilla' },
    );
    this.changed.fire();
    await this.note(
      item.id,
      m.already
        ? `\`${m.base}\` has \`${m.branch}\`'s work already: nothing was merged.`
        : `Merged \`${m.branch}\` into \`${m.base}\`: ${count} commit${count === 1 ? '' : 's'}, merge commit ${merge.slice(0, 7)} ("${mergeMessage(item)}").${fixes}${m.checks ? ` The checks passed (\`${m.checks}\`).` : ' No checks ran (set flotilla.merge.checkCommand).'} Nothing was pushed.`,
    );
    if (m.already) return;
    const ws = this.deps.repository.current.find((w) => !w.worktree.isMain && w.worktree.branch === m.branch);
    const actions = ['Push…', ...(ws ? ['Remove Worktree…'] : [])];
    void vscode.window.showInformationMessage(`Merged ${item.id} into ${m.base}.`, ...actions).then((c) => {
      if (c === 'Push…') void this.push().catch(showError);
      else if (c === 'Remove Worktree…' && ws) void vscode.commands.executeCommand('flotilla.remove', { key: ws.key });
    });
  }

  /** Merges every ticket ready to merge, dependencies first; stops at the first that needs a decision. */
  mergeAllReady(): Promise<void> {
    return this.serial(async () => {
      const root = this.deps.mainRoot;
      const base = await this.baseBranch();
      const ready = (await this.deps.backlog.read()).items.filter(readyToMerge);
      if (!ready.length || !base) {
        void vscode.window.showInformationMessage(base ? 'No tickets are ready to merge (approved, in review).' : "Can't tell which branch to merge into: set flotilla.defaultBase.");
        return;
      }
      // Each one's branch tip, for the order: a branch that has another's tip goes after it.
      const tips = new Map<string, string>();
      for (const item of ready) {
        const b = await this.branchOf(item, base, true).catch(() => undefined);
        const tip = b && (await runGit(['rev-parse', `refs/heads/${b}`], { cwd: root }).catch(() => '')).trim();
        if (tip) tips.set(item.id, tip);
      }
      const ancestor = new Map<string, boolean>();
      for (const a of ready) {
        for (const b of ready) {
          const ta = tips.get(a.id);
          const tb = tips.get(b.id);
          if (a === b || !ta || !tb || ta === tb) continue;
          ancestor.set(`${a.id} ${b.id}`, await runGit(['merge-base', '--is-ancestor', tb, ta], { cwd: root }).then(() => true, () => false));
        }
      }
      const order = mergeOrder(ready, (a, b) => !!ancestor.get(`${a.id} ${b.id}`));
      const merged: string[] = [];
      for (const item of order) {
        const end = await trackProgress('backlog', `Merging ${item.id}`, () => this.doMerge(item.id, true));
        if (end !== 'merged') {
          void vscode.window.showWarningMessage(
            `Merge All Ready stopped at ${item.id}${merged.length ? `, after merging ${merged.join(', ')}` : ''}: it needs you. Its ticket says why.`,
            'Open',
          ).then((c) => c && this.deps.openTicket(item.id));
          return;
        }
        merged.push(item.id);
      }
    });
  }

  /** Starts (or starts again) an agent resolving a merge's conflicts in its worktree. */
  resolveWithAgent(id: string): Promise<void> {
    return this.serial(() => this.startResolver(id));
  }

  private async startResolver(id: string): Promise<void> {
    const item = await this.item(id);
    const m = item?.merging;
    if (!item || !m || this.runs.has(id)) return;
    if (!isMergeDir(m.dir, os.tmpdir())) throw new Error(`${id}'s merge isn't in a temporary merge worktree; cancel it.`);
    const root = this.deps.mainRoot;
    const files = await conflictedFiles(m.dir);
    const start = (await runGit(['merge-base', m.baseTip, `refs/heads/${m.branch}`], { cwd: root })).trim();
    const failedChecks = !files.length ? m.checks : undefined;
    const touched = files.length ? files : (await runGit(['diff', '--name-only', `${start}`, m.baseTip], { cwd: root })).split('\n').filter(Boolean).slice(0, 20);
    const [theirs, ours] = await Promise.all([
      commitsTouching(root, start, `refs/heads/${m.branch}`, touched),
      // Failing checks can come from any of the base's changes: all its commits since the branch started.
      failedChecks
        ? runGit(['log', '--reverse', '--format=%h %s', `${start}..${m.baseTip}`], { cwd: root }).then((o) => o.split('\n').filter(Boolean))
        : commitsTouching(root, start, m.baseTip, touched),
    ]);
    // The tickets of the base's side, from its commits' messages.
    const data = await this.deps.backlog.read();
    const otherIds = idsIn(ours.join('\n'), data.items.filter((i) => i.id !== id).map((i) => i.id));
    const others = await Promise.all(
      data.items
        .filter((i) => otherIds.includes(i.id))
        .map(async (i) => ({ id: i.id, title: i.title, description: (await this.deps.backlog.readTicket(i)).description, ticket: this.deps.backlog.docPath(i.id) })),
    );
    const taken = this.deps.repository.current.flatMap((w) => w.chats.map((c) => agentChatItem(c.firstPrompt)?.agent ?? c.agent ?? '')).filter(Boolean);
    const agent = m.agent ?? agentName(taken);
    const checks = await checkCommand(m.dir, settings().get<string>('merge.checkCommand', ''));
    if (checks) await linkDependencies(m.dir, this.worktreeOn(m.base)?.worktree.path ?? root).catch(() => undefined);
    const common = { item, agent, ticket: this.deps.backlog.docPath(id), branch: m.branch, base: m.base, start, description: (await this.deps.backlog.readTicket(item)).description, ours, others };
    const prompt = [
      agentLead(item, agent),
      failedChecks
        ? fixChecksPrompt({ ...common, checks: failedChecks })
        : resolvePrompt({ ...common, files, theirs, checks, ...(files.length ? {} : { problem: m.reason }) }),
    ].join('\n\n');
    // The tip it starts from: a fix is a commit on top of it.
    const from = failedChecks ? (await runGit(['rev-parse', 'HEAD'], { cwd: m.dir })).trim() : undefined;
    const choice = agentChoice(item);
    const run = runAgentHeadless({ cwd: m.dir, prompt, name: `${id} merge`, choice, output: this.deps.output });
    this.runs.set(id, run);
    await this.setMerge(id, { ...m, state: 'resolving', agent, session: run.sessionId, reason: undefined, ...(from ? { from } : {}) });
    const task = files.length
      ? `resolve the conflicts in ${files.map((f) => `\`${f}\``).join(', ')}`
      : failedChecks
        ? `fix the checks that fail on the merge (\`${failedChecks.command}\`), keeping both sides' intent`
        : `fix the merge (${m.reason ?? 'it stopped'})`;
    await this.note(id, `Merging \`${m.branch}\` into \`${m.base}\`: opened a chat for agent ${agent}${describeChoice(choice)} to ${task}, in a temporary worktree. It reports here for you to approve.`);
    void run.done.then((result) => this.afterResolver(id, run, result.error));
  }

  private async afterResolver(id: string, run: AgentRun, error: string | undefined): Promise<void> {
    if (this.runs.get(id) !== run) return; // stopped
    this.runs.delete(id);
    const m = (await this.item(id))?.merging;
    if (!m) return;
    const agent = m.agent ?? 'The agent';
    const again = m.checks ? 'Fix with Agent' : 'Resolve with Agent';
    const result = await mergeResult(m.dir, m.baseTip, id).catch((e: unknown) => ({ problem: e instanceof Error ? e.message : String(e) }));
    if ('problem' in result) {
      const reason = `${agent} stopped before the merge was ${m.checks ? 'fixed' : 'resolved'}: ${result.problem}${error ? ` (${error.slice(0, 200)})` : ''}`;
      await this.setMerge(id, { ...m, state: 'failed', reason });
      await this.note(id, `${reason} ${again} again, or cancel the merge.`);
      void vscode.window.showWarningMessage(`The merge of ${id} isn't ${m.checks ? 'fixed' : 'resolved'}: ${result.problem}`, 'Open').then((c) => c && this.deps.openTicket(id));
      return;
    }
    if (m.checks && result.commit === m.from) {
      // No fix committed: it asks something in the ticket (a design conflict), or it gave up; its report says which.
      const reason = `${agent} committed no fix: its report says why (it may ask you something). Answer there, then ${again} again; or cancel the merge.`;
      await this.setMerge(id, { ...m, state: 'failed', reason });
      void vscode.window.showWarningMessage(`${agent} didn't fix the checks on the merge of ${id}: its report in the ticket says why.`, 'Open').then((c) => c && this.deps.openTicket(id));
      return;
    }
    await this.setMerge(id, { ...m, state: 'resolved', reason: undefined });
    void vscode.window
      .showInformationMessage(
        m.checks
          ? `${agent} fixed the checks on the merge of ${id}. Read its report, and approve the fix in the ticket.`
          : `${agent} resolved the conflicts of merging ${id}. Read its report, and approve the resolution in the ticket.`,
        'Open',
      )
      .then((c) => c && this.deps.openTicket(id));
  }

  /** The user approved the agent's resolution: the checks, then the fast-forward. */
  approveResolution(id: string): Promise<MergeEnd> {
    return this.serial(() =>
      trackProgress('backlog', `Merging ${id}`, async () => {
        const item = await this.item(id);
        const m = item?.merging;
        if (!item || !m || this.runs.has(id)) return 'stopped';
        if (!isMergeDir(m.dir, os.tmpdir())) throw new Error(`${id}'s merge isn't in a temporary merge worktree; cancel it.`);
        const result = await mergeResult(m.dir, m.baseTip, id);
        if ('problem' in result) {
          await this.setMerge(id, { ...m, state: 'failed', reason: `the merge isn't ${m.checks ? 'fixed' : 'resolved'}: ${result.problem}` });
          void vscode.window.showWarningMessage(`The merge of ${id} isn't ${m.checks ? 'fixed' : 'resolved'}: ${result.problem}`);
          return 'stopped';
        }
        await this.note(id, m.checks ? `You approved the fix of the checks on the merge.` : `You approved the resolution of the merge's conflicts.`);
        return this.complete(
          item,
          { dir: m.dir, branch: m.branch, base: m.base, baseTip: m.baseTip, commit: result.commit, merge: result.merge, fixes: result.fixes, resolved: true },
          false,
        );
      }),
    );
  }

  /** Cancels a merge waiting for a decision: its agent stops, its worktree goes; nothing changes. */
  cancel(id: string): Promise<void> {
    return this.serial(async () => {
      this.runs.get(id)?.stop();
      this.runs.delete(id);
      const m = (await this.item(id))?.merging;
      if (!m) return;
      await this.removeDir(m.dir);
      await this.setMerge(id, undefined);
      await this.note(id, `You cancelled the merge of \`${m.branch}\` into \`${m.base}\`. Nothing changed.`);
    });
  }

  /** What the base branch has that its upstream doesn't (to push), if it has an upstream. */
  async unpushed(base: string): Promise<{ remote: string; count: number } | undefined> {
    const root = this.deps.mainRoot;
    const remote = (await runGit(['config', `branch.${base}.remote`], { cwd: root }).catch(() => '')).trim();
    if (!remote) return undefined;
    const count = Number((await runGit(['rev-list', '--count', `refs/heads/${base}@{upstream}..refs/heads/${base}`], { cwd: root }).catch(() => '0')).trim()) || 0;
    return { remote, count };
  }

  /** Pushes the base branch to its upstream, after asking. */
  async push(): Promise<void> {
    const root = this.deps.mainRoot;
    const base = await this.baseBranch();
    if (!base) return;
    const remote = (await runGit(['config', `branch.${base}.remote`], { cwd: root }).catch(() => '')).trim();
    const merge = (await runGit(['config', `branch.${base}.merge`], { cwd: root }).catch(() => '')).trim();
    if (!remote || !merge) {
      void vscode.window.showWarningMessage(`${base} has no upstream to push to.`);
      return;
    }
    const target = merge.replace(/^refs\/heads\//, '');
    const count = (await this.unpushed(base))?.count ?? 0;
    const choice = await vscode.window.showInformationMessage(
      `Push ${base} to ${remote}?`,
      { modal: true, detail: `git push ${remote} ${base}:${target}\n${count} commit${count === 1 ? '' : 's'} that ${remote}/${target} doesn't have.` },
      'Push',
    );
    if (choice !== 'Push') return;
    await trackProgress('backlog', `Pushing ${base}`, () => runGit(['push', remote, `refs/heads/${base}:${merge}`], { cwd: root, timeoutMs: 120_000 }));
    void vscode.window.showInformationMessage(`Pushed ${base} to ${remote}.`);
    this.changed.fire();
  }

  /** An item was approved, by the reviewer agent (its name) or the user (undefined): flotilla.merge.onApprove says what follows. */
  approved(id: string, by: string | undefined): void {
    const mode = settings().get<string>('merge.onApprove', 'ask');
    if (mode === 'auto') {
      void this.merge(id, { batch: true }).catch(showError);
      return;
    }
    void (async () => {
      const item = await this.item(id);
      if (!item) return;
      if (mode === 'off') {
        if (by) {
          const c = await vscode.window.showInformationMessage(`${by} approved ${id} "${item.title}". It's ready for you to merge.`, 'Open');
          if (c) this.deps.openTicket(id);
        }
        return;
      }
      const base = (await this.baseBranch()) ?? 'the base branch';
      const c = await vscode.window.showInformationMessage(
        by ? `${by} approved ${id} "${item.title}". Merge it into ${base}?` : `Merge ${id} "${item.title}" into ${base} now?`,
        'Merge',
        'Open',
      );
      if (c === 'Merge') await this.merge(id);
      else if (c === 'Open') this.deps.openTicket(id);
    })().catch(showError);
  }
}

const showError = (e: unknown) => void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));

function conflictsReason(files: readonly string[]): string {
  return `conflicts in ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}.`;
}

/**
 * Runs the checks in a terminal (a task), in dir: whether they passed, and their output (kept, so a failure can be
 * shown in the ticket and given to an agent). The command runs in a shell of its own, its output written to the
 * task's terminal as it comes; closing the terminal stops it (a failure).
 */
async function runChecks(dir: string, command: string, title: string): Promise<{ passed: boolean; output: string }> {
  let output = '';
  let settle: (code: number | undefined) => void = () => undefined;
  const done = new Promise<number | undefined>((resolve) => (settle = resolve));
  const execution = new vscode.CustomExecution(async () => {
    const write = new vscode.EventEmitter<string>();
    const close = new vscode.EventEmitter<number>();
    let child: ChildProcess | undefined;
    const end = (code: number | undefined) => {
      settle(code);
      close.fire(code ?? 1);
    };
    return {
      onDidWrite: write.event,
      onDidClose: close.event,
      open: () => {
        write.fire(`\x1b[2m${dir}> ${command}\x1b[0m\r\n`);
        // Its own process group (not on Windows), so stopping it stops what the shell started too.
        child = spawn(command, { cwd: dir, shell: true, env: { ...process.env, FORCE_COLOR: '1' }, windowsHide: true, detached: process.platform !== 'win32' });
        const take = (b: Buffer) => {
          const text = b.toString('utf8');
          // Only the end is kept: that's where the failures are summed up.
          output = (output + text).slice(-200_000);
          write.fire(text.replace(/\r?\n/g, '\r\n'));
        };
        child.stdout?.on('data', take);
        child.stderr?.on('data', take);
        child.on('error', (e) => {
          take(Buffer.from(`\n${e.message}\n`));
          end(undefined);
        });
        child.on('close', (code) => end(code ?? undefined));
      },
      close: () => {
        if (child?.pid && child.exitCode === null) stopTree(child.pid);
        settle(undefined);
      },
    };
  });
  const task = new vscode.Task({ type: 'flotilla-merge', command }, vscode.TaskScope.Workspace, title, 'Flotilla', execution);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true, showReuseMessage: false };
  await vscode.tasks.executeTask(task);
  const code = await done;
  return { passed: code === 0, output: outputTail(output) };
}

/** Stops a process and the ones it started (the shell's command). */
function stopTree(pid: number): void {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => undefined);
  else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // gone already
    }
  }
}

import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runGit } from '../../core/git/gitCli';
import type { Repository } from '../../core/repository';
import { agentChatItem, agentLead, agentName, branchMatches, readyToMerge, type BacklogData, type BacklogItem } from '../../features/backlog/backlog';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import { ciStop, type CiStop } from '../../features/backlog/ciStop';
import { decideCi, failedNote, passedNote, waitingNote, type CiDecision, type CiReader, type MergeChecks } from '../../features/backlog/mergeCi';
import type { CiRun } from '../../features/ci/githubActions';
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
  timeoutsOnly,
  type MergeState,
} from '../../features/backlog/merge';
import { buildTrain, dequeue, enqueue, landing, mergeAgain, ordinal, queuedItems, recordResolution, startTrainMerge, trainIsCurrent, trainOnto, trainState, type MergeTrain } from '../../features/backlog/mergeTrain';
import { entryDate } from '../../features/backlog/ticket';
import { resolveBase } from '../../features/workstreams/progress';
import type { Workstream } from '../../features/workstreams/workstream';
import type { MergeQueueView } from '../../webview/protocol';
import { trackProgress } from '../progress';
import { readSettings } from '../settings';
import { agentChoice, describeChoice, runAgentHeadless, type AgentRun } from './agentRunner';

export interface MergeDeps {
  backlog: LocalBacklog;
  repository: Repository<Workstream>;
  mainRoot: string;
  output: vscode.OutputChannel;
  openTicket(id: string): void;
  /** GitHub's runs of origin for Merge to main to decide on (BL-105), or why they can't be read. None: local checks. */
  ciReader?(): Promise<CiReader | string>;
  /** Update from Main (BL-55): main into the ticket's branch, which is then pushed, and CI runs again. */
  updateFromMain?(id: string): Promise<void>;
  /** Fix with Agent (BL-7) on a failed CI job of the branch. */
  fixCi?(branch: string, runId: number, jobId?: number): Promise<void>;
  /** Whether this window rebuilds the merge train (BL-140): one window does. None: it does. */
  isLeader?(): boolean;
  /** How often a merge waiting for CI reads its runs again (the tests' is short). */
  ciPollMs?: number;
}

/** How a merge ended: merged, stopped (it needs a decision, failed, or was cancelled), or waiting for CI to pass. */
export type MergeEnd = 'merged' | 'stopped' | 'waiting';

/** How often a merge waiting for CI reads its runs again. */
const CI_POLL_MS = 10_000;

/** A merge waiting for CI (BL-105): what it was asked on, and the runs as last read. */
interface CiWait {
  branch: string;
  tip: string;
  baseTip: string;
  batch: boolean;
  runs: CiRun[];
  timer?: ReturnType<typeof setTimeout>;
}

export { readyToMerge };

const settings = () => vscode.workspace.getConfiguration('flotilla');

/**
 * Merges tickets' branches into the base branch from the ticket (see merge.ts): checks the branch, merges it in a
 * temporary worktree, runs the checks there (in a terminal), and fast-forwards the base to the merge. Conflicts are
 * resolved by an agent (the user approves its resolution in the ticket), or the merge is cancelled. One merge at a
 * time. Its states, and what moves each on, are in the table of features/backlog/mergeStates.ts; a new path goes there
 * and into the scenarios of tests/integration/merge/ together (BL-150).
 */
export class Merger implements vscode.Disposable {
  private queue: Promise<unknown> = Promise.resolve();
  /** Agents resolving conflicts, by item. */
  private readonly runs = new Map<string, AgentRun>();
  /** Items whose merge is moving the base and the ticket now: the merge watcher leaves them to it. */
  private readonly finishing = new Set<string>();
  /** The queue's tasks, in order, the first one running: what each does ("BL-3's merge"), and for which ticket. */
  private readonly tasks: Array<{ id?: string; what: string }> = [];
  /** Tickets whose Merge to main is queued or running. */
  private readonly merging = new Set<string>();
  /** Merges waiting for CI to pass, by ticket: outside the queue, so they hold up no other merge. */
  private readonly ciWaits = new Map<string, CiWait>();
  /** Why each ticket's last Merge to main stopped on CI (BL-112): red CI, or the base moved on. In memory. */
  private readonly ciStops = new Map<string, CiStop>();
  /** The merge queue and its train as last read (BL-140), for the views. */
  private queueSeen: { queue: string[]; train?: MergeTrain } = { queue: [] };
  private trainTimer?: ReturnType<typeof setTimeout>;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly deps: MergeDeps) {}

  dispose(): void {
    clearTimeout(this.trainTimer);
    this.runs.forEach((r) => r.stop());
    this.ciWaits.forEach((w) => clearTimeout(w.timer));
    this.ciWaits.clear();
    this.changed.dispose();
  }

  isRunning(id: string): boolean {
    return this.runs.has(id);
  }

  /** Its merge is being finished now (the base moves, then the ticket goes to Done with what was merged). */
  isFinishing(id: string): boolean {
    return this.finishing.has(id);
  }

  /**
   * A Merge to main of the ticket on its way (undefined: none): waitsFor says what it waits behind. Nothing in the
   * queue waits on an answer that can go unanswered (a notification): only modal questions are awaited there (BL-101).
   */
  mergeProgress(id: string): { waitsFor?: string; ci?: Array<Pick<CiRun, 'workflow' | 'number' | 'status' | 'url'>> } | undefined {
    const wait = this.ciWaits.get(id);
    if (wait && !this.merging.has(id)) return { ci: wait.runs.map((r) => ({ workflow: r.workflow, number: r.number, status: r.status, url: r.url })) };
    if (!this.merging.has(id)) return undefined;
    const first = this.tasks[0];
    return first && first.id !== id ? { waitsFor: first.what } : {};
  }

  /** The ticket's place in the merge queue (BL-140), and what its train says of it; undefined if it isn't queued. */
  queuePlace(id: string): { place: string; state?: string; ahead: string[] } | undefined {
    const at = this.queueSeen.queue.indexOf(id);
    if (at < 0) return undefined;
    const train = this.queueSeen.train;
    const state = train && trainState(train, id);
    return { place: `${ordinal(at + 1)} of ${this.queueSeen.queue.length}`, ...(state ? { state } : {}), ahead: this.queueSeen.queue.slice(0, at) };
  }

  /** The merge queue, first to land first, with each ticket's train state (for the backlog's queue bar). */
  queueView(): MergeQueueView {
    const train = this.queueSeen.train;
    const entries = this.queueSeen.queue.map((id) => {
      const e = train?.entries.find((x) => x.id === id);
      return { id, state: e?.commit ? ('clean' as const) : e?.conflicts ? ('conflicts' as const) : ('unknown' as const) };
    });
    return { entries, ...(this.tasks[0] ? { working: this.tasks[0].what } : {}) };
  }

  /** Reads the queue again, and rebuilds the train a moment later if it's out of date (main, a branch or the queue moved). */
  queueChanged(): void {
    void this.readQueue().then(() => {
      clearTimeout(this.trainTimer);
      if (!this.queueSeen.queue.length || this.deps.isLeader?.() === false) return;
      this.trainTimer = setTimeout(() => void this.refreshTrain().catch((e: unknown) => this.deps.output.appendLine(`Merge train: ${String(e)}`)), 3000);
    });
  }

  private async readQueue(): Promise<BacklogData> {
    const data = await this.deps.backlog.read();
    const seen = { queue: queuedItems(data).map((i) => i.id), train: data.mergeTrain };
    if (JSON.stringify(seen) !== JSON.stringify(this.queueSeen)) {
      this.queueSeen = seen;
      this.changed.fire();
    }
    return data;
  }

  /** The train rebuilt if it's out of date: one task in line with the merges. */
  refreshTrain(): Promise<MergeTrain | undefined> {
    return this.serial({ what: 'rebuilding the merge train' }, () => this.currentTrain());
  }

  /** Takes a ticket out of the merge queue: the train is rebuilt without it; nothing is reverted. */
  removeFromQueue(id: string): Promise<void> {
    return this.serial({ id, what: `taking ${id} out of the merge queue` }, async () => {
      if (!(await this.changeQueue((q) => dequeue(q, [id])))) return;
      await this.note(id, 'You took it out of the merge queue. Merge to main puts it back, at the end.');
      await this.currentTrain();
    });
  }

  /**
   * Puts the queue in this order (BL-144: dragged in the backlog's queue bar), and rebuilds the train in it. Queued
   * tickets the order leaves out keep their places after it; ids that aren't queued are ignored.
   */
  reorderQueue(order: readonly string[]): Promise<void> {
    return this.serial({ what: 'reordering the merge queue' }, async () => {
      if (!(await this.changeQueue((q) => [...order.filter((id) => q.includes(id)), ...dequeue(q, order)]))) return;
      await this.currentTrain();
    });
  }

  /** Merge Next (BL-144): moves a queued ticket to the front of the queue, and rebuilds the train. */
  mergeNext(id: string): Promise<void> {
    return this.serial({ id, what: `moving ${id} to the front of the merge queue` }, async () => {
      if (!(await this.changeQueue((q) => (q.includes(id) ? [id, ...dequeue(q, [id])] : q)))) return;
      await this.note(id, 'You moved it to the front of the merge queue (Merge Next).');
      await this.currentTrain();
    });
  }

  /** Changes the saved queue; whether it changed. */
  private async changeQueue(change: (queue: string[]) => string[]): Promise<boolean> {
    let changed = false;
    await this.deps.backlog.change(
      (d) => {
        const queue = change(d.mergeQueue ?? []);
        changed = JSON.stringify(queue) !== JSON.stringify(d.mergeQueue ?? []);
        return changed ? { ...d, mergeQueue: queue } : d;
      },
      { by: 'Flotilla' },
    );
    if (changed) await this.readQueue();
    return changed;
  }

  /**
   * The train for the queue as it is now: the saved one if it was built on the same tips, else built again (in a
   * temporary worktree) and saved. The queue drops tickets that aren't ready to merge any more. Runs inside a task.
   */
  private async currentTrain(o: { rebuild?: boolean } = {}): Promise<MergeTrain | undefined> {
    const root = this.deps.mainRoot;
    const base = await this.baseBranch();
    if (!base) return undefined;
    const data = await this.deps.backlog.read();
    const queued = queuedItems(data);
    const entries: Array<{ id: string; branch: string; tip: string; message: string }> = [];
    for (const item of queued) {
      const branch = await this.branchOf(item, base, true).catch(() => undefined);
      const tip = branch && (await runGit(['rev-parse', `refs/heads/${branch}`], { cwd: root }).catch(() => '')).trim();
      if (branch && tip) entries.push({ id: item.id, branch, tip, message: mergeMessage(item) });
    }
    const baseTip = (await runGit(['rev-parse', `refs/heads/${base}`], { cwd: root })).trim();
    // A ticket whose train conflict is being resolved keeps its place: it's left out of the train meanwhile (BL-146).
    const keep = (d: BacklogData) => {
      const kept = new Set([...queuedItems(d).map((i) => i.id), ...d.items.filter((i) => i.merging?.train).map((i) => i.id)]);
      return (d.mergeQueue ?? []).filter((id) => kept.has(id));
    };
    if (!o.rebuild && trainIsCurrent(data.mergeTrain, baseTip, entries) && JSON.stringify(keep(data)) === JSON.stringify(data.mergeQueue ?? [])) {
      await this.readQueue();
      return data.mergeTrain;
    }
    const train = entries.length ? await buildTrain(root, { dir: this.mergeDir('train'), base, baseTip, entries }) : undefined;
    await this.deps.backlog.change(
      (d) => {
        const { mergeTrain: _old, ...rest } = d;
        // Tickets queued meanwhile stay, at the end.
        return { ...rest, mergeQueue: keep(d), ...(train ? { mergeTrain: train } : {}) };
      },
      { by: 'Flotilla' },
    );
    this.deps.output.appendLine(`Merge train: ${train ? train.entries.map((e) => `${e.id} ${e.commit ? 'in' : 'conflicts'}`).join(', ') : 'empty'} (on ${base} ${baseTip.slice(0, 7)}).`);
    await this.readQueue();
    return train;
  }

  /**
   * Whether landing goes by the train: its merge commits are what's checked and landed (BL-140). Not when CI decides
   * the merge (flotilla.merge.checks ci, with GitHub readable): CI ran on the branch's own tip, so tickets land one by one.
   */
  private async landsByTrain(): Promise<{ localWhy?: string } | undefined> {
    if (settings().get<MergeChecks>('merge.checks', 'ci') === 'local') return {};
    const reader = this.deps.ciReader ? await this.deps.ciReader().catch((e: unknown) => `GitHub couldn't be read: ${e instanceof Error ? e.message : String(e)}`) : "this window doesn't read GitHub's runs.";
    return typeof reader === 'string' ? { localWhy: reader } : undefined;
  }

  /**
   * Lands a ticket by the train: the ticket joins the queue, and main moves to its merge commit in the train, one
   * ticket at a time (each one's checks on its own merge commit), with those ahead of it first. Undefined: it isn't in
   * the train (it conflicts with what's ahead of it), or you chose to merge it alone: it's merged onto main as it is.
   */
  private async landByTrain(item: BacklogItem, base: string, batch: boolean, localWhy: string | undefined): Promise<MergeEnd | undefined> {
    const root = this.deps.mainRoot;
    await this.changeQueue((q) => enqueue(q, [item.id]));
    const train = await this.currentTrain();
    const target = train && landing(train, item.id);
    if (!target) return undefined;
    const ahead = target.lands.slice(0, -1).map((e) => e.id);
    if (ahead.length && !batch) {
      const all = `Land ${target.lands.length}`;
      const choice = await vscode.window.showWarningMessage(
        `Merging ${item.id} lands ${ahead.join(', ')} too: ${ahead.length === 1 ? "it's" : "they're"} ahead of it in the merge queue.`,
        {
          modal: true,
          detail: `${all}: ${base} moves to each one's merge commit in the merge train, in order, after its checks. Merge ${item.id} Alone: it's merged onto ${base} as it is now, ahead of the queue.`,
        },
        all,
        `Merge ${item.id} Alone`,
      );
      if (!choice) return 'stopped';
      if (choice !== all) return undefined;
    }
    for (const e of target.lands) {
      const it = e.id === item.id ? item : await this.item(e.id);
      if (!it || (e.id !== item.id && !readyToMerge(it))) {
        void vscode.window.showWarningMessage(`${e.id} isn't ready to merge any more: the merge queue stopped before it.`);
        await this.currentTrain();
        return 'stopped';
      }
      if (e.contained) {
        // Its commits came in with a ticket ahead of it: nothing of its own to merge.
        await this.finish(it, { base, branch: e.branch, commit: e.commit!, already: true });
        continue;
      }
      const baseTip = (await runGit(['rev-parse', `refs/heads/${base}`], { cwd: root })).trim();
      const dir = this.mergeDir(e.id);
      await fs.promises.mkdir(path.dirname(dir), { recursive: true });
      await runGit(['worktree', 'add', '--detach', dir, e.commit!], { cwd: root, timeoutMs: 120_000 });
      this.deps.output.appendLine(`Merge: ${e.id} lands from the merge train (${e.commit!.slice(0, 7)} onto ${base} ${baseTip.slice(0, 7)}).`);
      const end = await this.complete(it, { dir, branch: e.branch, base, baseTip, commit: e.commit!, localWhy }, batch);
      if (end !== 'merged') {
        await this.currentTrain().catch(() => undefined);
        return end;
      }
    }
    // What's left of the train sits on the new main already: it's kept, without the landed tickets.
    const landed = target.lands.map((e) => e.id);
    await this.deps.backlog.change(
      (d) => ({
        ...d,
        mergeQueue: dequeue(d.mergeQueue, landed),
        ...(d.mergeTrain ? { mergeTrain: { ...d.mergeTrain, baseTip: target.commit, entries: d.mergeTrain.entries.filter((e) => !landed.includes(e.id)) } } : {}),
      }),
      { by: 'Flotilla' },
    );
    await this.readQueue();
    return 'merged';
  }

  /** Why the ticket's last Merge to main stopped on CI, while its branch is at the tip it stopped on (BL-112). */
  ciStop(id: string, tipOf: (branch: string) => string | undefined): CiStop | undefined {
    const stop = this.ciStops.get(id);
    if (!stop || this.merging.has(id) || this.ciWaits.has(id)) return undefined;
    const tip = tipOf(stop.branch);
    return tip === undefined || tip === stop.tip ? stop : undefined;
  }

  /** Fix with Agent on the red CI Merge to main stopped on: its first failed job. */
  async fixCiStop(id: string): Promise<void> {
    const stop = this.ciStops.get(id);
    if (stop?.kind !== 'failed') return;
    const first = stop.jobs[0];
    await this.deps.fixCi?.(stop.branch, first?.runId ?? stop.runs[0].id, first?.jobId);
  }

  /** One at a time: merges move the base branch. what: what the task does, for those waiting behind it. */
  private serial<T>(what: { id?: string; what: string }, task: () => Promise<T>): Promise<T> {
    this.tasks.push(what);
    this.changed.fire();
    const run = () =>
      task().finally(() => {
        this.tasks.splice(this.tasks.indexOf(what), 1);
        this.changed.fire();
      });
    const next = this.queue.then(run, run);
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
    if (this.tasks.length) this.deps.output.appendLine(`Merge: ${id} waits for ${this.tasks[0].what}.`);
    this.merging.add(id);
    return this.serial({ id, what: `${id}'s merge` }, () => trackProgress('backlog', `Merging ${id}`, () => this.doMerge(id, !!o.batch))).finally(() => {
      this.merging.delete(id);
      this.changed.fire();
    });
  }

  private async doMerge(id: string, batch: boolean): Promise<MergeEnd> {
    const item = await this.item(id);
    if (!item) return 'stopped';
    if (this.ciWaits.has(id)) {
      if (!batch) void vscode.window.showInformationMessage(`${id} merges when CI passes: its ticket shows the runs.`);
      return 'waiting';
    }
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
      // Not awaited: an unanswered notification would hold up every merge after it (BL-101). Move to Done is a step of its own.
      if (!batch)
        void vscode.window
          .showInformationMessage(`${base} has all of ${branch}'s commits already: there's nothing to merge.`, 'Move to Done')
          .then((c) => c && this.moveToDone(id, { base, branch, commit: check.baseTip }))
          .then(undefined, showError);
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
    const byTrain = await this.landsByTrain();
    if (byTrain) {
      const end = await this.landByTrain(item, base, batch, byTrain.localWhy);
      if (end) return end;
    }
    const ci = await this.decideCi(item, branch, check);
    const stop = ciStop(ci, branch, base);
    if (stop) this.ciStops.set(id, stop);
    else this.ciStops.delete(id);
    if (ci.kind === 'moved') {
      await this.note(
        id,
        `Not merged: \`${base}\` has moved on since \`${branch}\` took it in, so CI checked another tree than the merge's. Update from Main merges it into the branch, which is pushed, and CI runs again; then Merge to main.`,
      );
      if (!batch)
        void vscode.window
          .showWarningMessage(`${base} has moved on since ${branch} took it in: CI's result isn't for the merge. Update from Main, then merge when CI passes.`, 'Update from Main')
          .then((c) => (c ? this.deps.updateFromMain?.(id) : undefined))
          .then(undefined, showError);
      return 'stopped';
    }
    if (ci.kind === 'failed') {
      await this.note(id, failedNote(ci, branch));
      if (!batch) {
        this.deps.openTicket(id);
        const first = ci.jobs[0];
        void vscode.window
          .showWarningMessage(`CI failed on ${branch}: ${id} wasn't merged.`, ...(this.deps.fixCi ? ['Fix with Agent'] : []))
          .then((c) => (c ? this.deps.fixCi?.(branch, first?.run.id ?? ci.runs[0].id, first?.job.id) : undefined))
          .then(undefined, showError);
      }
      return 'stopped';
    }
    if (ci.kind === 'running') {
      await this.waitForCi(id, { branch, tip: ci.tip, baseTip: check.baseTip, batch, runs: ci.runs });
      return 'waiting';
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
    const onCi = ci.kind === 'passed' ? { ci } : { localWhy: ci.why };
    return this.complete(item, { dir, branch, base, baseTip: check.baseTip, commit: outcome.commit, ...onCi }, batch);
  }

  /** What the merge decides on (BL-105): CI's result for the branch's pushed tip, or the local checks. */
  private async decideCi(item: BacklogItem, branch: string, check: { tip: string; baseTip: string }): Promise<CiDecision> {
    const setting = settings().get<MergeChecks>('merge.checks', 'ci') === 'local' ? 'local' : 'ci';
    if (setting === 'local') return { kind: 'local' };
    const reader = this.deps.ciReader
      ? await this.deps.ciReader().catch((e: unknown) => `GitHub couldn't be read: ${e instanceof Error ? e.message : String(e)}`)
      : "this window doesn't read GitHub's runs.";
    const pushed = item.pushed?.find((p) => p.branch === branch && p.commit === check.tip);
    return decideCi({ cwd: this.deps.mainRoot, setting, branch, tip: check.tip, baseTip: check.baseTip, reader, pushError: pushed?.error });
  }

  /** The merge waits for CI, outside the queue: its runs are read every few seconds, and it merges once they've ended. */
  private async waitForCi(id: string, wait: CiWait): Promise<void> {
    const known = this.ciWaits.get(id);
    if (known) clearTimeout(known.timer);
    this.ciWaits.set(id, wait);
    wait.timer = setTimeout(() => void this.pollCi(id, wait).catch(showError), this.deps.ciPollMs ?? CI_POLL_MS);
    this.changed.fire();
    if (known !== wait) await this.note(id, waitingNote(wait, wait.branch));
  }

  private async pollCi(id: string, wait: CiWait): Promise<void> {
    if (this.ciWaits.get(id) !== wait) return;
    const root = this.deps.mainRoot;
    const item = await this.item(id);
    const tip = (await runGit(['rev-parse', `refs/heads/${wait.branch}`], { cwd: root }).catch(() => '')).trim();
    const base = await this.baseBranch().catch(() => undefined);
    const baseTip = base && (await runGit(['rev-parse', `refs/heads/${base}`], { cwd: root }).catch(() => '')).trim();
    // The same commits as when it was asked: CI's result decides; anything that moved is decided again by Merge to main.
    const ci = item && tip === wait.tip && baseTip === wait.baseTip ? await this.decideCi(item, wait.branch, { tip, baseTip }).catch(() => undefined) : undefined;
    if (this.ciWaits.get(id) !== wait) return;
    if (ci?.kind === 'running') {
      wait.runs = ci.runs;
      await this.waitForCi(id, wait);
      return;
    }
    this.ciWaits.delete(id);
    this.changed.fire();
    if (!item || !readyToMerge(item)) {
      if (item) await this.note(id, `Stopped waiting for CI: ${id} isn't ready to merge any more. Nothing was merged.`);
      return;
    }
    await this.merge(id, { batch: wait.batch });
  }

  /** Cancels a merge waiting for CI: nothing is merged. */
  async cancelCiWait(id: string): Promise<void> {
    const wait = this.ciWaits.get(id);
    if (!wait) return;
    clearTimeout(wait.timer);
    this.ciWaits.delete(id);
    this.changed.fire();
    await this.note(id, `You cancelled the merge of \`${wait.branch}\` waiting for CI. Nothing was merged.`);
  }

  /**
   * After the merge commit: the checks, then the fast-forward and the ticket to Done. Failing checks keep the merge
   * (in its worktree, for an agent to fix or the user to cancel) with nothing changed; anything else that stops it
   * keeps only a resolved merge, for another try.
   */
  private async complete(
    item: BacklogItem,
    m: {
      dir: string;
      branch: string;
      base: string;
      baseTip: string;
      commit: string;
      merge?: string;
      fixes?: readonly string[];
      resolved?: boolean;
      /** CI passed on the merge's tree (BL-105): nothing runs locally. */
      ci?: { tip: string; runs: CiRun[] };
      /** Why CI wasn't used, when it wasn't for want of it. */
      localWhy?: string;
      /** The checks run again on the merge as it is (BL-124): the failure they ran again after. */
      earlier?: NonNullable<MergeState['checks']>;
      /** Made again onto the base, which had moved (BL-149): moving again, it isn't made again a second time. */
      remerged?: boolean;
    },
    batch: boolean,
  ): Promise<MergeEnd> {
    const keep = async (reason: string) => {
      if (m.resolved) {
        const current = (await this.item(item.id))?.merging;
        if (current) await this.setMerge(item.id, { ...current, state: 'failed', reason, checks: undefined });
      } else await this.removeDir(m.dir);
    };
    const command = m.ci ? undefined : await checkCommand(m.dir, settings().get<string>('merge.checkCommand', ''));
    const noCi = m.localWhy ? ` CI wasn't used: ${m.localWhy}` : '';
    if (command) {
      const source = this.worktreeOn(m.base)?.worktree.path ?? this.deps.mainRoot;
      await linkDependencies(m.dir, source).catch((e: unknown) => this.deps.output.appendLine(`Merge: no node_modules link: ${String(e)}`));
      const title = `Checks: merge ${item.id} into ${m.base}`;
      const run = () => runChecks(m.dir, command, title).catch((e: unknown) => ({ passed: false, output: e instanceof Error ? e.message : String(e), timeouts: 0 }));
      let checks = await run();
      let earlier = m.earlier;
      if (!checks.passed && checks.timeouts && !earlier) {
        // Only timeouts: often a loaded machine, not the merge. Once more, before an agent looks at it (BL-124).
        earlier = { command, output: checks.output, at: new Date().toISOString() };
        await this.note(item.id, `The checks failed on the merge only with timeouts (${plural(checks.timeouts, 'test')} timed out): running them once more before stopping.`);
        checks = await run();
      }
      if (checks.passed && earlier) {
        await this.note(item.id, `The checks passed when they were run again: the earlier failure was ${earlierFailure(earlier)}.`);
      }
      if (!checks.passed) {
        // Kept: each side passed alone, so it's the two together; an agent can fix that on the merge.
        const current = (await this.item(item.id))?.merging;
        const state: MergeState = {
          ...(current ?? { dir: m.dir, branch: m.branch, base: m.base, baseTip: m.baseTip, started: new Date().toISOString() }),
          state: 'failed',
          reason: `the checks failed (\`${command}\`).`,
          checks: { command, output: checks.output, at: new Date().toISOString() },
        };
        await this.setMerge(item.id, state);
        const again = m.resolved || earlier ? ' again' : '';
        await this.note(
          item.id,
          `Merging \`${m.branch}\` into \`${m.base}\` stopped: the checks failed${again} on the merge (\`${command}\`; their output is in the terminal "${title}"). Nothing changed: the merge is kept in a temporary worktree. Fix with Agent, or cancel it.${noCi}`,
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
    this.finishing.add(item.id);
    try {
      try {
        await fastForward(this.deps.mainRoot, { base: m.base, baseTip: m.baseTip, commit: m.commit, worktree: holder?.worktree.path, message: mergeMessage(item) });
      } catch (error) {
        // The base moved during the checks: a resolved merge is made again onto it, once (BL-149).
        const now = await this.tip(m.base);
        const current = m.resolved && !m.remerged ? (await this.item(item.id))?.merging : undefined;
        if (current && !current.train && now && now !== m.baseTip) {
          return await this.mergeOntoMoved(item, current, { onto: m.baseTip, merge: m.merge ?? m.commit, commit: m.commit }, now, batch);
        }
        const why = error instanceof Error ? error.message : String(error);
        await keep(why);
        await this.note(item.id, `Merging \`${m.branch}\` into \`${m.base}\` stopped: ${why}`);
        void vscode.window.showErrorMessage(`${item.id} wasn't merged: ${why}`);
        return 'stopped';
      }
      await this.removeDir(m.dir);
      await this.finish(item, { base: m.base, branch: m.branch, commit: m.commit, merge: m.merge, fixes: m.fixes, checks: command, ci: m.ci, localWhy: m.localWhy });
      return 'merged';
    } finally {
      this.finishing.delete(item.id);
    }
  }

  /** Moves a ticket whose branch main has already to Done (asked after its merge ended), unless that changed since. */
  private moveToDone(id: string, m: { base: string; branch: string; commit: string }): Promise<void> {
    return this.serial({ id, what: `moving ${id} to Done` }, async () => {
      const item = await this.item(id);
      if (item && item.status !== 'done' && !item.merging) await this.finish(item, { ...m, already: true });
    });
  }

  /** The ticket to Done, saying what was merged; then Push and the worktree's clean-up are offered. */
  private async finish(
    item: BacklogItem,
    m: {
      base: string;
      branch: string;
      commit: string;
      merge?: string;
      fixes?: readonly string[];
      checks?: string;
      already?: boolean;
      ci?: { tip: string; runs: CiRun[] };
      localWhy?: string;
    },
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
        : `Merged \`${m.branch}\` into \`${m.base}\`: ${count} commit${count === 1 ? '' : 's'}, merge commit ${merge.slice(0, 7)} ("${mergeMessage(item)}").${fixes}${m.ci ? ` ${passedNote(m.ci)}` : m.checks ? ` The checks passed (\`${m.checks}\`).` : ' No checks ran (set flotilla.merge.checkCommand).'}${m.localWhy ? ` CI wasn't used: ${m.localWhy}` : ''} Nothing was pushed.`,
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
    const job = { what: 'Merge All Ready' };
    return this.serial(job, async () => {
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
      // The queue's order first (BL-140), then the others, dependencies first; they all join the queue.
      const queued = queuedItems({ items: ready, mergeQueue: (await this.deps.backlog.read()).mergeQueue });
      const order = [...queued, ...mergeOrder(ready.filter((i) => !queued.includes(i)), (a, b) => !!ancestor.get(`${a.id} ${b.id}`))];
      await this.changeQueue((q) => enqueue(q, order.map((i) => i.id)));
      const merged: string[] = [];
      // By the train, a ticket that conflicts with the ones ahead of it waits, and the others go on (BL-140).
      const train = (await this.landsByTrain()) ? await this.currentTrain() : undefined;
      const waiting = order.filter((i) => train?.entries.find((e) => e.id === i.id)?.conflicts).map((i) => i.id);
      for (const item of order) {
        if (waiting.includes(item.id) || (await this.item(item.id))?.status === 'done') continue;
        job.what = `${item.id}'s merge (Merge All Ready)`;
        this.changed.fire();
        const end = await trackProgress('backlog', `Merging ${item.id}`, () => this.doMerge(item.id, true));
        // Waiting for CI holds up none of the others: it merges when CI passes.
        if (end === 'waiting') continue;
        if (end !== 'merged') {
          void vscode.window.showWarningMessage(
            `Merge All Ready stopped at ${item.id}${merged.length ? `, after merging ${merged.join(', ')}` : ''}: it needs you. Its ticket says why.`,
            'Open',
          ).then((c) => c && this.deps.openTicket(item.id));
          return;
        }
        merged.push(item.id);
      }
      if (waiting.length)
        void vscode.window.showWarningMessage(
          `Merge All Ready ${merged.length ? `merged ${merged.join(', ')}` : 'merged nothing'}. ${waiting.join(', ')} ${waiting.length === 1 ? 'waits: it conflicts' : 'wait: they conflict'} with the tickets ahead in the merge queue. Resolve with Agent in its ticket resolves them in the train; Merge to main merges one onto ${base} as it is.`,
          'Open',
        ).then((c) => c && this.deps.openTicket(waiting[0]));
    });
  }

  /**
   * A queued ticket that conflicts with the tickets ahead of it in the train (BL-146): its merge in the train is made
   * in a temporary worktree at the train's commit before it, for an agent to resolve. Its branch isn't changed; the
   * tickets behind it are merged as if it weren't there until you approve.
   */
  resolveTrainConflict(id: string): Promise<void> {
    return this.serial({ id, what: `${id}'s merge in the merge train` }, async () => {
      const item = await this.item(id);
      if (!item || item.merging) return this.startResolver(id);
      const base = await this.baseBranch();
      const train = await this.currentTrain();
      const entry = train?.entries.find((e) => e.id === id);
      const onto = train && trainOnto(train, id);
      if (!base || !entry?.conflicts || !onto) {
        void vscode.window.showInformationMessage(`${id} doesn't conflict with the tickets ahead of it in the merge queue (any more).`);
        return;
      }
      const dir = this.mergeDir(id);
      await fs.promises.mkdir(path.dirname(dir), { recursive: true });
      const files = await startTrainMerge(this.deps.mainRoot, { dir, onto: onto.commit, branch: entry.branch, message: mergeMessage(item) });
      if (!files.length) {
        void vscode.window.showInformationMessage(`${id}'s merge in the merge train has no conflicts now: the train is rebuilt.`);
        await this.currentTrain({ rebuild: true });
        return;
      }
      this.deps.output.appendLine(`Merge: ${id}'s merge in the merge train (onto ${[base, ...onto.ahead].join(' + ')}, ${onto.commit.slice(0, 7)}) in ${dir}.`);
      await this.setMerge(id, { dir, branch: entry.branch, base, baseTip: onto.commit, train: { ahead: onto.ahead }, state: 'failed', reason: conflictsReason(files), started: new Date().toISOString() });
      await this.startResolver(id);
      await this.readQueue();
    });
  }

  /** Starts (or starts again) an agent resolving a merge's conflicts in its worktree. */
  resolveWithAgent(id: string): Promise<void> {
    return this.serial({ id, what: `${id}'s merge` }, () => this.startResolver(id));
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
    // Stopped because the base moved (BL-149): it's made again onto the base as it is now.
    const moved = !files.length && !failedChecks && !m.train && (await this.tip(m.base)) !== m.baseTip;
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
    // A merge in the train goes onto the base and the tickets ahead of it there (BL-146).
    const onto = m.train ? [m.base, ...m.train.ahead].join(' + ') : m.base;
    const common = { item, agent, ticket: this.deps.backlog.docPath(id), branch: m.branch, base: onto, start, description: (await this.deps.backlog.readTicket(item)).description, ours, others };
    const prompt = [
      agentLead(item, agent),
      failedChecks
        ? fixChecksPrompt({ ...common, checks: failedChecks })
        : resolvePrompt({ ...common, files, theirs, checks, ...(files.length ? {} : { problem: m.reason, moved }) }),
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
    const result = await mergeResult(m.dir, m.baseTip, id, redoOf(m)).catch((e: unknown) => ({ problem: e instanceof Error ? e.message : String(e) }));
    if ('problem' in result) {
      const reason = `${agent} stopped before the merge was ${m.checks ? 'fixed' : 'resolved'}: ${result.problem}${error ? ` (${error.slice(0, 200)})` : ''}`;
      await this.setMerge(id, { ...m, state: 'failed', reason });
      await this.note(id, `${reason} ${again} again, or cancel the merge.`);
      void vscode.window.showWarningMessage(`The merge of ${id} isn't ${m.checks ? 'fixed' : 'resolved'}: ${result.problem}`, 'Open').then((c) => c && this.deps.openTicket(id));
      return;
    }
    if (m.checks && result.commit === m.from) {
      // No fix committed: the checks may pass as the merge is (the failure was the machine's), so they run again (BL-124).
      await this.setMerge(id, { ...m, state: 'failed', reason: `${agent} committed no fix: the checks run again on the merge as it is.` });
      await this.note(id, `${agent} committed no fix: running the checks again on the merge as it is.`);
      if ((await this.recheck(id, true).catch(() => 'stopped' as const)) === 'merged') return;
      // Still failing: it asks something in the ticket (a design conflict), or it gave up; its report says which.
      const now = (await this.item(id))?.merging;
      if (!now || now.state !== 'failed') return;
      const reason = `${agent} committed no fix, and the checks still fail: its report says why (it may ask you something). Answer there, then ${again} again; or cancel the merge.`;
      await this.setMerge(id, { ...now, reason });
      void vscode.window.showWarningMessage(`${agent} didn't fix the checks on the merge of ${id}: its report in the ticket says why.`, 'Open').then((c) => c && this.deps.openTicket(id));
      return;
    }
    // A merge the agent made again onto the base as it is now: its base is that (BL-149).
    await this.setMerge(id, { ...m, baseTip: result.onto, state: 'resolved', reason: undefined });
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
    return this.serial({ id, what: `${id}'s merge` }, () =>
      trackProgress('backlog', `Merging ${id}`, async () => {
        const item = await this.item(id);
        const m = item?.merging;
        if (!item || !m || this.runs.has(id)) return 'stopped';
        if (!isMergeDir(m.dir, os.tmpdir())) throw new Error(`${id}'s merge isn't in a temporary merge worktree; cancel it.`);
        const result = await mergeResult(m.dir, m.baseTip, id, redoOf(m));
        if ('problem' in result) {
          await this.setMerge(id, { ...m, state: 'failed', reason: `the merge isn't ${m.checks ? 'fixed' : 'resolved'}: ${result.problem}` });
          void vscode.window.showWarningMessage(`The merge of ${id} isn't ${m.checks ? 'fixed' : 'resolved'}: ${result.problem}`);
          return 'stopped';
        }
        if (m.train) return this.landResolved(item, m, result.merge);
        await this.note(id, m.checks ? `You approved the fix of the checks on the merge.` : `You approved the resolution of the merge's conflicts.`);
        const now = await this.tip(m.base);
        if (now && now !== result.onto) return this.mergeOntoMoved(item, m, result, now, false);
        return this.complete(
          item,
          { dir: m.dir, branch: m.branch, base: m.base, baseTip: result.onto, commit: result.commit, merge: result.merge, fixes: result.fixes, resolved: true },
          false,
        );
      }),
    );
  }

  /**
   * An approved resolution of a merge in the train (BL-146): recorded (rerere), the train rebuilt with it, and the
   * ticket landed from the train, as Merge to main does. Runs inside a task.
   */
  private async landResolved(item: BacklogItem, m: MergeState, merge: string): Promise<MergeEnd> {
    const files = await recordResolution(m.dir, { onto: m.baseTip, tip: `refs/heads/${m.branch}`, resolved: merge, message: mergeMessage(item) });
    await this.removeDir(m.dir);
    await this.setMerge(item.id, undefined);
    const onto = [m.base, ...(m.train?.ahead ?? [])].join(' + ');
    await this.note(
      item.id,
      `You approved the resolution of its merge onto ${onto} in the merge train: it's recorded (${files.map((f) => `\`${f}\``).join(', ') || 'no conflicts to record'}), so the train reuses it when it's rebuilt. \`${m.branch}\` wasn't changed.`,
    );
    const train = await this.currentTrain({ rebuild: true });
    const entry = train?.entries.find((e) => e.id === item.id);
    if (!entry?.commit) {
      await this.note(item.id, `The merge train still doesn't take it: ${(train && trainState(train, item.id)) ?? "it isn't in the merge queue."} Resolve with Agent again, or Merge to main merges it onto ${m.base} as it is.`);
      return 'stopped';
    }
    return this.doMerge(item.id, false);
  }

  /**
   * A resolved merge whose base moved since it was made (BL-149): made again onto the base's tip (now) in its worktree,
   * keeping its resolution and fixes. Clean, the checks run and the base moves to it, as on approval; conflicts the
   * resolution doesn't cover go to an agent. Runs inside a task.
   */
  private async mergeOntoMoved(item: BacklogItem, m: MergeState, done: { onto: string; merge: string; commit: string }, now: string, batch: boolean): Promise<MergeEnd> {
    const was = `it was at ${done.onto.slice(0, 7)}, it's at ${now.slice(0, 7)}`;
    this.deps.output.appendLine(`Merge: ${item.id}'s merge again onto ${m.base} ${now.slice(0, 7)} (${was}).`);
    const outcome = await mergeAgain(m.dir, { from: done.onto, onto: now, merge: done.merge, commit: done.commit, message: mergeMessage(item) });
    if (outcome.kind === 'conflicts') {
      await this.setMerge(item.id, { ...m, baseTip: now, state: 'failed', reason: conflictsReason(outcome.files), checks: undefined, from: undefined });
      await this.note(
        item.id,
        `\`${m.base}\` moved since the merge was made (${was}): merging \`${m.branch}\` again onto it conflicts anew, in ${outcome.files.map((f) => `\`${f}\``).join(', ')}, which the resolution already made doesn't cover. An agent resolves those.`,
      );
      await this.startResolver(item.id);
      return 'stopped';
    }
    const skipped = outcome.skipped.length ? ` These fixes on top of it don't apply onto the new merge and were left out: ${outcome.skipped.map((f) => `"${f}"`).join(', ')}.` : '';
    await this.note(item.id, `\`${m.base}\` moved since the merge was made (${was}): \`${m.branch}\` is merged again onto it, with the resolution already made.${skipped}`);
    await this.setMerge(item.id, { ...m, baseTip: now, state: 'resolved', reason: undefined, checks: undefined, from: undefined });
    const fixes = await mergeResult(m.dir, now, item.id).then((r) => ('problem' in r ? [] : r.fixes));
    return this.complete(
      item,
      { dir: m.dir, branch: m.branch, base: m.base, baseTip: now, commit: outcome.commit, merge: outcome.merge, fixes, resolved: true, remerged: true },
      batch,
    );
  }

  /** Where a local branch is now; undefined if it isn't there. */
  private async tip(branch: string): Promise<string | undefined> {
    return (await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: this.deps.mainRoot }).catch(() => '')).trim() || undefined;
  }

  /**
   * Runs the failed checks again on the merge as it is (BL-124): Run the Checks Again, or after an agent found nothing
   * to fix. Passing, the base moves to the merge; failing, it stays failed with the new output.
   */
  recheck(id: string, quiet = false): Promise<MergeEnd> {
    return this.serial({ id, what: `${id}'s merge` }, () =>
      trackProgress('backlog', `Merging ${id}`, async () => {
        const item = await this.item(id);
        const m = item?.merging;
        if (!item || !m?.checks || m.state === 'resolving' || this.runs.has(id)) return 'stopped';
        if (!isMergeDir(m.dir, os.tmpdir())) throw new Error(`${id}'s merge isn't in a temporary merge worktree; cancel it.`);
        const result = await mergeResult(m.dir, m.baseTip, id, redoOf(m));
        if ('problem' in result) {
          await this.setMerge(id, { ...m, state: 'failed', reason: `the merge isn't fixed: ${result.problem}` });
          void vscode.window.showWarningMessage(`The merge of ${id} isn't fixed: ${result.problem}`);
          return 'stopped';
        }
        const now = await this.tip(m.base);
        if (!m.train && now && now !== result.onto) return this.mergeOntoMoved(item, m, result, now, quiet);
        return this.complete(
          item,
          { dir: m.dir, branch: m.branch, base: m.base, baseTip: result.onto, commit: result.commit, merge: result.merge, fixes: result.fixes, resolved: true, earlier: m.checks },
          quiet,
        );
      }),
    );
  }

  /** Cancels a merge waiting for a decision: its agent stops, its worktree goes; nothing changes. */
  cancel(id: string): Promise<void> {
    return this.serial({ id, what: `cancelling ${id}'s merge` }, async () => {
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

  /**
   * An item was approved, by the reviewer agent (its name) or the user (undefined): it joins the merge queue, and
   * flotilla.merge.onApprove says what follows. Resolves once it's in the queue.
   */
  approved(id: string, by: string | undefined): Promise<void> {
    // It joins the merge queue (BL-140); what follows doesn't wait for it.
    const queued = this.changeQueue((q) => enqueue(q, [id]))
      .then(() => this.queueChanged())
      .catch(showError);
    this.afterApproval(id, by);
    return queued;
  }

  private afterApproval(id: string, by: string | undefined): void {
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

function plural(n: number, what: string): string {
  return `${n} ${what}${n === 1 ? '' : 's'}`;
}

/** The failure the checks passed after, for the ticket: "8 tests timing out (Oct 19, 20:16)". */
function earlierFailure(earlier: NonNullable<MergeState['checks']>): string {
  const timeouts = timeoutsOnly(earlier.output);
  const when = earlier.at ? ` (${new Date(earlier.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })})` : '';
  return `${timeouts ? `${plural(timeouts, 'test')} timing out` : `\`${earlier.command}\` failing`}${when}, not the merge`;
}

/** What mergeResult takes as a merge made again onto the base (BL-149): not for a merge in the train, on its commit. */
function redoOf(m: MergeState): { base: string; branch: string } | undefined {
  return m.train ? undefined : { base: m.base, branch: m.branch };
}

function conflictsReason(files: readonly string[]): string {
  return `conflicts in ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}.`;
}

/**
 * Runs the checks in a terminal (a task), in dir: whether they passed, and their output (kept, so a failure can be
 * shown in the ticket and given to an agent). The command runs in a shell of its own, its output written to the
 * task's terminal as it comes; closing the terminal stops it (a failure).
 */
async function runChecks(dir: string, command: string, title: string): Promise<{ passed: boolean; output: string; timeouts: number }> {
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
  return { passed: code === 0, output: outputTail(output), timeouts: code === 0 ? 0 : timeoutsOnly(output) };
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

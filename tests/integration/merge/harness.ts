// The merge scenarios' world (BL-150): a temporary repository with real git, the real Merger and backlog, scripted
// agents and checks, and main moved by another merge when a scenario says. Each step records the ticket's merge state
// and next action, and fails on a step that leaves things as an earlier one did (a loop, not progress).
//
// A scenario file mocks 'vscode' with ./fakeVscode and the agent runner with fakeAgentRunner() before importing this.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect } from 'vitest';
import type { BacklogItem } from '../../../src/features/backlog/backlog';
import type { LocalBacklog } from '../../../src/features/backlog/localBacklog';
import { mergeActions, type MergeAction } from '../../../src/features/backlog/mergeStates';
import type { AgentRun } from '../../../src/ui/backlog/agentRunner';
import type { Merger } from '../../../src/ui/backlog/merge';
import {
  git,
  initRepo,
  makeTempDir,
  removeDir,
  writeFile,
} from '../../helpers/gitRepo';
import { fakeChecksEnv, resetUi, ui } from './fakeVscode';

/** The checks: they print what the scenario's next result says, and exit with it. */
export const FAKE_CHECKS = `node -e "const r = process.env.FLOTILLA_FAKE_CHECKS; console.log(r === 'timeout' ? ' FAIL  a.test.ts > slow\\n Test timed out in 30000ms.' : r === 'fail' ? 'FAIL a.test.ts: expected 1, got 2' : 'all passed'); process.exit(r === 'pass' ? 0 : 1)"`;

/**
 * What a fake agent does in the merge's worktree when it's started: resolve the conflicts and commit the merge; commit
 * a fix on top; commit nothing; merge the branch again onto main as it is now, resolving it; or crash (stop with an
 * error, having done nothing). 'later' works when the scenario says (World.agentEnds), or never: meanwhile main
 * moves, the window is reloaded, or the merge is cancelled.
 */
export type AgentScript = 'resolve' | 'fix' | 'nothing' | 'redoMerge' | 'crash';

const agents = {
  scripts: [] as Array<AgentScript | 'later'>,
  started: [] as Array<AgentScript | 'later'>,
  waiting: [] as Array<(script: AgentScript) => void>,
  repo: '',
};

/** The agent runner's mock: runAgentHeadless runs the next scripted agent. */
export function fakeRunAgentHeadless(o: { cwd: string; prompt: string }): AgentRun {
  const script = agents.scripts.shift();
  if (!script) throw new Error(`An agent was started, and the scenario has none scripted: ${o.prompt.slice(0, 120)}`);
  agents.started.push(script);
  // It works once it has been handed over: the merge's state says it's resolving first.
  const done = new Promise<{ error?: string }>((resolve) =>
    script === 'later' ? agents.waiting.push((s) => resolve(act(o.cwd, s))) : setTimeout(() => resolve(act(o.cwd, script)), 0),
  );
  return { sessionId: `session-${agents.started.length}`, done: done as AgentRun['done'], stop() {} };
}

function act(dir: string, script: AgentScript): { error?: string } {
  if (script === 'crash') return { error: 'the agent crashed' };
  if (script === 'nothing') return {};
  if (script === 'fix') {
    writeFile(dir, 'fix.txt', `fixed ${Date.now()}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', `${ticketOf(dir)}: Fix the checks on the merge`);
    return {};
  }
  if (script === 'redoMerge') {
    // As Jet-3 did for BL-111: the merge again, onto main as it is now, resolved.
    const midMerge = (() => {
      try {
        return git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD');
      } catch {
        return '';
      }
    })();
    const branch = midMerge || git(dir, 'rev-parse', 'HEAD^2');
    const message = `Merge ${ticketOf(dir)} again, onto main as it is now`;
    if (midMerge) git(dir, 'merge', '--abort');
    git(dir, 'reset', '-q', '--hard', git(agents.repo, 'rev-parse', 'main'));
    try {
      git(dir, 'merge', '-q', '--no-ff', '-m', message, branch);
    } catch {
      commitResolved(dir);
    }
    return {};
  }
  commitResolved(dir);
  return {};
}

/** Resolves every conflicted file by keeping both sides' lines, and commits the merge. */
function commitResolved(dir: string): void {
  const files = git(dir, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    writeFile(
      dir,
      file,
      text
        .split('\n')
        .filter((l) => !/^(<<<<<<<|=======|>>>>>>>)/.test(l))
        .join('\n'),
    );
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '--no-edit');
}

/** The ticket a merge's worktree is for, from its merge commit's message. */
function ticketOf(dir: string): string {
  return /-(BL-\d+)-[0-9a-f]+$/.exec(path.basename(dir))?.[1] ?? /[A-Z]+-\d+/.exec(git(dir, 'log', '-1', '--format=%s', '--merges'))?.[0] ?? 'BL-0';
}

const approved = (id: string): BacklogItem => ({
  id,
  title: `Item ${id}`,
  status: 'review',
  created: '',
  review: { round: 1, state: 'approved', reviewer: 'Rex-1' },
});

/** Where a ticket's merge is: its state (none, or merged), and what the ticket offers to click next. */
/** What a ticket offers to click: a merge's buttons, or Merge to main. */
export type Click = MergeAction | 'merge';

export interface Snapshot {
  main: string;
  status: string;
  state?: string;
  reason?: string;
  head?: string;
  actions: Click[];
  next?: Click;
}

export class World {
  readonly repo = initRepo();
  private readonly home = makeTempDir();
  private readonly dirs = [this.repo, this.home];
  backlog!: LocalBacklog;
  merger!: Merger;
  /** The afterResolver calls under way: an agent's end, which the scenario waits for. */
  private readonly ends = new Set<Promise<unknown>>();
  /** Each step's snapshot, by step. */
  readonly log: Array<{ step: string; snapshot: Snapshot }> = [];

  static async create(ids: string[]): Promise<World> {
    const world = new World();
    // The scenarios follow merge commits (merge-commit); fast-forward (BL-181) has its own tests in merger.test.ts.
    resetUi({ 'merge.checkCommand': FAKE_CHECKS, 'merge.style': 'merge-commit' });
    agents.scripts = [];
    agents.started = [];
    agents.waiting = [];
    agents.repo = world.repo;
    const { LocalBacklog } = await import('../../../src/features/backlog/localBacklog');
    world.backlog = new LocalBacklog(world.home, path.join(world.repo, '.git'));
    await world.backlog.change(() => ({ version: 1, next: 1, items: ids.map(approved) }));
    await world.reload();
    return world;
  }

  /** A new window: a new Merger on the same repository and backlog; the old one's agents are gone. */
  async reload(): Promise<void> {
    this.merger?.dispose();
    const { Merger } = await import('../../../src/ui/backlog/merge');
    const repository = { current: [{ key: 'main', worktree: { branch: 'main', path: this.repo, isMain: true }, chats: [] }] };
    const merger = new Merger({
      backlog: this.backlog,
      repository,
      mainRoot: this.repo,
      output: { appendLine() {} },
      openTicket() {},
      checksEnv: fakeChecksEnv,
    } as never);
    // An agent's end runs on its own (not in the merger's queue): the scenario waits for it.
    const own = merger as unknown as { afterResolver(...a: unknown[]): Promise<void> };
    const original = own.afterResolver.bind(merger);
    own.afterResolver = (...a: unknown[]) => {
      const p = original(...a).finally(() => this.ends.delete(p));
      this.ends.add(p);
      return p;
    };
    this.merger = merger;
  }

  dispose(): void {
    this.merger?.dispose();
    // Merge worktrees left in the temporary folder go with the repository's worktrees.
    for (const line of git(this.repo, 'worktree', 'list', '--porcelain').split('\n')) {
      const dir = line.startsWith('worktree ') ? line.slice(9) : undefined;
      if (dir && dir !== this.repo) removeDir(dir);
    }
    this.dirs.forEach(removeDir);
  }

  /** A ticket's branch, from main as it is, with a commit writing the files. */
  branch(id: string, files: Record<string, string>): void {
    const branch = `feature/${id}-work`;
    git(this.repo, 'branch', branch, 'main');
    git(this.repo, 'checkout', '-q', branch);
    for (const [file, content] of Object.entries(files)) writeFile(this.repo, file, content);
    git(this.repo, 'add', '.');
    git(this.repo, 'commit', '-q', '-m', `${id}: work`);
    git(this.repo, 'checkout', '-q', 'main');
  }

  /** Main moved by another merge (another window's, or a merge outside Flotilla): a ticket's branch merged in. */
  mainMoves(id: string, files: Record<string, string>): void {
    this.branch(id, files);
    git(this.repo, 'merge', '-q', '--no-ff', '-m', `Merge ${id}: elsewhere`, `feature/${id}-work`);
  }

  /** The next agents started do these, in order. */
  agents(...scripts: Array<AgentScript | 'later'>): void {
    agents.scripts.push(...scripts);
  }

  /** The agent started 'later' does this now, and ends. */
  agentEnds(id: string, script: AgentScript): Promise<Snapshot> {
    const end = agents.waiting.shift();
    if (!end) throw new Error('No agent is waiting to work.');
    return this.step(id, `the agent ends (${script})`, async () => end(script));
  }

  /** The next check runs end so, in order; then they pass. */
  checks(...results: Array<'pass' | 'fail' | 'timeout'>): void {
    ui.checks.push(...results);
  }

  /** The answer to the next question whose message matches. */
  answer(pattern: RegExp, answer: string): void {
    ui.rules.push({ pattern, answer });
  }

  get checkRuns(): number {
    return ui.checkRuns;
  }

  get started(): Array<AgentScript | 'later'> {
    return [...agents.started];
  }

  /** Main's history, oldest first: each commit's subject. */
  mainLog(): string[] {
    return git(this.repo, 'log', '--first-parent', '--reverse', '--format=%s', 'main').split('\n');
  }

  async item(id: string): Promise<BacklogItem> {
    return (await this.backlog.read()).items.find((i) => i.id === id)!;
  }

  /** Where a ticket's merge is now. */
  async snapshot(id: string): Promise<Snapshot> {
    const item = await this.item(id);
    const m = item.merging;
    const main = git(this.repo, 'rev-parse', 'main');
    if (!m) return { main, status: item.status, ...(item.status === 'done' ? { actions: [] } : { actions: ['merge'], next: 'merge' }) };
    const head = (() => {
      try {
        return git(m.dir, 'rev-parse', 'HEAD');
      } catch {
        return 'gone';
      }
    })();
    return { main, status: item.status, state: m.state, reason: m.reason, head, ...mergeActions(m, this.merger.isRunning(id)) };
  }

  /** Waits for the agents that ended to be taken in, and the merger's queue to empty. */
  async settle(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 5));
      if (this.ends.size) await Promise.all([...this.ends]);
      else if (!(this.merger as unknown as { tasks: unknown[] }).tasks.length) return;
    }
  }

  /**
   * A user's (or the autopilot's) action on a ticket, then whatever it set going: records where the ticket is after
   * it, and fails if that's where it was after an earlier step (a loop: the same state again, nothing moved on).
   */
  async step<T>(id: string, name: string, action: () => Promise<T>): Promise<Snapshot> {
    await action();
    await this.settle();
    const snapshot = await this.snapshot(id);
    const again = this.log.find((l) => JSON.stringify(l.snapshot) === JSON.stringify(snapshot));
    expect(again, `"${name}" left ${id} where "${again?.step}" did: ${JSON.stringify(snapshot)}`).toBeUndefined();
    this.log.push({ step: name, snapshot });
    return snapshot;
  }

  // The ticket's buttons, and the menu's Merge to main.
  merge = (id: string) => this.step(id, `Merge to main ${id}`, () => this.merger.merge(id));
  resolve = (id: string) => this.step(id, `Resolve with Agent ${id}`, () => this.merger.resolveWithAgent(id));
  approve = (id: string) => this.step(id, `Approve ${id}`, () => this.merger.approveResolution(id));
  recheck = (id: string) => this.step(id, `Run the Checks Again ${id}`, () => this.merger.recheck(id));
  cancel = (id: string) => this.step(id, `Cancel ${id}`, () => this.merger.cancel(id));
  pause = (id: string) => this.step(id, `Pause ${id}`, () => this.merger.pause(id));
  resume = (id: string) => this.step(id, `Resume ${id}`, () => this.merger.resolveWithAgent(id));

  /** Clicks what the ticket offers next, as a user who follows it would. */
  async next(id: string): Promise<Snapshot> {
    const { next } = await this.snapshot(id);
    expect(next, `${id} offers nothing to click`).toBeDefined();
    const click = {
      merge: this.merge,
      resolve: this.resolve,
      approve: this.approve,
      recheck: this.recheck,
      cancel: this.cancel,
      pause: this.pause,
      resume: this.resume,
    }[next!];
    return click(id);
  }
}

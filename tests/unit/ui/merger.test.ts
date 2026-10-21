import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BacklogItem } from '../../../src/features/backlog/backlog';
import type { LocalBacklog } from '../../../src/features/backlog/localBacklog';
import { git, initRepo, makeTempDir, removeDir, writeFile } from '../../helpers/gitRepo';

/** What the mocked VS Code answers and records. */
const ui = {
  answers: [] as Array<string | undefined>,
  messages: [] as string[],
  settings: {} as Record<string, unknown>,
  checksExit: 0,
  /** The exit codes of the next check runs, before checksExit. */
  checksExits: [] as number[],
  checksOut: '',
  checks: [] as string[],
};

vi.mock('vscode', () => {
  class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (l: (e: T) => void) => (this.listeners.push(l), { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) });
    fire(e: T) {
      [...this.listeners].forEach((l) => l(e));
    }
    dispose() {}
  }
  const ask = (message: string) => {
    ui.messages.push(message);
    return Promise.resolve(ui.answers.shift());
  };
  type Pty = { open(d: unknown): void; onDidClose: (l: (code: number) => void) => unknown };
  return {
    EventEmitter,
    window: { showInformationMessage: ask, showWarningMessage: ask, showErrorMessage: ask, showQuickPick: async () => undefined },
    workspace: { getConfiguration: () => ({ get: (k: string, d: unknown) => (k in ui.settings ? ui.settings[k] : d) }) },
    commands: { executeCommand: async () => undefined },
    Task: class {
      presentationOptions: unknown;
      constructor(
        readonly definition: { command: string },
        _s: unknown,
        _n: string,
        _src: string,
        readonly execution: { callback: () => Promise<Pty> },
      ) {}
    },
    CustomExecution: class {
      constructor(readonly callback: () => Promise<Pty>) {}
    },
    TaskScope: { Workspace: 2 },
    TaskRevealKind: { Always: 1 },
    TaskPanelKind: { Dedicated: 2 },
    // The terminal: the checks command really runs (CHECKS reads ui.checksExit from the environment).
    tasks: {
      executeTask: async (task: { definition: { command: string }; execution: { callback: () => Promise<Pty> } }) => {
        ui.checks.push(task.definition.command);
        process.env.FLOTILLA_TEST_CHECKS_EXIT = String(ui.checksExits.shift() ?? ui.checksExit);
        process.env.FLOTILLA_TEST_CHECKS_OUT = ui.checksOut;
        const pty = await task.execution.callback();
        pty.open(undefined);
        return {};
      },
    },
  };
});

/** The resolving agent: never started for real; the test does its work in the merge's worktree. */
const agents = { prompts: [] as string[] };
vi.mock('../../../src/ui/backlog/agentRunner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/ui/backlog/agentRunner')>()),
  runAgentHeadless: (o: { prompt: string }) => (agents.prompts.push(o.prompt), { sessionId: 'session', done: new Promise(() => undefined), stop() {} }),
}));

/** The checks: they print a failure and exit with ui.checksExit. */
const CHECKS = `node -e "console.log(process.env.FLOTILLA_TEST_CHECKS_OUT || 'FAIL a.test.ts: expected 1, got 2'); process.exit(Number(process.env.FLOTILLA_TEST_CHECKS_EXIT))"`;

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));
beforeEach(() => {
  ui.answers = [];
  ui.messages = [];
  ui.settings = { 'merge.checkCommand': CHECKS };
  ui.checksExit = 0;
  ui.checksExits = [];
  ui.checksOut = '';
  ui.checks = [];
});

function commit(repo: string, file: string, content: string, message: string): void {
  writeFile(repo, file, content);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', message);
}

const approved = (id: string, extra: Partial<BacklogItem> = {}): BacklogItem => ({
  id,
  title: `Item ${id}`,
  status: 'review',
  created: '',
  review: { round: 1, state: 'approved', reviewer: 'Rex-1' },
  ...extra,
});

/** The merger's private side, for what an agent's run ends with. */
type Private = { runs: Map<string, unknown>; afterResolver(id: string, run: unknown, error: string | undefined): Promise<void> };
const run = { stop() {} };

/** As if an agent started fixing the checks at HEAD from, and ended. */
async function agentDone(backlog: LocalBacklog, merger: unknown, id: string, from: string) {
  await backlog.change((d) => ({ ...d, items: d.items.map((i) => (i.id === id ? { ...i, merging: { ...i.merging!, state: 'resolving', agent: 'Ace-1', from } } : i)) }));
  (merger as Private).runs.set(id, run);
}

async function setup(items: BacklogItem[]) {
  const { LocalBacklog } = await import('../../../src/features/backlog/localBacklog');
  const { Merger } = await import('../../../src/ui/backlog/merge');
  const repo = initRepo();
  const home = makeTempDir();
  cleanup.push(repo, home);
  const backlog = new LocalBacklog(home, path.join(repo, '.git'));
  await backlog.change(() => ({ version: 1, next: 1, items }));
  const repository = { current: [{ key: 'main', worktree: { branch: 'main', path: repo, isMain: true }, chats: [] }] };
  const merger = new Merger({ backlog, repository, mainRoot: repo, output: { appendLine() {} }, openTicket() {} } as never);
  const item = async (id: string) => (await backlog.read()).items.find((i) => i.id === id)!;
  const worktrees = () => git(repo, 'worktree', 'list').split('\n').length;
  return { repo, backlog, merger, item, worktrees };
}

describe('Merge to main', () => {
  it('merges in a temporary worktree, runs the checks, fast-forwards main and moves the ticket to Done', async () => {
    const { repo, backlog, merger, item, worktrees } = await setup([approved('BL-1')]);
    git(repo, 'branch', 'feature/BL-1-one');
    git(repo, 'checkout', '-q', 'feature/BL-1-one');
    commit(repo, 'a.txt', 'a\n', 'BL-1: add a');
    git(repo, 'checkout', '-q', 'main');
    const before = git(repo, 'rev-parse', 'main');

    expect(await merger.merge('BL-1')).toBe('merged');

    expect(git(repo, 'log', '-1', '--format=%s', 'main')).toBe('Merge BL-1: Item BL-1');
    expect(git(repo, 'rev-parse', 'main^1')).toBe(before);
    // The main worktree has the merge's files, and nothing else is left.
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('a\n');
    expect(worktrees()).toBe(1);
    expect(ui.checks).toEqual([CHECKS]);
    const done = await item('BL-1');
    expect(done.status).toBe('done');
    expect(done.merged).toMatchObject({ into: 'main', commit: git(repo, 'rev-parse', 'main') });
    const activity = (await backlog.readTicket(done)).activity.map((e) => e.body).join('\n');
    expect(activity).toContain('Merged it into **main**');
    expect(activity).toContain('Merged `feature/BL-1-one` into `main`: 1 commit');
    expect(activity).toContain('Nothing was pushed.');
    merger.dispose();
  });

  it('keeps a clean merge whose checks fail, with their output, and changes nothing (BL-65)', async () => {
    const { repo, backlog, merger, item, worktrees } = await setup([approved('BL-1')]);
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 'a.txt', 'a\n', 'BL-1: add a');
    git(repo, 'checkout', '-q', 'main');
    const before = git(repo, 'rev-parse', 'main');
    ui.checksExit = 1;

    expect(await merger.merge('BL-1')).toBe('stopped');

    expect(git(repo, 'rev-parse', 'main')).toBe(before);
    const kept = await item('BL-1');
    expect(kept.status).toBe('review');
    expect(kept.merging).toMatchObject({ state: 'failed', branch: 'feature/BL-1', base: 'main', baseTip: before, checks: { command: CHECKS } });
    expect(kept.merging!.checks!.output).toContain('FAIL a.test.ts: expected 1, got 2');
    // The merge is there, in its temporary worktree.
    expect(worktrees()).toBe(2);
    expect(git(kept.merging!.dir, 'log', '-1', '--format=%s')).toBe('Merge BL-1: Item BL-1');
    expect((await backlog.readTicket(kept)).activity.map((e) => e.body).join('\n')).toContain('Fix with Agent, or cancel it');

    // Cancel: the worktree goes, nothing changed.
    await merger.cancel('BL-1');
    expect(worktrees()).toBe(1);
    expect((await item('BL-1')).merging).toBeUndefined();
    expect(git(repo, 'rev-parse', 'main')).toBe(before);
    merger.dispose();
  });

  it('merges with the fix committed on top, once approved and the checks pass (BL-65)', async () => {
    const { repo, backlog, merger, item, worktrees } = await setup([approved('BL-1')]);
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 'a.txt', 'a\n', 'BL-1: add a');
    git(repo, 'checkout', '-q', 'main');
    const before = git(repo, 'rev-parse', 'main');
    ui.checksExit = 1;
    await merger.merge('BL-1');
    const dir = (await item('BL-1')).merging!.dir;
    const merge = git(dir, 'rev-parse', 'HEAD');

    // What the agent does: a fix of its own, on the merge.
    commit(dir, 'fix.txt', 'fixed\n', 'BL-1: Fix the checks after merging main');
    ui.checksExit = 0;
    expect(await merger.approveResolution('BL-1')).toBe('merged');

    expect(git(repo, 'log', '-1', '--format=%s', 'main')).toBe('BL-1: Fix the checks after merging main');
    expect(git(repo, 'rev-parse', 'main^')).toBe(merge);
    expect(git(repo, 'rev-parse', 'main^^1')).toBe(before);
    expect(worktrees()).toBe(1);
    const done = await item('BL-1');
    expect(done.status).toBe('done');
    expect(done.merging).toBeUndefined();
    expect(done.merged).toMatchObject({ into: 'main', commit: git(repo, 'rev-parse', 'main') });
    const activity = (await backlog.readTicket(done)).activity.map((e) => e.body).join('\n');
    expect(activity).toContain(`merge commit ${merge.slice(0, 7)}`);
    expect(activity).toContain('the fix of the checks: "BL-1: Fix the checks after merging main"');
    merger.dispose();
  });

  it('merges again onto main when it moved before the approval, with no agent (BL-149)', async () => {
    const { repo, backlog, merger, item, worktrees } = await setup([approved('BL-1')]);
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 'a.txt', 'a\n', 'BL-1: add a');
    git(repo, 'checkout', '-q', 'main');
    ui.checksExit = 1;
    await merger.merge('BL-1');
    const dir = (await item('BL-1')).merging!.dir;
    commit(dir, 'fix.txt', 'fixed\n', 'BL-1: Fix the checks after merging main');
    // main moves while the fix waits for approval.
    commit(repo, 'b.txt', 'b\n', 'BL-2: add b');
    const moved = git(repo, 'rev-parse', 'main');
    ui.checksExit = 0;

    expect(await merger.approveResolution('BL-1')).toBe('merged');

    expect(git(repo, 'log', '-1', '--format=%s', 'main')).toBe('BL-1: Fix the checks after merging main');
    expect(git(repo, 'rev-parse', 'main^^1')).toBe(moved);
    expect(git(repo, 'rev-parse', 'main^^2')).toBe(git(repo, 'rev-parse', 'feature/BL-1'));
    expect(worktrees()).toBe(1);
    const done = await item('BL-1');
    expect(done.status).toBe('done');
    expect((await backlog.readTicket(done)).activity.map((e) => e.body).join('\n')).toContain('is merged again onto it');
    merger.dispose();
  });

  it("doesn't take a commit after the merge that isn't the ticket's fix (BL-65)", async () => {
    const { repo, merger, item } = await setup([approved('BL-1')]);
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 'a.txt', 'a\n', 'BL-1: add a');
    git(repo, 'checkout', '-q', 'main');
    const before = git(repo, 'rev-parse', 'main');
    ui.checksExit = 1;
    await merger.merge('BL-1');
    const dir = (await item('BL-1')).merging!.dir;
    commit(dir, 'fix.txt', 'fixed\n', 'tweak');
    ui.checksExit = 0;

    expect(await merger.approveResolution('BL-1')).toBe('stopped');

    expect(git(repo, 'rev-parse', 'main')).toBe(before);
    expect((await item('BL-1')).merging).toMatchObject({ state: 'failed', reason: expect.stringContaining("doesn't start with BL-1") });
    await merger.cancel('BL-1');
    merger.dispose();
  });

  it("merges when the fixing agent commits nothing and the checks pass when run again (BL-124)", async () => {
    const { repo, backlog, merger, item } = await setup([approved('BL-1')]);
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 'a.txt', 'a\n', 'BL-1: add a');
    git(repo, 'checkout', '-q', 'main');
    ui.checksExit = 1;
    await merger.merge('BL-1');
    const m = (await item('BL-1')).merging!;
    expect(m.checks!.at).toBeTruthy();
    const merge = git(m.dir, 'rev-parse', 'HEAD');
    // The agent ran, and committed nothing: the checks passed for it.
    await agentDone(backlog, merger, 'BL-1', merge);
    ui.checksExit = 0;
    await (merger as unknown as Private).afterResolver('BL-1', run, undefined);

    expect(git(repo, 'rev-parse', 'main')).toBe(merge);
    const done = await item('BL-1');
    expect(done.status).toBe('done');
    expect(done.merging).toBeUndefined();
    const activity = (await backlog.readTicket(done)).activity.map((e) => e.body).join('\n');
    expect(activity).toContain('committed no fix: running the checks again');
    expect(activity).toContain('The checks passed when they were run again: the earlier failure was');
    merger.dispose();
  });

  it('stays failed when the fixing agent commits nothing and the checks fail again (BL-124)', async () => {
    const { repo, backlog, merger, item } = await setup([approved('BL-1')]);
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 'a.txt', 'a\n', 'BL-1: add a');
    git(repo, 'checkout', '-q', 'main');
    const before = git(repo, 'rev-parse', 'main');
    ui.checksExit = 1;
    await merger.merge('BL-1');
    const m = (await item('BL-1')).merging!;
    await agentDone(backlog, merger, 'BL-1', git(m.dir, 'rev-parse', 'HEAD'));
    await (merger as unknown as Private).afterResolver('BL-1', run, undefined);

    expect(git(repo, 'rev-parse', 'main')).toBe(before);
    expect(ui.checks).toHaveLength(2);
    expect((await item('BL-1')).merging).toMatchObject({ state: 'failed', checks: { command: CHECKS }, reason: expect.stringContaining('committed no fix, and the checks still fail') });
    await merger.cancel('BL-1');
    merger.dispose();
  });

  it('runs a failure of only timeouts again once, before an agent is started (BL-124)', async () => {
    const { repo, backlog, merger, item } = await setup([approved('BL-1')]);
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 'a.txt', 'a\n', 'BL-1: add a');
    git(repo, 'checkout', '-q', 'main');
    ui.checksOut = ' FAIL  tests/a.test.ts > a\nError: Test timed out in 30000ms.';
    ui.checksExits = [1, 0];

    expect(await merger.merge('BL-1')).toBe('merged');

    expect(ui.checks).toHaveLength(2);
    const activity = (await backlog.readTicket(await item('BL-1'))).activity.map((e) => e.body).join('\n');
    expect(activity).toContain('only with timeouts (1 test timed out): running them once more');
    expect(activity).toContain('the earlier failure was 1 test timing out');
    merger.dispose();
  });

  it("doesn't run a failure with assertions again by itself; Run the Checks Again does (BL-124)", async () => {
    const { repo, merger, item } = await setup([approved('BL-1')]);
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 'a.txt', 'a\n', 'BL-1: add a');
    git(repo, 'checkout', '-q', 'main');
    ui.checksOut = 'Error: Test timed out in 30000ms.\nAssertionError: expected 1 to be 2';
    ui.checksExits = [1, 0];

    expect(await merger.merge('BL-1')).toBe('stopped');
    expect(ui.checks).toHaveLength(1);

    expect(await merger.recheck('BL-1')).toBe('merged');
    expect((await item('BL-1')).status).toBe('done');
    merger.dispose();
  });

  it('Merge All Ready stops at a ticket whose checks fail (BL-65)', async () => {
    const { repo, merger, item, worktrees } = await setup([approved('BL-1'), approved('BL-2')]);
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 'a.txt', 'a\n', 'BL-1: add a');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'checkout', '-q', '-b', 'feature/BL-2');
    commit(repo, 'b.txt', 'b\n', 'BL-2: add b');
    git(repo, 'checkout', '-q', 'main');
    const before = git(repo, 'rev-parse', 'main');
    ui.checksExit = 1;

    await merger.mergeAllReady();

    expect(git(repo, 'rev-parse', 'main')).toBe(before);
    expect(ui.checks).toHaveLength(1);
    expect(ui.messages.at(-1)).toMatch(/Merge All Ready stopped at BL-1/);
    expect((await item('BL-1')).merging?.checks).toBeDefined();
    expect((await item('BL-2')).merging).toBeUndefined();
    expect((await item('BL-2')).status).toBe('review');
    expect(worktrees()).toBe(2);
    await merger.cancel('BL-1');
    merger.dispose();
  });

  it("refuses a branch with commits of another ticket that isn't done", async () => {
    const { repo, merger, worktrees } = await setup([approved('BL-1'), { id: 'BL-2', title: 'Two', status: 'doing', created: '' }]);
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 'b.txt', 'b\n', 'BL-2: not done yet');
    commit(repo, 'a.txt', 'a\n', 'BL-1: add a');
    git(repo, 'checkout', '-q', 'main');
    const before = git(repo, 'rev-parse', 'main');

    expect(await merger.merge('BL-1')).toBe('stopped');

    expect(ui.messages[0]).toMatch(/can't be merged: it has commits of another ticket/);
    expect(git(repo, 'rev-parse', 'main')).toBe(before);
    expect(worktrees()).toBe(1);
    merger.dispose();
  });

  it('cancels a merge with conflicts: nothing changes', async () => {
    const { repo, merger, item, worktrees } = await setup([approved('BL-1')]);
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 'a.txt', 'one\n', 'BL-1: a');
    git(repo, 'checkout', '-q', 'main');
    commit(repo, 'a.txt', 'two\n', 'other: a');
    const before = git(repo, 'rev-parse', 'main');
    ui.answers = [undefined]; // Cancel

    expect(await merger.merge('BL-1')).toBe('stopped');

    expect(ui.messages[0]).toMatch(/has conflicts/);
    expect(git(repo, 'rev-parse', 'main')).toBe(before);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(worktrees()).toBe(1);
    expect((await item('BL-1')).merging).toBeUndefined();
    merger.dispose();
  });

  it("a Check's Clean Up fails a merge whose agent runs nowhere, and clears one whose worktree is gone (BL-163)", async () => {
    const merging = { dir: '/nowhere', branch: 'feature/BL-1', base: 'main', baseTip: 'abc', state: 'resolving' as const, agent: 'Nova-1', started: '' };
    const { merger, item } = await setup([{ ...approved('BL-1'), merging }]);
    expect(await merger.forCheck('BL-1', 'lost', 'Nova-1 stopped')).toBe(true);
    expect((await item('BL-1')).merging).toMatchObject({ state: 'failed', reason: 'Nova-1 stopped' });
    expect(await merger.forCheck('BL-1', 'lost', 'again')).toBe(false); // failed already: left as it is
    expect(await merger.forCheck('BL-1', 'gone', 'gone')).toBe(true);
    expect((await item('BL-1')).merging).toBeUndefined();
    merger.dispose();
  });

  it("doesn't move main under uncommitted changes in its worktree", async () => {
    const { repo, merger, worktrees } = await setup([approved('BL-1')]);
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 'a.txt', 'a\n', 'BL-1: add a');
    git(repo, 'checkout', '-q', 'main');
    writeFile(repo, 'README.md', 'edited\n');
    const before = git(repo, 'rev-parse', 'main');
    ui.answers = [undefined]; // not Try Again

    expect(await merger.merge('BL-1')).toBe('stopped');

    expect(ui.messages.at(-1)).toMatch(/uncommitted changes/);
    expect(git(repo, 'rev-parse', 'main')).toBe(before);
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('edited\n');
    expect(worktrees()).toBe(1);
    merger.dispose();
  });

  it("doesn't hold up the next merge behind an unanswered \"nothing to merge\" (BL-101)", async () => {
    const { repo, merger, item } = await setup([approved('BL-1'), approved('BL-2')]);
    git(repo, 'branch', 'feature/BL-1'); // nothing main lacks
    git(repo, 'checkout', '-q', '-b', 'feature/BL-2');
    commit(repo, 'b.txt', 'b\n', 'BL-2: add b');
    git(repo, 'checkout', '-q', 'main');
    let answer!: (choice: string | undefined) => void;
    const vscode = await import('vscode');
    const ask = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementationOnce(((message: string) => {
      ui.messages.push(message);
      return new Promise((resolve) => (answer = resolve)); // left in the notification center
    }) as never);

    const first = merger.merge('BL-1');
    const second = merger.merge('BL-2');
    expect(merger.mergeProgress('BL-2')).toEqual({ waitsFor: "BL-1's merge" });

    expect(await first).toBe('stopped');
    expect(ui.messages[0]).toMatch(/nothing to merge/);
    expect(await second).toBe('merged');
    expect((await item('BL-2')).status).toBe('done');
    expect(merger.mergeProgress('BL-1')).toBeUndefined();
    expect(merger.mergeProgress('BL-2')).toBeUndefined();

    // Answered later: Move to Done is a step of its own.
    answer('Move to Done');
    await vi.waitFor(async () => expect((await item('BL-1')).status).toBe('done'));
    ask.mockRestore();
    merger.dispose();
  });

  it('merges all ready tickets, dependencies first', async () => {
    // BL-2's branch is built on BL-1's (it carries BL-1's commits): BL-1 goes first, which unblocks BL-2.
    const { repo, merger, item } = await setup([approved('BL-2'), approved('BL-1')]);
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 'a.txt', 'a\n', 'BL-1: add a');
    git(repo, 'checkout', '-q', '-b', 'feature/BL-2');
    commit(repo, 'b.txt', 'b\n', 'BL-2: add b');
    git(repo, 'checkout', '-q', 'main');

    await merger.mergeAllReady();

    expect(git(repo, 'log', '--first-parent', '--format=%s', '-2', 'main').split('\n')).toEqual(['Merge BL-2: Item BL-2', 'Merge BL-1: Item BL-1']);
    expect((await item('BL-1')).status).toBe('done');
    expect((await item('BL-2')).status).toBe('done');
    merger.dispose();
  });
});

describe('The merge queue (BL-140)', () => {
  /** BL-1 adds a.txt; BL-2 and BL-3 change shared.txt's line (they conflict with each other, not with main). */
  function branches(repo: string): void {
    commit(repo, 'shared.txt', 'one\n', 'shared');
    for (const [id, file, content] of [
      ['BL-1', 'a.txt', 'a\n'],
      ['BL-2', 'shared.txt', 'two\n'],
      ['BL-3', 'shared.txt', 'three\n'],
    ]) {
      git(repo, 'checkout', '-q', '-b', `feature/${id}`, 'main');
      commit(repo, file, content, `${id}: change ${file}`);
    }
    git(repo, 'checkout', '-q', 'main');
  }

  it('lands the tickets ahead of one in order, each on the main the one before left, after its own checks', async () => {
    const { repo, backlog, merger, item } = await setup([approved('BL-1'), approved('BL-2')]);
    branches(repo);
    const before = git(repo, 'rev-parse', 'main');
    ui.settings['merge.onApprove'] = 'off';
    await merger.approved('BL-2', 'Rex-1');
    await merger.approved('BL-1', 'Rex-1');
    await merger.refreshTrain();
    expect((await backlog.read()).mergeQueue).toEqual(['BL-2', 'BL-1']);
    expect(merger.queuePlace('BL-1')).toEqual({ place: '2nd of 2', state: 'Merges cleanly onto main + BL-2.', ahead: ['BL-2'] });
    ui.answers = ['Land 2'];

    expect(await merger.merge('BL-1')).toBe('merged');

    expect(ui.messages).toContain('Merging BL-1 lands BL-2 too: it\'s ahead of it in the merge queue.');
    expect(git(repo, 'log', '--first-parent', '--format=%s', `${before}..main`).split('\n')).toEqual(['Merge BL-1: Item BL-1', 'Merge BL-2: Item BL-2']);
    expect(ui.checks).toEqual([CHECKS, CHECKS]);
    expect((await item('BL-1')).status).toBe('done');
    expect((await item('BL-2')).merged?.commit).toBe(git(repo, 'rev-parse', 'main^1'));
    expect((await backlog.read()).mergeQueue).toEqual([]);
    expect(merger.queuePlace('BL-1')).toBeUndefined();
    merger.dispose();
  });

  it('Merge All Ready lets a ticket that conflicts with the ones ahead wait, and lands the ones behind it', async () => {
    const { repo, backlog, merger, item } = await setup([approved('BL-2'), approved('BL-3'), approved('BL-1')]);
    branches(repo);

    await merger.mergeAllReady();

    expect(git(repo, 'log', '--first-parent', '--format=%s', '-2', 'main').split('\n')).toEqual(['Merge BL-1: Item BL-1', 'Merge BL-2: Item BL-2']);
    expect((await item('BL-3')).status).toBe('review');
    expect((await backlog.read()).mergeQueue).toEqual(['BL-3']);
    expect(ui.messages.at(-1)).toContain('BL-3 waits: it conflicts with the tickets ahead in the merge queue.');
    merger.dispose();
  });

  it("resolves a train conflict with an agent in the ticket's merge in the train, records it, and lands it from the train (BL-146)", async () => {
    const { repo, backlog, merger, item, worktrees } = await setup([approved('BL-1'), approved('BL-2'), approved('BL-3')]);
    branches(repo);
    const tip3 = git(repo, 'rev-parse', 'feature/BL-3');
    ui.settings['merge.onApprove'] = 'off';
    for (const id of ['BL-1', 'BL-2', 'BL-3']) await merger.approved(id, 'Rex-1');
    await merger.refreshTrain();
    expect(merger.queuePlace('BL-3')?.state).toBe('Conflicts with main + BL-1 + BL-2 in `shared.txt`.');
    const before = (await backlog.read()).mergeTrain!;

    await merger.resolveTrainConflict('BL-3');

    const m = (await item('BL-3')).merging!;
    expect(m).toMatchObject({ state: 'resolving', baseTip: before.entries[1].commit, train: { ahead: ['BL-1', 'BL-2'] } });
    expect(git(m.dir, 'diff', '--name-only', '--diff-filter=U')).toBe('shared.txt');
    expect(agents.prompts.at(-1)).toContain("resolve the conflicts of merging BL-3's branch feature/BL-3 into main + BL-1 + BL-2");
    // Meanwhile it keeps its place, and the tickets behind it are merged as if it weren't there.
    await merger.refreshTrain();
    expect((await backlog.read()).mergeQueue).toEqual(['BL-1', 'BL-2', 'BL-3']);
    expect((await backlog.read()).mergeTrain!.entries.map((e) => e.id)).toEqual(['BL-1', 'BL-2']);

    // What the agent does: resolves and commits the merge.
    writeFile(m.dir, 'shared.txt', 'two and three\n');
    git(m.dir, 'add', '.');
    git(m.dir, 'commit', '-q', '--no-edit');
    merger['runs'].delete('BL-3');
    await backlog.change((d) => ({ ...d, items: d.items.map((i) => (i.id === 'BL-3' ? { ...i, merging: { ...m, state: 'resolved' } } : i)) }));
    ui.answers = ['Land 3'];

    expect(await merger.approveResolution('BL-3')).toBe('merged');

    expect(git(repo, 'log', '--first-parent', '--format=%s', '-3', 'main').split('\n')).toEqual(['Merge BL-3: Item BL-3', 'Merge BL-2: Item BL-2', 'Merge BL-1: Item BL-1']);
    expect(git(repo, 'show', 'main:shared.txt')).toBe('two and three');
    expect(git(repo, 'rev-parse', 'feature/BL-3')).toBe(tip3);
    expect((await item('BL-3')).status).toBe('done');
    expect(worktrees()).toBe(1);
    const activity = (await backlog.readTicket(await item('BL-3'))).activity.map((e) => e.body).join('\n');
    expect(activity).toContain('in the merge train: it\'s recorded (`shared.txt`)');
    merger.dispose();
  });

  it('keeps the queue in backlog.json, and Remove from Queue rebuilds the train without the ticket', async () => {
    const { repo, backlog, merger } = await setup([approved('BL-2'), approved('BL-3'), approved('BL-1')]);
    branches(repo);
    ui.settings['merge.onApprove'] = 'off';
    for (const id of ['BL-2', 'BL-3', 'BL-1']) await merger.approved(id, 'Rex-1');
    await merger.refreshTrain();
    expect(merger.queueView().entries).toEqual([
      { id: 'BL-2', state: 'clean' },
      { id: 'BL-3', state: 'conflicts' },
      { id: 'BL-1', state: 'clean' },
    ]);
    merger.dispose();

    // Another window (or a reload) reads the same queue.
    const { Merger } = await import('../../../src/ui/backlog/merge');
    const again = new Merger({ backlog, repository: { current: [] }, mainRoot: repo, output: { appendLine() {} }, openTicket() {} } as never);
    await again.refreshTrain();
    expect(again.queuePlace('BL-3')).toMatchObject({ place: '2nd of 3', state: 'Conflicts with main + BL-2 in `shared.txt`.' });
    await again.removeFromQueue('BL-2');
    expect(again.queueView().entries).toEqual([
      { id: 'BL-3', state: 'clean' },
      { id: 'BL-1', state: 'clean' },
    ]);
    again.dispose();
  });

  it('reorders the queue (dragged, or Merge Next) and rebuilds the train in the new order (BL-144)', async () => {
    const { repo, backlog, merger, item } = await setup([approved('BL-2'), approved('BL-3'), approved('BL-1')]);
    branches(repo);
    ui.settings['merge.onApprove'] = 'off';
    for (const id of ['BL-2', 'BL-3', 'BL-1']) await merger.approved(id, 'Rex-1');
    await merger.refreshTrain();

    await merger.reorderQueue(['BL-3', 'BL-1', 'BL-2']);
    expect((await backlog.read()).mergeQueue).toEqual(['BL-3', 'BL-1', 'BL-2']);
    expect((await backlog.read()).mergeTrain?.entries.map((e) => e.id)).toEqual(['BL-3', 'BL-1', 'BL-2']);
    expect(merger.queueView().entries).toEqual([
      { id: 'BL-3', state: 'clean' },
      { id: 'BL-1', state: 'clean' },
      { id: 'BL-2', state: 'conflicts' },
    ]);

    await merger.mergeNext('BL-2');
    expect((await backlog.read()).mergeQueue).toEqual(['BL-2', 'BL-3', 'BL-1']);
    expect(merger.queuePlace('BL-2')).toMatchObject({ place: '1st of 3', ahead: [] });
    expect(merger.queuePlace('BL-3')).toMatchObject({ state: 'Conflicts with main + BL-2 in `shared.txt`.' });
    expect((await backlog.readTicket(await item('BL-2'))).activity.map((e) => e.body)).toContain('You moved it to the front of the merge queue (Merge Next).');
    merger.dispose();
  });
});

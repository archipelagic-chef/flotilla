import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { BacklogItem } from '../../../src/features/backlog/backlog';
import type { LocalBacklog } from '../../../src/features/backlog/localBacklog';
import {
  git,
  initRepo,
  makeTempDir,
  removeDir,
  writeFile,
} from '../../helpers/gitRepo';
import { eventsWritten, readEvents, setEventLog } from '../../../src/features/metrics/events';
import { accountLimit } from '../../../src/features/backlog/accountLimit';

/** What the mocked VS Code answers and records. */
const ui = {
  /** A function answers when it's asked (what changed while the question waited). */
  answers: [] as Array<string | undefined | (() => string | undefined)>,
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
    const answer = ui.answers.shift();
    return Promise.resolve(typeof answer === 'function' ? answer() : answer);
  };
  return {
    EventEmitter,
    window: { showInformationMessage: ask, showWarningMessage: ask, showErrorMessage: ask, showQuickPick: async () => undefined },
    workspace: { getConfiguration: () => ({ get: (k: string, d: unknown) => (k in ui.settings ? ui.settings[k] : d) }) },
    commands: { executeCommand: async () => undefined },
  };
});

/** The resolving agent: never started for real; the test does its work in the merge's worktree. */
const agents = {
  prompts: [] as string[],
  runs: [] as Array<{ cwd: string; resume?: string; stopped: boolean; finish?: (r: { code: number; error?: string; limit?: unknown }) => void }>,
};
vi.mock('../../../src/ui/backlog/agentRunner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/ui/backlog/agentRunner')>()),
  runAgentHeadless: (o: { prompt: string; cwd: string; resume?: string }) => {
    agents.prompts.push(o.prompt);
    const r: (typeof agents.runs)[number] = { cwd: o.cwd, resume: o.resume, stopped: false };
    agents.runs.push(r);
    // It runs until the test finishes it (most never do).
    const done = new Promise((resolve) => (r.finish = resolve));
    return { sessionId: o.resume ?? 'session', done, stop: () => void (r.stopped = true) };
  },
}));

/** The checks: they print a failure and exit with ui.checksExit. */
const CHECKS = `node -e "console.log(process.env.FLOTILLA_TEST_CHECKS_OUT || 'FAIL a.test.ts: expected 1, got 2'); process.exit(Number(process.env.FLOTILLA_TEST_CHECKS_EXIT))"`;

/** The checks' environment (Merger's checksEnv): the command really runs; CHECKS reads how to end from it. */
function fakeChecksEnv(command: string): NodeJS.ProcessEnv {
  ui.checks.push(command);
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.FLOTILLA_TEST_CHECKS_EXIT = String(ui.checksExits.shift() ?? ui.checksExit);
  env.FLOTILLA_TEST_CHECKS_OUT = ui.checksOut;
  return env;
}

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));
beforeEach(() => {
  ui.answers = [];
  ui.messages = [];
  // The tests below written before BL-181 merge with merge commits; those of fast-forward set it themselves.
  ui.settings = { 'merge.checkCommand': CHECKS, 'merge.style': 'merge-commit' };
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
  await backlog.change((d) => ({
    ...d,
    items: d.items.map((i) => (i.id === id ? { ...i, merging: { ...i.merging!, state: 'resolving', agent: 'Ace-1', from } } : i)),
  }));
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
  const merger = new Merger({ backlog, repository, mainRoot: repo, output: { appendLine() {} }, openTicket() {}, checksEnv: fakeChecksEnv } as never);
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

  it('runs the checks in the background with their progress; Stop stops the merge, its log kept until it ends (BL-169)', async () => {
    const { repo, backlog, merger, item } = await setup([approved('BL-1')]);
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 'a.txt', 'a\n', 'BL-1: add a');
    git(repo, 'checkout', '-q', 'main');
    // vitest's start and a test file done; then it runs on.
    const slow = `node -e "console.log(' RUN  v5.0.3 /r'); console.log(' ✓ tests/a.test.ts (2 tests) 5ms'); setInterval(() => {}, 1000)"`;
    ui.settings['merge.checkCommand'] = slow;
    const updates: string[] = [];
    merger.onDidChecks((id) => updates.push(id));
    const merging = merger.merge('BL-1');
    // Until the progress is sent (a second after the output): under a busy full suite, starting the merge and its
    // checks can take more than the 5 s this waited before.
    await vi.waitFor(() => expect(updates).toContain('BL-1'), { timeout: 20_000, interval: 25 });
    const view = merger.checksView('BL-1')!;
    expect(view).toMatchObject({ command: slow, progress: { step: 'Tests', files: 1, failedFiles: 0 }, earlier: [] });
    expect(view.tail.at(-1)).toBe(' ✓ tests/a.test.ts (2 tests) 5ms');
    expect(view.log).toBe(path.join(repo, '.git', 'flotilla', 'merges', 'BL-1', 'checks.log'));

    merger.stopChecks('BL-1');
    expect(await merging).toBe('stopped');
    expect(merger.checksView('BL-1')).toBeUndefined();
    const kept = await item('BL-1');
    expect(kept.merging).toMatchObject({
      state: 'failed',
      reason: `you stopped the checks (\`${slow}\`).`,
      checks: { runs: [{ log: view.log, stopped: true, timeouts: 0, failures: [] }] },
    });
    expect((await backlog.readTicket(kept)).activity.map((e) => e.body).join('\n')).toContain('you stopped its checks');
    // Show All reads its log; nothing outside the merge's logs is read.
    expect(await merger.checksLog('BL-1', view.log)).toContain('✓ tests/a.test.ts (2 tests)');
    expect(await merger.checksLog('BL-1', path.join(repo, 'a.txt'))).toBeUndefined();

    // The merge ends: its logs go with it.
    await merger.cancel('BL-1');
    expect(fs.existsSync(path.dirname(view.log))).toBe(false);
    merger.dispose();
  });

  it("records a failed run's failing tests, with their errors (BL-169)", async () => {
    const { repo, merger, item } = await setup([approved('BL-1')]);
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 'a.txt', 'a\n', 'BL-1: add a');
    git(repo, 'checkout', '-q', 'main');
    ui.checksExit = 1;
    ui.checksOut = ' FAIL  tests/a.test.ts > a > adds\nAssertionError: expected 3 to be 4\n Test Files  1 failed (12)';
    expect(await merger.merge('BL-1')).toBe('stopped');
    const runs = (await item('BL-1')).merging!.checks!.runs!;
    expect(runs).toEqual([
      {
        log: path.join(repo, '.git', 'flotilla', 'merges', 'BL-1', 'checks.log'),
        at: expect.any(String),
        ms: expect.any(Number),
        timeouts: 0,
        failures: [{ test: 'tests/a.test.ts › a › adds', error: ['AssertionError: expected 3 to be 4'] }],
      },
    ]);
    // The next run counts its test files of the 12 this one had.
    expect(JSON.parse(fs.readFileSync(path.join(repo, '.git', 'flotilla', 'checks-stats.json'), 'utf8'))).toEqual({ [CHECKS]: { files: 12 } });
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

  it('records the conflicts of merging again onto main when it moved before the approval (BL-168)', async () => {
    const { repo, merger, item } = await setup([approved('BL-1')]);
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 'a.txt', 'a\n', 'BL-1: add a');
    git(repo, 'checkout', '-q', 'main');
    ui.checksExit = 1;
    await merger.merge('BL-1');
    const dir = (await item('BL-1')).merging!.dir;
    commit(dir, 'fix.txt', 'fixed\n', 'BL-1: Fix the checks after merging main');
    // main moves while the fix waits for approval, in the same file.
    commit(repo, 'a.txt', 'other\n', 'BL-2: add a too');
    ui.checksExit = 0;
    const log = makeTempDir();
    setEventLog(log);

    expect(await merger.approveResolution('BL-1')).toBe('stopped');

    await eventsWritten();
    setEventLog(undefined);
    expect((await readEvents(log)).filter((e) => e.kind === 'merge-conflicted')).toEqual([
      expect.objectContaining({ ticket: 'BL-1', data: { files: [expect.objectContaining({ file: 'a.txt' })] } }),
    ]);
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

  it('merges when the fixing agent commits nothing and the checks pass when run again (BL-124)', async () => {
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
    expect((await item('BL-1')).merging).toMatchObject({
      state: 'failed',
      checks: { command: CHECKS },
      reason: expect.stringContaining('committed no fix, and the checks still fail'),
    });
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

  it('Pause All pauses a resolving merge agent, keeping its chat, and Resume All resumes it in the merge worktree (BL-164)', async () => {
    const { repo, merger, item } = await setup([approved('BL-1')]);
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 'a.txt', 'one\n', 'BL-1: a');
    git(repo, 'checkout', '-q', 'main');
    commit(repo, 'a.txt', 'two\n', 'other: a');
    agents.runs = [];
    ui.answers = ['Resolve with Agent'];
    expect(await merger.merge('BL-1')).toBe('stopped');
    await merger.resolveWithAgent('BL-1');
    const dir = (await item('BL-1')).merging!.dir;
    cleanup.push(dir);
    expect(merger.isRunning('BL-1')).toBe(true);

    expect(await merger.pauseForAll('BL-1')).toBe('session');
    expect(agents.runs[0].stopped).toBe(true);
    expect(merger.isRunning('BL-1')).toBe(false);
    expect((await item('BL-1')).merging).toMatchObject({ state: 'resolving', session: 'session', paused: expect.any(String) });
    expect(await merger.pauseForAll('BL-1')).toBeUndefined(); // paused already

    expect(await merger.resumeForAll('BL-1', 'other-session')).toBeUndefined(); // not paused in that chat
    expect(await merger.resumeForAll('BL-1', 'session')).toBe('running');
    expect(agents.runs[1]).toMatchObject({ cwd: dir, resume: 'session', stopped: false });
    expect(merger.isRunning('BL-1')).toBe(true);
    expect((await item('BL-1')).merging).toMatchObject({ state: 'resolving', session: 'session' });
    expect((await item('BL-1')).merging!.paused).toBeUndefined();
    await merger.cancel('BL-1');
    merger.dispose();
  });

  describe("Claude's usage limit (BL-248)", () => {
    afterEach(() => accountLimit.lift());

    /** A merge that conflicts, waiting for its agent. */
    const conflicted = async (o: { held?: boolean } = {}) => {
      const s = await setup([approved('BL-1')]);
      git(s.repo, 'checkout', '-q', '-b', 'feature/BL-1');
      commit(s.repo, 'a.txt', 'one\n', 'BL-1: a');
      git(s.repo, 'checkout', '-q', 'main');
      commit(s.repo, 'a.txt', 'two\n', 'other: a');
      agents.runs = [];
      ui.answers = ['Resolve with Agent'];
      if (o.held) accountLimit.holdUntil(new Date(Date.now() + 60 * 60_000));
      expect(await s.merger.merge('BL-1')).toBe('stopped');
      cleanup.push((await s.item('BL-1')).merging!.dir);
      return s;
    };

    it("starts no merge agent while the account's limit is known to hold, and starts it when it lifts, counting the wait", async () => {
      const log = makeTempDir();
      setEventLog(log);
      const { merger, item } = await conflicted({ held: true });
      expect(agents.runs).toHaveLength(0);
      // Asked again by hand, it waits on.
      await merger.resolveWithAgent('BL-1');
      expect(agents.runs).toHaveLength(0);
      expect((await item('BL-1')).merging).toMatchObject({ state: 'failed', limit: { known: true, since: expect.any(String) } });
      expect((await item('BL-1')).merging!.reason).toMatch(/^Its agent starts when the limit lifts/);

      accountLimit.lift();
      await vi.waitFor(() => expect(agents.runs).toHaveLength(1));
      await vi.waitFor(async () => expect((await item('BL-1')).merging).toMatchObject({ state: 'resolving' }));
      expect((await item('BL-1')).merging!.limit).toBeUndefined();
      expect(agents.runs[0].resume).toBeUndefined();
      await eventsWritten();
      setEventLog(undefined);
      expect((await readEvents(log)).filter((e) => e.kind === 'limit-lifted')).toEqual([
        expect.objectContaining({ ticket: 'BL-1', data: { minutes: expect.any(Number) } }),
      ]);
      await merger.cancel('BL-1');
      merger.dispose();
    });

    it('a merge agent that hits the limit waits for it, its chat kept, and goes on there when it lifts', async () => {
      const { merger, item } = await conflicted();
      expect(agents.runs).toHaveLength(1);
      agents.runs[0].finish!({ code: 1, error: 'limit', limit: { until: new Date(Date.now() + 60 * 60_000), known: true, kind: 'usage' } });
      await vi.waitFor(async () => expect((await item('BL-1')).merging).toMatchObject({ state: 'failed', session: 'session', limit: { resume: true } }));
      expect(merger.isRunning('BL-1')).toBe(false);

      accountLimit.holdUntil(new Date(Date.now() + 60 * 60_000));
      accountLimit.lift();
      await vi.waitFor(() => expect(agents.runs).toHaveLength(2));
      expect(agents.runs[1]).toMatchObject({ resume: 'session' });
      await vi.waitFor(async () => expect((await item('BL-1')).merging).toMatchObject({ state: 'resolving', session: 'session' }));
      expect((await item('BL-1')).merging!.limit).toBeUndefined();
      await merger.cancel('BL-1');
      merger.dispose();
    });
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

  it('doesn\'t hold up the next merge behind an unanswered "nothing to merge" (BL-101)', async () => {
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

describe('Merge to main with fast-forward (BL-181)', () => {
  beforeEach(() => {
    ui.settings['merge.style'] = 'fast-forward';
  });
  const linear = (repo: string, range: string) => git(repo, 'rev-list', '--merges', '--count', range);

  it('fast-forwards main to a branch on top of it: what was checked is what lands, no merge commit', async () => {
    const { repo, backlog, merger, item, worktrees } = await setup([approved('BL-1')]);
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 'a.txt', 'a\n', 'BL-1: Add a');
    commit(repo, 'b.txt', 'b\n', 'BL-1: Add b');
    git(repo, 'checkout', '-q', 'main');
    const before = git(repo, 'rev-parse', 'main');
    const tip = git(repo, 'rev-parse', 'feature/BL-1');

    expect(await merger.merge('BL-1')).toBe('merged');

    expect(git(repo, 'rev-parse', 'main')).toBe(tip);
    expect(linear(repo, `${before}..main`)).toBe('0');
    expect(ui.checks).toEqual([CHECKS]);
    expect(worktrees()).toBe(1);
    const done = await item('BL-1');
    expect(done.merged).toMatchObject({ into: 'main', commit: tip });
    const activity = (await backlog.readTicket(done)).activity.map((e) => e.body).join('\n');
    expect(activity).toContain(`\`main\` fast-forwarded to ${tip.slice(0, 7)}, 2 commits of BL-1, no merge commit.`);
    merger.dispose();
  });

  it('rebases a branch main moved away from, squashing its fixups, and moves the branch to what landed', async () => {
    const { repo, backlog, merger, item } = await setup([approved('BL-1')]);
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 'a.txt', 'a\n', 'BL-1: Add a');
    commit(repo, 'a.txt', 'a, as reviewed\n', 'fixup! BL-1: Add a');
    git(repo, 'checkout', '-q', 'main');
    commit(repo, 'm.txt', 'm\n', 'BL-2: Main moves on');
    const before = git(repo, 'rev-parse', 'main');

    expect(await merger.merge('BL-1')).toBe('merged');

    expect(git(repo, 'log', '--format=%s', `${before}..main`)).toBe('BL-1: Add a');
    expect(git(repo, 'rev-parse', 'main^')).toBe(before);
    expect(git(repo, 'show', 'main:a.txt')).toBe('a, as reviewed');
    expect(git(repo, 'rev-parse', 'feature/BL-1')).toBe(git(repo, 'rev-parse', 'main'));
    const activity = (await backlog.readTicket(await item('BL-1'))).activity.map((e) => e.body).join('\n');
    expect(activity).toContain('1 commit of BL-1, no merge commit. `feature/BL-1` was moved to it too (it was rebased');
    merger.dispose();
  });

  it('has an agent resolve a rebase that conflicts, commit by commit, and lands it once you approve', async () => {
    const { repo, merger, item, worktrees } = await setup([approved('BL-1')]);
    commit(repo, 's.txt', 'one\n', 'shared');
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 's.txt', 'two\n', 'BL-1: Two');
    git(repo, 'checkout', '-q', 'main');
    commit(repo, 's.txt', 'three\n', 'BL-2: Three');
    const before = git(repo, 'rev-parse', 'main');
    ui.answers = ['Resolve with Agent'];

    expect(await merger.merge('BL-1')).toBe('stopped');

    expect(ui.messages).toContain('Rebasing feature/BL-1 onto main has conflicts.');
    const m = (await item('BL-1')).merging!;
    expect(m).toMatchObject({ state: 'resolving', rebase: true, baseTip: before });
    expect(agents.prompts.at(-1)).toContain("resolve the conflicts of rebasing BL-1's branch feature/BL-1 onto main");
    expect(agents.prompts.at(-1)).toContain('git rebase --continue');
    // What the agent does: resolves the commit and goes on with the rebase.
    writeFile(m.dir, 's.txt', 'two and three\n');
    git(m.dir, 'add', '.');
    git(m.dir, '-c', 'core.editor=true', 'rebase', '--continue');
    merger['runs'].delete('BL-1');

    expect(await merger.approveResolution('BL-1')).toBe('merged');

    expect(git(repo, 'log', '--format=%s', `${before}..main`)).toBe('BL-1: Two');
    expect(git(repo, 'rev-parse', 'main^')).toBe(before);
    expect(git(repo, 'show', 'main:s.txt')).toBe('two and three');
    expect((await item('BL-1')).status).toBe('done');
    expect(worktrees()).toBe(1);
    merger.dispose();
  });

  /** As its agent rebases BL-1's branch onto main: the same commit on top of it, the conflict resolved. */
  function rebaseByItsAgent(repo: string): void {
    git(repo, 'checkout', '-q', '-b', 'rebased', 'main');
    commit(repo, 's.txt', 'two and three\n', 'BL-1: Two');
    git(repo, 'branch', '-f', 'feature/BL-1', 'rebased');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'branch', '-D', 'rebased');
  }

  /** BL-1's branch and main change s.txt's line: rebasing it onto main conflicts. Queued, its train conflicts too. */
  async function conflictingQueued() {
    const s = await setup([approved('BL-1')]);
    commit(s.repo, 's.txt', 'one\n', 'shared');
    git(s.repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(s.repo, 's.txt', 'two\n', 'BL-1: Two');
    git(s.repo, 'checkout', '-q', 'main');
    commit(s.repo, 's.txt', 'three\n', 'BL-2: Three');
    ui.settings['merge.onApprove'] = 'off';
    await s.merger.approved('BL-1', 'Rex-1');
    await s.merger['currentTrain']({ rebuild: true });
    await s.merger.resolveTrainConflict('BL-1');
    const m = (await s.item('BL-1')).merging!;
    expect(m).toMatchObject({ state: 'resolving', rebase: true, train: { ahead: [] } });
    // What the agent does: resolves the commit and goes on with the rebase.
    writeFile(m.dir, 's.txt', 'two and three\n');
    git(m.dir, 'add', '.');
    git(m.dir, '-c', 'core.editor=true', 'rebase', '--continue');
    s.merger['runs'].delete('BL-1');
    return { ...s, m };
  }

  it('lands an approved train resolution as approved, once: no second resolution, no agent, not back to In Progress (BL-227)', async () => {
    const { repo, backlog, merger, item, worktrees } = await conflictingQueued();
    const before = git(repo, 'rev-parse', 'main');
    const updates: string[] = [];
    merger['deps'].updateFromMain = async (id: string) => (updates.push(id), 'handed' as const);
    const prompts = agents.prompts.length;

    // Update from Main and Merge asked meanwhile joins the merge instead of handing the branch to its agent.
    const [end] = await Promise.all([merger.approveResolution('BL-1'), merger.updateAndMerge('BL-1')]);

    expect(end).toBe('merged');
    expect(updates).toEqual([]);
    expect(agents.prompts.length).toBe(prompts);
    expect(git(repo, 'log', '--format=%s', `${before}..main`)).toBe('BL-1: Two');
    expect(git(repo, 'show', 'main:s.txt')).toBe('two and three');
    expect(git(repo, 'rev-parse', 'feature/BL-1')).toBe(git(repo, 'rev-parse', 'main'));
    expect((await item('BL-1')).status).toBe('done');
    expect((await backlog.read()).mergeQueue).toEqual([]);
    expect(worktrees()).toBe(1);
    const activity = (await backlog.readTicket(await item('BL-1'))).activity.map((e) => e.body).join('\n');
    expect(activity).toContain("in the merge train: it's recorded (`s.txt`), and it lands as you approved it.");
    expect(activity).not.toContain('In Progress');
    merger.dispose();
  });

  it('replays BL-218: the branch rebased by its agent while the resolution waited lands from its tip, with one approval (BL-227)', async () => {
    const { repo, backlog, merger, item, worktrees } = await conflictingQueued();
    // Its own agent rebases the branch onto main meanwhile, resolving the same conflict the same way.
    rebaseByItsAgent(repo);
    const rebased = git(repo, 'rev-parse', 'feature/BL-1');
    const prompts = agents.prompts.length;

    expect(await merger.approveResolution('BL-1')).toBe('merged');

    expect(agents.prompts.length).toBe(prompts);
    expect(ui.messages.filter((x) => x.includes('has conflicts'))).toEqual([]);
    expect(git(repo, 'rev-parse', 'main')).toBe(rebased);
    expect((await item('BL-1')).status).toBe('done');
    expect(worktrees()).toBe(1);
    const activity = (await backlog.readTicket(await item('BL-1'))).activity.map((e) => e.body).join('\n');
    expect(activity).toContain('`feature/BL-1` moved since its rebase was made');
    merger.dispose();
  });

  it('makes a merge again from the branch as it is when its agent rebased it while you were asked: no conflict, no agent (BL-227)', async () => {
    const { repo, merger, item } = await setup([approved('BL-1')]);
    commit(repo, 's.txt', 'one\n', 'shared');
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 's.txt', 'two\n', 'BL-1: Two');
    git(repo, 'checkout', '-q', 'main');
    commit(repo, 's.txt', 'three\n', 'BL-2: Three');
    const prompts = agents.prompts.length;
    // While the conflicts' question waits, its agent rebases the branch onto main.
    ui.answers = [() => (rebaseByItsAgent(repo), 'Resolve with Agent')];

    expect(await merger.merge('BL-1')).toBe('merged');

    expect(agents.prompts.length).toBe(prompts);
    expect(git(repo, 'show', 'main:s.txt')).toBe('two and three');
    expect((await item('BL-1')).status).toBe('done');
    merger.dispose();
  });

  it('keeps a rebase whose checks fail, for an agent to fix with a commit on top', async () => {
    const { repo, merger, item } = await setup([approved('BL-1')]);
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 'a.txt', 'a\n', 'BL-1: Add a');
    git(repo, 'checkout', '-q', 'main');
    commit(repo, 'm.txt', 'm\n', 'BL-2: Main moves on');
    const before = git(repo, 'rev-parse', 'main');
    ui.checksExit = 1;

    expect(await merger.merge('BL-1')).toBe('stopped');

    const m = (await item('BL-1')).merging!;
    expect(m).toMatchObject({ state: 'failed', rebase: true });
    await merger.resolveWithAgent('BL-1');
    expect(agents.prompts.at(-1)).toContain("fix the checks on BL-1's branch feature/BL-1 rebased onto main");
    commit(m.dir, 'fix.txt', 'fixed\n', 'BL-1: Fix the checks on main');
    merger['runs'].delete('BL-1');
    ui.checksExit = 0;

    expect(await merger.approveResolution('BL-1')).toBe('merged');
    expect(git(repo, 'log', '--format=%s', `${before}..main`).split('\n')).toEqual(['BL-1: Fix the checks on main', 'BL-1: Add a']);
    merger.dispose();
  });

  it('lands two queued tickets from the train in order, with no merge commits', async () => {
    const { repo, backlog, merger, item } = await setup([approved('BL-1'), approved('BL-2')]);
    for (const [id, file] of [
      ['BL-1', 'a.txt'],
      ['BL-2', 'b.txt'],
    ]) {
      git(repo, 'checkout', '-q', '-b', `feature/${id}`, 'main');
      commit(repo, file, `${id}\n`, `${id}: Add ${file}`);
    }
    git(repo, 'checkout', '-q', 'main');
    const before = git(repo, 'rev-parse', 'main');
    ui.settings['merge.onApprove'] = 'off';
    await merger.approved('BL-1', 'Rex-1');
    await merger.approved('BL-2', 'Rex-1');
    await merger.refreshTrain();
    expect((await backlog.read()).mergeTrain?.style).toBe('fast-forward');
    ui.answers = ['Land 2'];

    expect(await merger.merge('BL-2')).toBe('merged');

    expect(git(repo, 'log', '--format=%s', `${before}..main`).split('\n')).toEqual(['BL-2: Add b.txt', 'BL-1: Add a.txt']);
    expect(linear(repo, `${before}..main`)).toBe('0');
    expect(ui.checks).toEqual([CHECKS, CHECKS]);
    expect((await item('BL-1')).merged?.commit).toBe(git(repo, 'rev-parse', 'main^'));
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

    expect(ui.messages).toContain("Merging BL-1 lands BL-2 too: it's ahead of it in the merge queue.");
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
    const log = makeTempDir();
    setEventLog(log);
    for (const id of ['BL-1', 'BL-2', 'BL-3']) await merger.approved(id, 'Rex-1');
    await merger.refreshTrain();
    await merger['currentTrain']({ rebuild: true });
    expect(merger.queuePlace('BL-3')?.state).toBe('Conflicts with main + BL-1 + BL-2 in `shared.txt`.');
    // Its conflict in the train is recorded once, measured onto the train before it (BL-168): not again as it's rebuilt.
    await eventsWritten();
    setEventLog(undefined);
    const conflicted = (await readEvents(log)).filter((e) => e.kind === 'merge-conflicted');
    expect(conflicted).toEqual([
      expect.objectContaining({ ticket: 'BL-3', data: { files: [expect.objectContaining({ file: 'shared.txt', regions: [expect.anything()] })] } }),
    ]);
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

    expect(git(repo, 'log', '--first-parent', '--format=%s', '-3', 'main').split('\n')).toEqual([
      'Merge BL-3: Item BL-3',
      'Merge BL-2: Item BL-2',
      'Merge BL-1: Item BL-1',
    ]);
    expect(git(repo, 'show', 'main:shared.txt')).toBe('two and three');
    expect(git(repo, 'rev-parse', 'feature/BL-3')).toBe(tip3);
    expect((await item('BL-3')).status).toBe('done');
    expect(worktrees()).toBe(1);
    const activity = (await backlog.readTicket(await item('BL-3'))).activity.map((e) => e.body).join('\n');
    expect(activity).toContain("in the merge train: it's recorded (`shared.txt`)");
    merger.dispose();
  });

  /** The agent Land All, Resolving Conflicts started for a ticket ends (BL-226): having resolved its merge, or not. */
  async function resolverEnds(merger: unknown, id: string, dir?: string) {
    if (dir) {
      writeFile(dir, 'shared.txt', 'two and three\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '--no-edit');
    }
    const p = merger as Private;
    await p.afterResolver(id, p.runs.get(id), undefined);
  }

  it('Land All, Resolving Conflicts has an agent resolve a ticket that conflicts in the train, and lands it without asking (BL-226)', async () => {
    const { repo, backlog, merger, item, worktrees } = await setup([approved('BL-1'), approved('BL-2'), approved('BL-3')]);
    branches(repo);

    await merger.mergeAllReady({ resolve: true });

    // BL-1 and BL-2 landed while BL-3's agent works.
    expect(git(repo, 'log', '--first-parent', '--format=%s', '-2', 'main').split('\n')).toEqual(['Merge BL-2: Item BL-2', 'Merge BL-1: Item BL-1']);
    const m = (await item('BL-3')).merging!;
    expect(m).toMatchObject({ state: 'resolving', auto: true, train: { ahead: ['BL-1', 'BL-2'] } });
    await merger['readQueue']();
    expect(merger.queueView().entries).toEqual([{ id: 'BL-3', state: 'unknown', run: 'resolving' }]);
    expect(ui.messages.join('\n')).not.toContain('Land All, Resolving Conflicts landed');

    await resolverEnds(merger, 'BL-3', m.dir);

    expect(git(repo, 'log', '--first-parent', '--format=%s', '-1', 'main')).toBe('Merge BL-3: Item BL-3');
    expect(git(repo, 'show', 'main:shared.txt')).toBe('two and three');
    expect((await item('BL-3')).status).toBe('done');
    expect((await backlog.read()).mergeQueue).toEqual([]);
    expect(worktrees()).toBe(1);
    const activity = (await backlog.readTicket(await item('BL-3'))).activity.map((e) => e.body).join('\n');
    expect(activity).toMatch(/Approved automatically \(Land All, Resolving Conflicts\): [A-Z][a-z]+-\d+'s resolution/);
    expect(ui.messages.at(-1)).toBe('Land All, Resolving Conflicts landed BL-1, BL-2, BL-3.');
    merger.dispose();
  });

  it('Land All, Resolving Conflicts leaves a ticket whose agent failed waiting for you, and lands the others (BL-226)', async () => {
    const { repo, merger, item } = await setup([approved('BL-1'), approved('BL-2'), approved('BL-3')]);
    branches(repo);

    await merger.mergeAllReady({ resolve: true });
    await resolverEnds(merger, 'BL-3');

    expect(git(repo, 'log', '--first-parent', '--format=%s', '-2', 'main').split('\n')).toEqual(['Merge BL-2: Item BL-2', 'Merge BL-1: Item BL-1']);
    expect((await item('BL-3')).merging).toMatchObject({ state: 'failed', auto: true });
    expect((await item('BL-3')).status).toBe('review');
    await merger['readQueue']();
    expect(merger.queueView().entries).toEqual([{ id: 'BL-3', state: 'unknown', run: 'needs you' }]);
    expect(ui.messages.at(-1)).toBe('Land All, Resolving Conflicts landed BL-1, BL-2. BL-3 needs you: its ticket says why.');
    merger.dispose();
  });

  it('Land All, Resolving Conflicts stops the agent of a ticket taken out of the queue, and lands nothing of it (BL-226)', async () => {
    const { repo, backlog, merger, item, worktrees } = await setup([approved('BL-1'), approved('BL-2'), approved('BL-3')]);
    branches(repo);

    await merger.mergeAllReady({ resolve: true });
    const dir = (await item('BL-3')).merging!.dir;
    await merger.removeFromQueue('BL-3');
    // Its agent was stopped: what it would have done is never approved.
    expect(agents.runs.at(-1)?.stopped).toBe(true);
    await resolverEnds(merger, 'BL-3', dir).catch(() => undefined);

    expect(git(repo, 'log', '--first-parent', '--format=%s', '-1', 'main')).toBe('Merge BL-2: Item BL-2');
    expect((await item('BL-3')).merging).toBeUndefined();
    expect((await item('BL-3')).status).toBe('review');
    expect((await backlog.read()).mergeQueue).toEqual([]);
    expect(worktrees()).toBe(1);
    expect(ui.messages.at(-1)).toBe('Land All, Resolving Conflicts landed BL-1, BL-2. BL-3 was taken out of the queue.');
    merger.dispose();
  });

  /** BL-1, BL-2 and BL-3 queued, in that order; BL-3 conflicts with BL-2 in the train. */
  async function queued() {
    const s = await setup([approved('BL-1'), approved('BL-2'), approved('BL-3')]);
    branches(s.repo);
    ui.settings['merge.onApprove'] = 'off';
    for (const id of ['BL-1', 'BL-2', 'BL-3']) await s.merger.approved(id, 'Rex-1');
    await s.merger.refreshTrain();
    return s;
  }

  it('Land, Resolving Conflicts has an agent resolve a ticket that conflicts in the train, and lands it and those ahead without asking (BL-247)', async () => {
    const { repo, backlog, merger, item, worktrees } = await queued();
    const log = makeTempDir();
    setEventLog(log);

    expect(await merger.merge('BL-3', { auto: true })).toBe('stopped');

    const m = (await item('BL-3')).merging!;
    expect(m).toMatchObject({ state: 'resolving', auto: true, train: { ahead: ['BL-1', 'BL-2'] } });
    expect((await backlog.read()).autoLand).toEqual(['BL-3']);
    expect(merger.queueView().entries.at(-1)).toMatchObject({ id: 'BL-3', run: 'resolving', auto: true });

    await resolverEnds(merger, 'BL-3', m.dir);

    expect(git(repo, 'log', '--first-parent', '--format=%s', '-3', 'main').split('\n')).toEqual([
      'Merge BL-3: Item BL-3',
      'Merge BL-2: Item BL-2',
      'Merge BL-1: Item BL-1',
    ]);
    expect(ui.messages.join('\n')).not.toContain('Merging BL-3 lands');
    expect((await item('BL-3')).status).toBe('done');
    expect((await backlog.read()).autoLand).toBeUndefined();
    expect(worktrees()).toBe(1);
    const activity = (await backlog.readTicket(await item('BL-3'))).activity.map((e) => e.body).join('\n');
    expect(activity).toMatch(/Approved automatically \(Land, Resolving Conflicts\): [A-Z][a-z]+-\d+'s resolution/);
    await eventsWritten();
    setEventLog(undefined);
    expect((await readEvents(log)).filter((e) => e.kind === 'merge-approved')).toEqual([
      expect.objectContaining({ ticket: 'BL-3', data: { by: 'Land, Resolving Conflicts' } }),
    ]);
    merger.dispose();
  });

  it.each([
    ['in the train', false],
    ['merged outside the train', true],
  ])('Land, Resolving Conflicts lands a ticket that conflicts with main the same way, %s (BL-247)', async (_how, outside) => {
    const { repo, backlog, merger, item } = await setup([approved('BL-3')]);
    branches(repo);
    commit(repo, 'shared.txt', 'two\n', 'main changes shared.txt');
    // No train: it's merged onto main as it is, and its conflicts with main go to the agent there.
    if (outside) (merger as unknown as { currentTrain: () => Promise<undefined> }).currentTrain = async () => undefined;

    expect(await merger.merge('BL-3', { auto: true })).toBe('stopped');

    const m = (await item('BL-3')).merging!;
    expect(m).toMatchObject({ state: 'resolving', auto: true });
    expect(!!m.train).toBe(!outside);
    await resolverEnds(merger, 'BL-3', m.dir);

    expect(git(repo, 'show', 'main:shared.txt')).toBe('two and three');
    expect((await item('BL-3')).status).toBe('done');
    expect((await backlog.read()).autoLand).toBeUndefined();
    const activity = (await backlog.readTicket(await item('BL-3'))).activity.map((e) => e.body).join('\n');
    expect(activity).toContain('Approved automatically (Land, Resolving Conflicts)');
    merger.dispose();
  });

  it('Land, Resolving Conflicts leaves a ticket whose agent failed waiting for you, and the other queued tickets alone (BL-247)', async () => {
    const { repo, backlog, merger, item } = await queued();
    const before = git(repo, 'rev-parse', 'main');

    await merger.merge('BL-3', { auto: true });
    await resolverEnds(merger, 'BL-3');

    expect(git(repo, 'rev-parse', 'main')).toBe(before);
    expect((await item('BL-3')).merging).toMatchObject({ state: 'failed', auto: true });
    expect((await backlog.read()).mergeQueue).toEqual(['BL-1', 'BL-2', 'BL-3']);
    expect(merger.queueView().entries.at(-1)).toMatchObject({ id: 'BL-3', run: 'needs you', auto: true });
    expect(ui.messages.at(-1)).toBe('BL-3 needs you: Land, Resolving Conflicts stopped. Its ticket says why.');
    merger.dispose();
  });

  it('Land, Resolving Conflicts stops the agent of a ticket taken out of the queue, and lands nothing of it (BL-247)', async () => {
    const { repo, backlog, merger, item, worktrees } = await queued();
    const before = git(repo, 'rev-parse', 'main');

    await merger.merge('BL-3', { auto: true });
    const dir = (await item('BL-3')).merging!.dir;
    await merger.removeFromQueue('BL-3');
    expect(agents.runs.at(-1)?.stopped).toBe(true);
    await resolverEnds(merger, 'BL-3', dir).catch(() => undefined);

    expect(git(repo, 'rev-parse', 'main')).toBe(before);
    expect((await item('BL-3')).merging).toBeUndefined();
    expect((await item('BL-3')).status).toBe('review');
    expect((await backlog.read()).autoLand).toBeUndefined();
    expect(worktrees()).toBe(1);
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
    const again = new Merger({
      backlog,
      repository: { current: [] },
      mainRoot: repo,
      output: { appendLine() {} },
      openTicket() {},
      checksEnv: fakeChecksEnv,
    } as never);
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

    await merger.reorderQueue(['BL-2', 'BL-3']);
    expect((await backlog.read()).mergeQueue).toEqual(['BL-2', 'BL-3', 'BL-1']);
    expect(merger.queuePlace('BL-2')).toMatchObject({ place: '1st of 3', ahead: [] });
    expect(merger.queuePlace('BL-3')).toMatchObject({ state: 'Conflicts with main + BL-2 in `shared.txt`.' });
    merger.dispose();
  });

  it('Merge Next lands the ticket alone, after the merge going on now, without another click (BL-254)', async () => {
    const { repo, backlog, merger, item } = await setup([approved('BL-1'), approved('BL-3'), approved('BL-2')]);
    branches(repo);
    const before = git(repo, 'rev-parse', 'main');
    ui.settings['merge.onApprove'] = 'off';
    for (const id of ['BL-1', 'BL-3', 'BL-2']) await merger.approved(id, 'Rex-1');
    await merger.refreshTrain();
    expect((await backlog.read()).mergeQueue).toEqual(['BL-1', 'BL-3', 'BL-2']);

    const first = merger.merge('BL-1');
    const next = merger.mergeNext('BL-2');
    expect(merger.mergeProgress('BL-2')).toEqual({ waitsFor: "BL-1's merge" });

    expect(await first).toBe('merged');
    expect(await next).toBe('merged');

    expect(git(repo, 'log', '--first-parent', '--format=%s', `${before}..main`).split('\n')).toEqual(['Merge BL-2: Item BL-2', 'Merge BL-1: Item BL-1']);
    expect(ui.messages.some((m) => / too: /.test(m))).toBe(false);
    expect((await item('BL-2')).status).toBe('done');
    expect((await item('BL-3')).status).toBe('review');
    expect((await backlog.read()).mergeQueue).toEqual(['BL-3']);
    expect(merger.mergeProgress('BL-2')).toBeUndefined();
    expect((await backlog.readTicket(await item('BL-2'))).activity.map((e) => e.body)).toContain(
      'You moved it to the front of the merge queue (Merge Next): it lands next.',
    );
    merger.dispose();
  });
});

describe('Update from Main and Merge (BL-154)', () => {
  async function conflicting() {
    const { LocalBacklog } = await import('../../../src/features/backlog/localBacklog');
    const { Merger } = await import('../../../src/ui/backlog/merge');
    const repo = initRepo();
    const home = makeTempDir();
    cleanup.push(repo, home);
    const backlog = new LocalBacklog(home, path.join(repo, '.git'));
    await backlog.change(() => ({ version: 1, next: 1, items: [approved('BL-1')] }));
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1-one');
    commit(repo, 'a.txt', 'ours\n', 'BL-1: a');
    git(repo, 'checkout', '-q', 'main');
    commit(repo, 'a.txt', 'theirs\n', 'main: a');
    const state = { working: false, updates: 0 };
    // Its agent: main merged into the branch, the conflict resolved its way.
    const resolve = () => {
      git(repo, 'checkout', '-q', 'feature/BL-1-one');
      git(repo, 'merge', '-q', '-X', 'ours', '-m', 'BL-1: Merge main', 'main');
      git(repo, 'checkout', '-q', 'main');
    };
    const repository = { current: [{ key: 'main', worktree: { branch: 'main', path: repo, isMain: true }, chats: [] }] };
    const merger = new Merger({
      backlog,
      repository,
      mainRoot: repo,
      output: { appendLine() {} },
      openTicket() {},
      checksEnv: fakeChecksEnv,
      chainPollMs: 10,
      agentWorking: () => state.working,
      updateFromMain: async () => (state.updates++, (state.working = true), 'handed' as const),
    } as never);
    const item = async () => (await backlog.read()).items.find((i) => i.id === 'BL-1')!;
    const review = (state: 'revising' | 'approved') =>
      backlog.change((d) => ({
        ...d,
        items: d.items.map((i) => ({ ...i, status: state === 'approved' ? 'review' : 'doing', review: { ...i.review!, state } })),
      }));
    return { repo, merger, item, state, resolve, review };
  }

  it('hands the conflicts to its agent, then merges once it has resolved them', async () => {
    const { repo, merger, item, state, resolve, review } = await conflicting();

    await merger.updateAndMerge('BL-1');
    await review('revising');
    expect(state.updates).toBe(1);
    expect(merger.chainOf('BL-1')).toBe('resolving');
    // A second click while it goes on does nothing.
    await merger.updateAndMerge('BL-1');
    expect(state.updates).toBe(1);

    resolve();
    state.working = false;
    // Its hand-off goes through review: it waits until the work is approved again.
    await new Promise((r) => setTimeout(r, 50));
    expect(merger.chainOf('BL-1')).toBe('resolving');
    await review('approved');
    await vi.waitFor(() => expect(merger.chainOf('BL-1')).toBeUndefined(), { timeout: 10_000 });
    expect((await item()).status).toBe('done');
    expect(git(repo, 'log', '-1', '--format=%s', 'main')).toBe('Merge BL-1: Item BL-1');
    merger.dispose();
  });

  it('stops, merging nothing, when its agent is done and the branch still conflicts', async () => {
    const { repo, merger, item, state } = await conflicting();
    const before = git(repo, 'rev-parse', 'main');

    await merger.updateAndMerge('BL-1');
    state.working = false;
    await vi.waitFor(() => expect(merger.chainOf('BL-1')).toBeUndefined(), { timeout: 10_000 });

    expect(git(repo, 'rev-parse', 'main')).toBe(before);
    expect((await item()).status).toBe('review');
    merger.dispose();
  });
});

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFakeGitHub, type FakeGitHub } from '../../../scripts/fake-github.mjs';
import { GitHubActions } from '../../../src/features/ci/githubActions';
import type { Fetch } from '../../../src/features/backlog/sources/source';
import type { BacklogItem } from '../../../src/features/backlog/backlog';
import { git, initRepo, makeTempDir, removeDir, writeFile } from '../../helpers/gitRepo';

/** What the mocked VS Code answers and records. */
const ui = {
  answers: [] as Array<string | undefined>,
  messages: [] as string[],
  settings: {} as Record<string, unknown>,
  checksExit: 0,
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
        process.env.FLOTILLA_TEST_CHECKS_EXIT = String(ui.checksExit);
        const pty = await task.execution.callback();
        pty.open(undefined);
        return {};
      },
    },
  };
});

/** The checks: they print a failure and exit with ui.checksExit. */
const CHECKS = `node -e "console.log('FAIL a.test.ts: expected 1, got 2'); process.exit(Number(process.env.FLOTILLA_TEST_CHECKS_EXIT))"`;

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));
beforeEach(() => {
  ui.answers = [];
  ui.messages = [];
  ui.settings = { 'merge.checkCommand': CHECKS };
  ui.checksExit = 0;
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

// The fake GitHub's timeline (scripts/fake-github.mjs): a branch's first read makes its runs; the CI run then waits
// 6 s, runs for 25 s and fails in its tests. Run again, it passes.
const DONE_MS = 40_000;
const HOUR = 3_600_000;
let clock = 0;
let fake: FakeGitHub;
afterEach(async () => {
  await fake?.close();
});

/** A repository whose branches are pushed to a (local) origin, and run on push by a workflow, as the fake GitHub's. */
async function setup(items: BacklogItem[], o: { reader?: string; ciPollMs?: number } = {}) {
  const { LocalBacklog } = await import('../../../src/features/backlog/localBacklog');
  const { Merger } = await import('../../../src/ui/backlog/merge');
  const repo = initRepo();
  const origin = makeTempDir();
  const home = makeTempDir();
  cleanup.push(repo, origin, home);
  git(origin, 'init', '-q', '--bare');
  git(repo, 'remote', 'add', 'origin', origin);
  commit(repo, '.github/workflows/ci.yml', 'name: CI\non: push\njobs: {}\n', 'CI');
  clock = Date.now();
  fake = await startFakeGitHub({ port: 0, repoDir: repo, now: () => clock });
  const backlog = new LocalBacklog(home, path.join(repo, '.git'));
  await backlog.change(() => ({ version: 1, next: 1, items }));
  const repository = { current: [{ key: 'main', worktree: { branch: 'main', path: repo, isMain: true }, chats: [] }] };
  const reader = new GitHubActions('playground', 'app', async () => 'fake-token', globalThis.fetch as unknown as Fetch, fake.url);
  const updates: string[] = [];
  const fixes: Array<[string, number, number | undefined]> = [];
  const merger = new Merger({
    backlog,
    repository,
    mainRoot: repo,
    output: { appendLine() {} },
    openTicket() {},
    ciReader: async () => o.reader ?? reader,
    updateFromMain: async (id: string) => void updates.push(id),
    fixCi: async (branch: string, run: number, job?: number) => void fixes.push([branch, run, job]),
    ciPollMs: o.ciPollMs ?? 20,
  } as never);
  const item = async (id: string) => (await backlog.read()).items.find((i) => i.id === id)!;
  const activity = async (id: string) => (await backlog.readTicket(await item(id))).activity.map((e) => e.body).join('\n');
  /** A ticket's branch off main, with a commit, pushed to origin. */
  const branch = (name: string, file: string, id: string) => {
    git(repo, 'checkout', '-q', '-b', name, 'main');
    commit(repo, file, `${file}\n`, `${id}: add ${file}`);
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'push', '-q', 'origin', name);
  };
  const runsOf = (name: string) => reader.runs(name);
  return { repo, merger, item, activity, branch, runsOf, updates, fixes };
}

const until = async (done: () => Promise<boolean>) => {
  for (let i = 0; i < 200 && !(await done()); i++) await new Promise((r) => setTimeout(r, 20));
};

describe('Merge to main on CI (BL-105)', () => {
  it("merges on green CI without running the checks locally, and notes the runs it relied on", async () => {
    const { repo, merger, item, activity, branch, runsOf } = await setup([approved('BL-1')]);
    branch('feature/BL-1', 'a.txt', 'BL-1');
    const ci = (await runsOf('feature/BL-1')).find((r) => r.workflow === 'CI')!;
    clock += DONE_MS;
    await fetch(`${fake.url}/repos/playground/app/actions/runs/${ci.id}/rerun`, { method: 'POST' });
    clock += DONE_MS;

    expect(await merger.merge('BL-1')).toBe('merged');

    expect(ui.checks).toEqual([]);
    expect(git(repo, 'log', '-1', '--format=%s', 'main')).toBe('Merge BL-1: Item BL-1');
    expect((await item('BL-1')).status).toBe('done');
    expect(await activity('BL-1')).toContain(`CI passed on \`${git(repo, 'rev-parse', 'feature/BL-1').slice(0, 7)}\`: [CI #3](${ci.url}), [Deploy #1](`);
    merger.dispose();
  });

  it("waits while CI runs without holding up another ticket's merge, and then doesn't merge on CI for the tree before it", async () => {
    const { repo, merger, item, activity, branch, runsOf } = await setup([approved('BL-1'), approved('BL-2')]);
    branch('feature/BL-1', 'a.txt', 'BL-1');
    const ci = (await runsOf('feature/BL-1')).find((r) => r.workflow === 'CI')!;

    expect(await merger.merge('BL-1')).toBe('waiting');
    expect(merger.mergeProgress('BL-1')).toEqual({ ci: [expect.objectContaining({ workflow: 'CI', number: 3, status: 'queued' }), expect.objectContaining({ workflow: 'Deploy' })] });
    expect(await activity('BL-1')).toContain('Merges when CI passes: `feature/BL-1`');

    // BL-2 has no CI (not pushed): its merge goes ahead meanwhile, with the local checks.
    git(repo, 'checkout', '-q', '-b', 'feature/BL-2', 'main');
    commit(repo, 'b.txt', 'b\n', 'BL-2: add b');
    git(repo, 'checkout', '-q', 'main');
    expect(await merger.merge('BL-2')).toBe('merged');
    expect(ui.checks).toEqual([CHECKS]);
    expect(await activity('BL-2')).toContain("CI wasn't used: `feature/BL-2`'s tip");
    expect((await item('BL-1')).status).toBe('review');

    // BL-1's CI fails, is run again, and passes: but main has moved on (BL-2), so it isn't merged on it.
    clock += DONE_MS;
    await fetch(`${fake.url}/repos/playground/app/actions/runs/${ci.id}/rerun`, { method: 'POST' });
    clock += DONE_MS;
    await until(async () => !merger.mergeProgress('BL-1'));
    await until(async () => (await activity('BL-1')).includes('has moved on'));
    expect((await item('BL-1')).status).toBe('review');
    merger.dispose();
  });

  it('merges a waiting ticket once its CI passes', async () => {
    const { merger, item, branch, runsOf } = await setup([approved('BL-1')]);
    branch('feature/BL-1', 'a.txt', 'BL-1');
    const ci = (await runsOf('feature/BL-1')).find((r) => r.workflow === 'CI')!;
    clock += DONE_MS;
    await fetch(`${fake.url}/repos/playground/app/actions/runs/${ci.id}/rerun`, { method: 'POST' });

    expect(await merger.merge('BL-1')).toBe('waiting');
    clock += DONE_MS;
    await until(async () => (await item('BL-1')).status === 'done');

    expect((await item('BL-1')).status).toBe('done');
    expect(ui.checks).toEqual([]);
    merger.dispose();
  });

  it('merges nothing on red CI, and says which jobs failed, with their logs', async () => {
    const { repo, merger, activity, branch, runsOf } = await setup([approved('BL-1')]);
    branch('feature/BL-1', 'a.txt', 'BL-1');
    const ci = (await runsOf('feature/BL-1')).find((r) => r.workflow === 'CI')!;
    clock += DONE_MS;
    const before = git(repo, 'rev-parse', 'main');

    expect(await merger.merge('BL-1')).toBe('stopped');

    expect(git(repo, 'rev-parse', 'main')).toBe(before);
    expect(ui.checks).toEqual([]);
    const notes = await activity('BL-1');
    expect(notes).toContain('Not merged: CI failed on `feature/BL-1`');
    expect(notes).toMatch(new RegExp(`- Failed: \\[test\\]\\(https://github.com/playground/app/actions/runs/${ci.id}/job/\\d+\\) in \\[CI #3\\]`));
    expect(ui.messages).toContain('CI failed on feature/BL-1: BL-1 wasn\'t merged.');
    merger.dispose();
  });

  it('keeps why it stopped on red CI for the ticket, with the failed jobs, until the branch moves (BL-112)', async () => {
    const { repo, merger, branch, runsOf, fixes } = await setup([approved('BL-1')]);
    branch('feature/BL-1', 'a.txt', 'BL-1');
    const ci = (await runsOf('feature/BL-1')).find((r) => r.workflow === 'CI')!;
    clock += DONE_MS;
    const tip = git(repo, 'rev-parse', 'feature/BL-1');

    expect(await merger.merge('BL-1')).toBe('stopped');

    const stop = merger.ciStop('BL-1', () => tip);
    expect(stop).toMatchObject({ kind: 'failed', branch: 'feature/BL-1', tip, runs: [{ id: ci.id, workflow: 'CI', status: 'failure' }] });
    expect(stop?.kind === 'failed' && stop.jobs[0]).toMatchObject({ runId: ci.id, name: 'test', url: expect.stringContaining(`/actions/runs/${ci.id}/job/`) });
    expect(merger.ciStop('BL-1', () => undefined)).toEqual(stop);
    expect(merger.ciStop('BL-1', () => 'another tip')).toBeUndefined();
    await merger.fixCiStop('BL-1');
    expect(fixes).toEqual([['feature/BL-1', ci.id, stop?.kind === 'failed' ? stop.jobs[0].jobId : -1]]);
    merger.dispose();
  });

  it("doesn't merge on CI once main has moved on, and offers Update from Main", async () => {
    const { repo, merger, activity, branch, updates } = await setup([approved('BL-1')]);
    branch('feature/BL-1', 'a.txt', 'BL-1');
    commit(repo, 'm.txt', 'm\n', 'main moves on');
    const before = git(repo, 'rev-parse', 'main');
    ui.answers = ['Update from Main'];

    expect(await merger.merge('BL-1')).toBe('stopped');
    await until(async () => updates.length > 0);

    expect(git(repo, 'rev-parse', 'main')).toBe(before);
    expect(updates).toEqual(['BL-1']);
    expect(await activity('BL-1')).toContain("Not merged: `main` has moved on since `feature/BL-1` took it in");
    expect(merger.ciStop('BL-1', () => undefined)).toEqual({ kind: 'moved', branch: 'feature/BL-1', base: 'main', tip: git(repo, 'rev-parse', 'feature/BL-1') });
    merger.dispose();
  });

  it('runs the checks locally without GitHub, saying why, and always with the setting at local', async () => {
    const { merger, activity, branch } = await setup([approved('BL-1'), approved('BL-2')], { reader: "you aren't signed in to GitHub in VS Code." });
    branch('feature/BL-1', 'a.txt', 'BL-1');

    expect(await merger.merge('BL-1')).toBe('merged');
    expect(ui.checks).toEqual([CHECKS]);
    expect(await activity('BL-1')).toContain("The checks passed (`" + CHECKS + "`). CI wasn't used: you aren't signed in to GitHub in VS Code.");

    ui.settings['merge.checks'] = 'local';
    branch('feature/BL-2', 'b.txt', 'BL-2');
    expect(await merger.merge('BL-2')).toBe('merged');
    expect(ui.checks).toEqual([CHECKS, CHECKS]);
    expect(await activity('BL-2')).not.toContain("CI wasn't used");
    merger.dispose();
  });

  it('stops waiting when cancelled: nothing is merged', async () => {
    const { merger, item, activity, branch, runsOf } = await setup([approved('BL-1')], { ciPollMs: HOUR });
    branch('feature/BL-1', 'a.txt', 'BL-1');

    // No poll runs on its own (an hour apart), however slow the suite is: the test runs the one it scheduled, after the
    // cancel and once CI has passed, as a timer that fires late would, and waits for it to end (BL-120).
    const polls: Array<() => void> = [];
    const setTimer = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === HOUR) polls.push(fn);
      return setTimer(fn, ms);
    }) as typeof setTimeout);
    try {
      expect(await merger.merge('BL-1')).toBe('waiting');
    } finally {
      spy.mockRestore();
    }
    expect(polls).toHaveLength(1);
    await merger.cancelCiWait('BL-1');
    // CI then passes: its first run fails, run again it passes.
    const ci = (await runsOf('feature/BL-1')).find((r) => r.workflow === 'CI')!;
    clock += DONE_MS;
    await fetch(`${fake.url}/repos/playground/app/actions/runs/${ci.id}/rerun`, { method: 'POST' });
    clock += DONE_MS;
    const poll = vi.spyOn(merger as unknown as { pollCi(): Promise<void> }, 'pollCi');
    polls[0]();
    await poll.mock.results[0].value;

    expect(merger.mergeProgress('BL-1')).toBeUndefined();
    expect((await item('BL-1')).status).toBe('review');
    expect((await activity('BL-1')).split('\n').at(-1)).toBe('You cancelled the merge of `feature/BL-1` waiting for CI. Nothing was merged.');
    merger.dispose();
  });
});

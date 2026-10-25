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
import { startFakeGitHub, type FakeGitHub } from '../../../scripts/fake-github.mjs';
import { GitHubActions } from '../../../src/features/ci/githubActions';
import { failedJob, type FailedJob } from '../../../src/features/ci/failureTask';
import type { Fetch } from '../../../src/features/backlog/sources/source';
import type { BacklogItem } from '../../../src/features/backlog/backlog';
import {
  git,
  initRepo,
  makeTempDir,
  removeDir,
  writeFile,
} from '../../helpers/gitRepo';
import { eventsWritten, readEvents, setEventLog } from '../../../src/features/metrics/events';

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
  return {
    EventEmitter,
    window: { showInformationMessage: ask, showWarningMessage: ask, showErrorMessage: ask, showQuickPick: async () => undefined },
    workspace: { getConfiguration: () => ({ get: (k: string, d: unknown) => (k in ui.settings ? ui.settings[k] : d) }) },
    commands: { executeCommand: async () => undefined },
  };
});

/** The checks: they print a failure and exit with ui.checksExit. */
const CHECKS = `node -e "console.log('FAIL a.test.ts: expected 1, got 2'); process.exit(Number(process.env.FLOTILLA_TEST_CHECKS_EXIT))"`;

/** The checks' environment (Merger's checksEnv): the command really runs; CHECKS reads how to end from it. */
function fakeChecksEnv(command: string): NodeJS.ProcessEnv {
  ui.checks.push(command);
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.FLOTILLA_TEST_CHECKS_EXIT = String(ui.checksExit);
  return env;
}

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));
beforeEach(() => {
  ui.answers = [];
  ui.messages = [];
  ui.settings = { 'merge.checkCommand': CHECKS, 'merge.style': 'merge-commit' };
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
  const failures: Array<FailedJob | undefined> = [];
  const kept = new Map<string, unknown>();
  const state = { get: (k: string) => kept.get(k), update: async (k: string, v: unknown) => void kept.set(k, v) };
  const merger = new Merger({
    backlog,
    repository,
    mainRoot: repo,
    output: { appendLine() {} },
    openTicket() {},
    ciReader: async () => o.reader ?? reader,
    updateFromMain: async (id: string) => void updates.push(id),
    // As the CI view's fixOnOrigin does: the run read on the ref it ran on, its failed job for an agent on branch.
    fixCi: async (branch: string, run: number, job?: number, runBranch = branch) => {
      fixes.push([branch, run, job]);
      const found = (await reader.runs(runBranch, 30)).find((r) => r.id === run);
      // The log's redirect isn't over https from the fake: it isn't read.
      failures.push(found && (await failedJob({ jobs: (id) => reader.jobs(id), log: async () => '' }, branch, found, job)));
    },
    ciPollMs: o.ciPollMs ?? 20,
    checksEnv: fakeChecksEnv,
    state,
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
  const queue = async () => (await backlog.read()).mergeQueue ?? [];
  /** origin's branches of the merge train (BL-145), with their commits. */
  const trainOnOrigin = () =>
    git(repo, 'ls-remote', 'origin', 'refs/heads/flotilla/merge-queue/*')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t').reverse().join(' '));
  return { repo, merger, item, activity, branch, runsOf, updates, fixes, failures, queue, trainOnOrigin };
}

/** Waits until done, up to 25 s (under the suite's 30 s timeout): a loaded machine polls and merges slowly (BL-120). */
const until = async (done: () => Promise<boolean>) => {
  for (const end = Date.now() + 25_000; Date.now() < end && !(await done());) await new Promise((r) => setTimeout(r, 20));
};

describe('Merge to main on CI (BL-105)', () => {
  it('merges on green CI without running the checks locally, and notes the runs it relied on', async () => {
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

  it("waits while CI runs without holding up another ticket's merge, and then lands from the train, not on CI for the tree before it", async () => {
    const { repo, merger, item, activity, branch, runsOf } = await setup([approved('BL-1'), approved('BL-2')]);
    branch('feature/BL-1', 'a.txt', 'BL-1');
    const ci = (await runsOf('feature/BL-1')).find((r) => r.workflow === 'CI')!;

    expect(await merger.merge('BL-1')).toBe('waiting');
    expect(merger.mergeProgress('BL-1')).toEqual({
      ci: [expect.objectContaining({ workflow: 'CI', number: 3, status: 'queued' }), expect.objectContaining({ workflow: 'Deploy' })],
    });
    expect(await activity('BL-1')).toContain('Merges when CI passes: `feature/BL-1`');

    // BL-2 has no CI (not pushed): its merge goes ahead meanwhile, with the local checks.
    git(repo, 'checkout', '-q', '-b', 'feature/BL-2', 'main');
    commit(repo, 'b.txt', 'b\n', 'BL-2: add b');
    git(repo, 'checkout', '-q', 'main');
    // BL-1 is ahead of it in the merge queue: BL-2 is merged alone.
    ui.answers = ['Merge BL-2 Alone', "Don't Push"];
    expect(await merger.merge('BL-2')).toBe('merged');
    expect(ui.checks).toEqual([CHECKS]);
    expect(await activity('BL-2')).toContain("CI wasn't used: `feature/BL-2`'s tip");
    expect((await item('BL-1')).status).toBe('review');

    // BL-1's CI fails, is run again, and passes: but main has moved on (BL-2), so it isn't what lands. It lands from the
    // merge train, on BL-2: not pushed (you said no), with the local checks on its merge commit there.
    clock += DONE_MS;
    await fetch(`${fake.url}/repos/playground/app/actions/runs/${ci.id}/rerun`, { method: 'POST' });
    clock += DONE_MS;
    // The merge's note comes after the status (finish moves it to Done first): it's what's waited for.
    const notPushed = "CI wasn't used: the merge train isn't pushed to origin (you chose not to push it).";
    await until(async () => (await activity('BL-1')).includes(notPushed));
    expect(await activity('BL-1')).toContain(notPushed);
    expect((await item('BL-1')).status).toBe('done');
    expect(ui.checks).toEqual([CHECKS, CHECKS]);
    expect(await activity('BL-1')).not.toContain('has moved on');
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
    expect(ui.messages).toContain("CI failed on feature/BL-1: BL-1 wasn't merged, and is out of the merge queue.");
    merger.dispose();
  });

  it('keeps why it stopped on red CI for the ticket, with the failed jobs, until the branch moves (BL-112)', async () => {
    const { repo, merger, branch, runsOf, fixes } = await setup([approved('BL-1')]);
    branch('feature/BL-1', 'a.txt', 'BL-1');
    const ci = (await runsOf('feature/BL-1')).find((r) => r.workflow === 'CI')!;
    clock += DONE_MS;
    const tip = git(repo, 'rev-parse', 'feature/BL-1');
    const log = makeTempDir();
    setEventLog(log);

    expect(await merger.merge('BL-1')).toBe('stopped');

    await eventsWritten();
    setEventLog(undefined);
    expect((await readEvents(log)).filter((e) => e.kind === 'merge-ci-stopped')).toEqual([
      expect.objectContaining({ ticket: 'BL-1', data: { reason: 'failed', branch: 'feature/BL-1', jobs: ['test'] } }),
    ]);
    const stop = merger.ciStop('BL-1', () => tip);
    expect(stop).toMatchObject({ kind: 'failed', branch: 'feature/BL-1', tip, runs: [{ id: ci.id, workflow: 'CI', status: 'failure' }] });
    expect(stop?.kind === 'failed' && stop.jobs[0]).toMatchObject({ runId: ci.id, name: 'test', url: expect.stringContaining(`/actions/runs/${ci.id}/job/`) });
    expect(merger.ciStop('BL-1', () => undefined)).toEqual(stop);
    expect(merger.ciStop('BL-1', () => 'another tip')).toBeUndefined();
    await merger.fixCiStop('BL-1');
    expect(fixes).toEqual([['feature/BL-1', ci.id, stop?.kind === 'failed' ? stop.jobs[0].jobId : -1]]);
    merger.dispose();
  });

  it('runs the checks locally without GitHub, saying why, and always with the setting at local', async () => {
    const { merger, activity, branch } = await setup([approved('BL-1'), approved('BL-2')], { reader: "you aren't signed in to GitHub in VS Code." });
    branch('feature/BL-1', 'a.txt', 'BL-1');

    expect(await merger.merge('BL-1')).toBe('merged');
    expect(ui.checks).toEqual([CHECKS]);
    expect(await activity('BL-1')).toContain('The checks passed (`' + CHECKS + "`). CI wasn't used: you aren't signed in to GitHub in VS Code.");

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

describe('Landing from the merge train on CI (BL-145)', () => {
  const PUSH_QUESTION = 'Push the merge train to origin, for CI to run on it?';

  /** Runs the merge's polls of CI by hand: none runs on its own (an hour apart), however slow the suite is (BL-120). */
  async function byHand<T>(merger: unknown, run: () => Promise<T>): Promise<{ result: T; poll(): Promise<void> }> {
    const polls: Array<() => void> = [];
    const setTimer = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === HOUR) polls.push(fn);
      return setTimer(fn, ms);
    }) as typeof setTimeout);
    try {
      const result = await run();
      return {
        result,
        poll: async () => {
          const poll = vi.spyOn(merger as { pollCi(): Promise<void> }, 'pollCi');
          polls.shift()!();
          await poll.mock.results.at(-1)!.value;
          poll.mockRestore();
        },
      };
    } finally {
      spy.mockRestore();
    }
  }

  it('pushes the train once you let it, waits for CI on its commit there, and lands it when CI passes', async () => {
    const { repo, merger, item, activity, branch, runsOf, queue, trainOnOrigin, updates } = await setup([approved('BL-1')], { ciPollMs: HOUR });
    branch('feature/BL-1', 'a.txt', 'BL-1');
    // main moves on: CI on the branch isn't for what lands, so CI on its commit in the train decides.
    commit(repo, 'm.txt', 'm\n', 'main moves on');
    ui.answers = ['Push the Train'];

    const { result, poll } = await byHand(merger, () => merger.merge('BL-1'));

    expect(result).toBe('waiting');
    const inTrain = git(repo, 'rev-parse', 'flotilla/train');
    expect(trainOnOrigin()).toEqual([`refs/heads/flotilla/merge-queue/BL-1 ${inTrain}`]);
    expect(merger.mergeProgress('BL-1')).toEqual({
      ci: [expect.objectContaining({ workflow: 'CI', status: 'queued' }), expect.objectContaining({ workflow: 'Deploy' })],
    });
    expect(await activity('BL-1')).toContain(`Merges when CI passes: \`flotilla/merge-queue/BL-1\` at \`${inTrain.slice(0, 7)}\``);
    expect(await queue()).toEqual(['BL-1']);

    // CI on the train commit fails, is run again, and passes.
    const ci = (await runsOf('flotilla/merge-queue/BL-1')).find((r) => r.workflow === 'CI')!;
    clock += DONE_MS;
    await fetch(`${fake.url}/repos/playground/app/actions/runs/${ci.id}/rerun`, { method: 'POST' });
    clock += DONE_MS;
    await poll();

    expect((await item('BL-1')).status).toBe('done');
    expect(git(repo, 'rev-parse', 'main')).toBe(inTrain);
    expect(ui.checks).toEqual([]);
    expect(updates).toEqual([]);
    expect(await activity('BL-1')).toContain(`CI passed on \`${inTrain.slice(0, 7)}\`: [CI #3](${ci.url})`);
    expect(await queue()).toEqual([]);
    // Landed: its train branch is gone from origin.
    expect(trainOnOrigin()).toEqual([]);
    expect(ui.messages.filter((m) => m === PUSH_QUESTION)).toHaveLength(1);
    merger.dispose();
  });

  it('takes a ticket out of the queue on red CI on its train commit, with the failed jobs, and rebuilds the train without it', async () => {
    const { repo, merger, item, activity, branch, queue, trainOnOrigin, fixes, failures } = await setup([approved('BL-1'), approved('BL-2')], {
      ciPollMs: HOUR,
    });
    branch('feature/BL-1', 'a.txt', 'BL-1');
    commit(repo, 'm.txt', 'm\n', 'main moves on');
    const before = git(repo, 'rev-parse', 'main');
    ui.answers = ['Push the Train'];
    const { result, poll } = await byHand(merger, () => merger.merge('BL-1'));
    expect(result).toBe('waiting');

    // CI fails on it.
    clock += DONE_MS;
    await poll();

    expect(git(repo, 'rev-parse', 'main')).toBe(before);
    expect((await item('BL-1')).status).toBe('review');
    expect(await queue()).toEqual([]);
    expect(trainOnOrigin()).toEqual([]);
    const notes = await activity('BL-1');
    expect(notes).toContain('Not merged: CI failed on `flotilla/merge-queue/BL-1`');
    expect(notes).toMatch(/- Failed: \[test\]\(https:\/\/github.com\/playground\/app\/actions\/runs\/\d+\/job\/\d+\) in \[CI #3\]/);
    expect(notes).toContain('BL-1 is out of the merge queue: the train is rebuilt without it.');
    expect(ui.messages.some((m) => m.startsWith("CI failed on BL-1's commit in the merge train (flotilla/merge-queue/BL-1)"))).toBe(true);
    const tip = git(repo, 'rev-parse', 'feature/BL-1');
    const stop = merger.ciStop('BL-1', () => tip);
    expect(stop).toMatchObject({ kind: 'failed', branch: 'feature/BL-1', tip, runBranch: 'flotilla/merge-queue/BL-1' });
    // Fix with Agent finds the run on the train branch (deleted from origin by now: GitHub keeps its runs), and gives
    // the agent the ticket's branch to fix.
    await merger.fixCiStop('BL-1');
    expect(fixes).toEqual([['feature/BL-1', stop?.kind === 'failed' ? stop.runs[0].id : -1, stop?.kind === 'failed' ? stop.jobs[0].jobId : -1]]);
    expect(failures).toEqual([expect.objectContaining({ branch: 'feature/BL-1', job: expect.objectContaining({ name: 'test' }), failedSteps: ['Run tests'] })]);

    // Another ticket lands by the train the same way: the push isn't asked again.
    branch('feature/BL-2', 'b.txt', 'BL-2');
    commit(repo, 'n.txt', 'n\n', 'main moves on again');
    expect(await merger.merge('BL-2')).toBe('waiting');
    expect(trainOnOrigin()).toEqual([`refs/heads/flotilla/merge-queue/BL-2 ${git(repo, 'rev-parse', 'flotilla/train')}`]);
    expect(ui.messages.filter((m) => m === PUSH_QUESTION)).toHaveLength(1);
    merger.dispose();
  });

  it('stops pushing the train when you take it back: deletes its branches on origin, and asks again next time (BL-196)', async () => {
    const { repo, merger, item, branch, trainOnOrigin } = await setup([approved('BL-1')], { ciPollMs: HOUR });
    branch('feature/BL-1', 'a.txt', 'BL-1');
    commit(repo, 'm.txt', 'm\n', 'main moves on');
    ui.answers = ['Push the Train'];
    const { result, poll } = await byHand(merger, () => merger.merge('BL-1'));
    expect(result).toBe('waiting');
    expect(trainOnOrigin()).toHaveLength(1);

    // Asked first: cancelled, nothing changes.
    ui.answers = [undefined];
    expect(await merger.stopPushingTrain()).toBe(false);
    expect(trainOnOrigin()).toHaveLength(1);

    ui.answers = ['Stop Pushing'];
    expect(await merger.stopPushingTrain()).toBe(true);
    expect(trainOnOrigin()).toEqual([]);
    expect(ui.messages).toContain('Stop pushing the merge train to origin?');

    // The next landing by the train asks again; not pushed, its commit is checked locally.
    ui.answers = ["Don't Push"];
    clock += DONE_MS;
    await poll();
    await until(async () => (await item('BL-1')).status === 'done');

    expect((await item('BL-1')).status).toBe('done');
    expect(ui.messages.filter((m) => m === PUSH_QUESTION)).toHaveLength(2);
    expect(ui.checks).toEqual([CHECKS]);
    expect(trainOnOrigin()).toEqual([]);
    merger.dispose();
  });

  it("checks the train's commits locally when you don't let it be pushed", async () => {
    const { repo, merger, item, activity, branch, trainOnOrigin } = await setup([approved('BL-1')]);
    branch('feature/BL-1', 'a.txt', 'BL-1');
    commit(repo, 'm.txt', 'm\n', 'main moves on');
    ui.answers = ["Don't Push"];

    expect(await merger.merge('BL-1')).toBe('merged');

    expect((await item('BL-1')).status).toBe('done');
    expect(ui.checks).toEqual([CHECKS]);
    expect(await activity('BL-1')).toContain("CI wasn't used: the merge train isn't pushed to origin (you chose not to push it).");
    expect(trainOnOrigin()).toEqual([]);
    merger.dispose();
  });
});

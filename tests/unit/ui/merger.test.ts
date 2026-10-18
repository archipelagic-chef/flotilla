import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  const processEnded = new EventEmitter<{ execution: unknown; exitCode: number | undefined }>();
  const taskEnded = new EventEmitter<{ execution: unknown }>();
  return {
    EventEmitter,
    window: { showInformationMessage: ask, showWarningMessage: ask, showErrorMessage: ask, showQuickPick: async () => undefined },
    workspace: { getConfiguration: () => ({ get: (k: string, d: unknown) => (k in ui.settings ? ui.settings[k] : d) }) },
    commands: { executeCommand: async () => undefined },
    Task: class {
      presentationOptions: unknown;
      constructor(
        _d: unknown,
        _s: unknown,
        _n: string,
        _src: string,
        readonly execution: { command: string },
      ) {}
    },
    ShellExecution: class {
      constructor(readonly command: string) {}
    },
    TaskScope: { Workspace: 2 },
    TaskRevealKind: { Always: 1 },
    TaskPanelKind: { Dedicated: 2 },
    tasks: {
      onDidEndTaskProcess: processEnded.event,
      onDidEndTask: taskEnded.event,
      executeTask: async (task: { execution: { command: string } }) => {
        ui.checks.push(task.execution.command);
        const execution = {};
        setTimeout(() => processEnded.fire({ execution, exitCode: ui.checksExit }), 5);
        return execution;
      },
    },
  };
});

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));
beforeEach(() => {
  ui.answers = [];
  ui.messages = [];
  ui.settings = { 'merge.checkCommand': 'run-the-checks' };
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
    expect(ui.checks).toEqual(['run-the-checks']);
    const done = await item('BL-1');
    expect(done.status).toBe('done');
    expect(done.merged).toMatchObject({ into: 'main', commit: git(repo, 'rev-parse', 'main') });
    const activity = (await backlog.readTicket(done)).activity.map((e) => e.body).join('\n');
    expect(activity).toContain('Merged it into **main**');
    expect(activity).toContain('Merged `feature/BL-1-one` into `main`: 1 commit');
    expect(activity).toContain('Nothing was pushed.');
    merger.dispose();
  });

  it('changes nothing when the checks fail', async () => {
    const { repo, merger, item, worktrees } = await setup([approved('BL-1')]);
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 'a.txt', 'a\n', 'BL-1: add a');
    git(repo, 'checkout', '-q', 'main');
    const before = git(repo, 'rev-parse', 'main');
    ui.checksExit = 1;

    expect(await merger.merge('BL-1')).toBe('stopped');

    expect(git(repo, 'rev-parse', 'main')).toBe(before);
    expect(worktrees()).toBe(1);
    expect((await item('BL-1')).status).toBe('review');
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

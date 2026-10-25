import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const warnings = vi.hoisted(() => [] as string[]);
const infos = vi.hoisted(() => [] as string[]);
vi.mock('vscode', () => ({
  window: {
    showWarningMessage: async (m: string) => void warnings.push(m),
    showInformationMessage: async (m: string) => void infos.push(m),
  },
}));
vi.mock('../../../src/ui/settings', () => ({ readSettings: () => ({ defaultBase: '' }) }));

import { addBranch, addItem, updateItem } from '../../../src/features/backlog/backlog';
import { LocalBacklog } from '../../../src/features/backlog/localBacklog';
import { MainSync } from '../../../src/ui/backlog/mainSync';
import {
  git,
  initRepo,
  removeDir,
  writeFile,
} from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) removeDir(d);
});

describe('keeping open tickets current with main', () => {
  let repo: string;
  let wt: string;
  let store: LocalBacklog;
  let sync: MainSync;
  let handed: Array<{ id: string; prompt: string }>;
  let agentRunning: boolean;

  beforeEach(async () => {
    warnings.length = 0;
    infos.length = 0;
    repo = initRepo();
    cleanup.push(repo);
    writeFile(repo, 'a.txt', 'one\ntwo\nthree\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    wt = path.join(repo, '.worktrees', 'bl1');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature/BL-1-x', wt);
    store = new LocalBacklog(repo, path.join(repo, '.git'));
    await store.change((d) => {
      const added = addItem(d, 'X', 'BL', new Date()).data;
      return updateItem(addBranch(added, 'BL-1', 'feature/BL-1-x'), 'BL-1', { status: 'doing' });
    });
    handed = [];
    agentRunning = false;
    const ws = { key: 'bl1', worktree: { isMain: false, path: wt, branch: 'feature/BL-1-x' }, chats: [], changes: [] as unknown[], sync: {} };
    sync = new MainSync({
      backlog: store,
      repository: { current: [ws], onDidChange: () => ({ dispose() {} }) } as never,
      reviews: {
        isRunning: () => false,
        handToImplementer: async (id: string, t: { prompt: string }) => !agentRunning && handed.push({ id, prompt: t.prompt }) > 0,
      } as never,
      mainRoot: repo,
      isLeader: () => true,
      output: { appendLine: () => undefined } as never,
    });
  });

  afterEach(() => sync.dispose());

  const commitIn = (dir: string, content: string) => {
    writeFile(dir, 'a.txt', content);
    git(dir, 'commit', '-q', '-am', `BL-1: ${content.trim().replace(/\n/g, ' ')}`);
  };
  const item = async () => (await store.read()).items[0];
  const activity = async () => (await store.readTicket(await item())).activity.map((e) => e.body);

  it('notes on the ticket when its branch comes to conflict with main, and when it no longer does', async () => {
    commitIn(wt, 'one\nTWO\nthree\n');
    await sync.check();
    expect((await item()).mainCheck?.branches).toEqual([{ branch: 'feature/BL-1-x', head: git(wt, 'rev-parse', 'HEAD'), conflicts: [] }]);
    expect(await activity()).toEqual([]);

    commitIn(repo, 'one\n2\nthree\n');
    await sync.check();
    expect((await item()).mainCheck?.branches[0].conflicts).toEqual(['a.txt']);
    expect((await activity()).at(-1)).toContain('now conflicts with main (`a.txt`)');

    // The branch takes main's line: it merges cleanly again.
    commitIn(wt, 'one\n2\nthree\n');
    await sync.check();
    expect((await item()).mainCheck?.branches[0].conflicts).toEqual([]);
    expect((await activity()).at(-1)).toBe('Branch `feature/BL-1-x` merges cleanly with main again.');
  });

  it('drops the last check of a ticket that is done, so it no longer shows a conflict', async () => {
    commitIn(wt, 'one\nTWO\nthree\n');
    commitIn(repo, 'one\n2\nthree\n');
    await sync.check();
    expect((await item()).mainCheck?.branches[0].conflicts).toEqual(['a.txt']);

    await store.change((d) => updateItem(d, 'BL-1', { status: 'done' }));
    await sync.check();
    expect((await item()).mainCheck).toBeUndefined();
  });

  it('Update from Main rebases the branch onto main when that goes cleanly: no merge commit', async () => {
    commitIn(wt, 'one\ntwo\nTHREE\n');
    const own = git(wt, 'log', '-1', '--format=%s');
    commitIn(repo, 'ONE\ntwo\nthree\n');
    await sync.update('BL-1');
    expect(git(wt, 'log', '-1', '--format=%s')).toBe(own);
    expect(git(wt, 'rev-parse', 'HEAD^')).toBe(git(repo, 'rev-parse', 'main'));
    expect(git(wt, 'show', 'HEAD:a.txt')).toBe('ONE\ntwo\nTHREE');
    expect((await activity()).at(-1)).toBe('Rebased `feature/BL-1-x` onto main (Update from Main).');
    expect(infos).toEqual(['BL-1: Rebased feature/BL-1-x onto main.']);
    expect(handed).toEqual([]);
  });

  it('Update from Main says so when the branch already has main', async () => {
    commitIn(wt, 'one\ntwo\nTHREE\n');
    await sync.update('BL-1');
    expect(infos).toEqual(['BL-1: feature/BL-1-x is already up to date with main.']);
    expect((await activity()).at(-1)).toBe('`feature/BL-1-x` is already up to date with main.');
  });

  it("Update from Main hands a conflicting rebase to the ticket's agent, leaving the worktree as it was", async () => {
    commitIn(wt, 'one\nTWO\nthree\n');
    commitIn(repo, 'one\n2\nthree\n');
    const head = git(wt, 'rev-parse', 'HEAD');
    await sync.update('BL-1');
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(wt, 'status', '--porcelain')).toBe('');
    expect(handed).toHaveLength(1);
    expect(handed[0].prompt).toContain('git rebase main');
    expect(handed[0].prompt).toContain('a.txt');
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatch(/^BL-1: rebasing feature\/BL-1-x onto main conflicts \(a\.txt\), so its agent/);
  });

  it('Update from Main warns, rather than saying it was handed, when an agent already runs on the ticket', async () => {
    commitIn(wt, 'one\nTWO\nthree\n');
    commitIn(repo, 'one\n2\nthree\n');
    agentRunning = true;
    await sync.update('BL-1');
    expect(handed).toHaveLength(0);
    expect(infos).toHaveLength(0);
    expect(warnings).toEqual([
      "BL-1: rebasing feature/BL-1-x onto main conflicts (a.txt), and an agent is already working on it: update it from main when it's done.",
    ]);
  });
});

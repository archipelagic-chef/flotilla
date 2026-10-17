import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const warnings = vi.hoisted(() => [] as string[]);
vi.mock('vscode', () => ({
  window: { showWarningMessage: async (m: string) => void warnings.push(m) },
}));
vi.mock('../../../src/ui/settings', () => ({ readSettings: () => ({ defaultBase: '' }) }));

import { addBranch, addItem, updateItem } from '../../../src/features/backlog/backlog';
import { LocalBacklog } from '../../../src/features/backlog/localBacklog';
import { MainSync } from '../../../src/ui/backlog/mainSync';
import { git, initRepo, removeDir, writeFile } from '../../helpers/gitRepo';

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

  beforeEach(async () => {
    warnings.length = 0;
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
    const ws = { key: 'bl1', worktree: { isMain: false, path: wt, branch: 'feature/BL-1-x' }, chats: [], changes: [] as unknown[], sync: {} };
    sync = new MainSync({
      backlog: store,
      repository: { current: [ws], onDidChange: () => ({ dispose() {} }) } as never,
      reviews: { isRunning: () => false, handToImplementer: async (id: string, t: { prompt: string }) => void handed.push({ id, prompt: t.prompt }) } as never,
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

  it('Update from Main merges main into the branch when it merges cleanly', async () => {
    commitIn(wt, 'one\ntwo\nTHREE\n');
    commitIn(repo, 'ONE\ntwo\nthree\n');
    await sync.update('BL-1');
    expect(git(wt, 'log', '-1', '--format=%s')).toBe('BL-1: Merge main into feature/BL-1-x');
    expect(git(wt, 'show', 'HEAD:a.txt')).toBe('ONE\ntwo\nTHREE');
    expect((await activity()).at(-1)).toBe('Merged main into `feature/BL-1-x` (Update from Main).');
    expect(handed).toEqual([]);
  });

  it('Update from Main hands a conflicting merge to the ticket\'s agent, leaving the worktree as it was', async () => {
    commitIn(wt, 'one\nTWO\nthree\n');
    commitIn(repo, 'one\n2\nthree\n');
    const head = git(wt, 'rev-parse', 'HEAD');
    await sync.update('BL-1');
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(wt, 'status', '--porcelain')).toBe('');
    expect(handed).toHaveLength(1);
    expect(handed[0].prompt).toContain('git merge main');
    expect(handed[0].prompt).toContain('a.txt');
  });
});

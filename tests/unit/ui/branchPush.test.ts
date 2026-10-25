import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const setting = vi.hoisted(() => ({ value: 'on' }));
vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => setting.value ?? d }) },
}));

import { addBranch, addItem, updateItem } from '../../../src/features/backlog/backlog';
import { LocalBacklog } from '../../../src/features/backlog/localBacklog';
import { BranchPush } from '../../../src/ui/backlog/branchPush';
import {
  git,
  initRepo,
  makeTempDir,
  removeDir,
  writeFile,
} from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

const BRANCH = 'feature/BL-1-x';

describe('pushing approved tickets’ branches', () => {
  let repo: string;
  let origin: string;
  let store: LocalBacklog;
  let pushes: BranchPush;

  beforeEach(async () => {
    setting.value = 'on';
    repo = initRepo();
    origin = makeTempDir();
    cleanup.push(repo, origin);
    git(origin, 'init', '-q', '--bare');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'checkout', '-q', '-b', BRANCH);
    store = new LocalBacklog(repo, path.join(repo, '.git'));
    await store.change((d) => updateItem(addBranch(addItem(d, 'X', 'BL', new Date()).data, 'BL-1', BRANCH), 'BL-1', { status: 'review' }));
    pushes = new BranchPush({
      backlog: store,
      repository: { current: [], onDidChange: () => ({ dispose() {} }) } as never,
      mainRoot: repo,
      isLeader: () => true,
      output: { appendLine: () => undefined } as never,
    });
  });

  afterEach(() => pushes.dispose());

  const commit = (content: string) => {
    writeFile(repo, 'a.txt', content);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', `BL-1: ${content}`);
    return git(repo, 'rev-parse', 'HEAD');
  };
  const approve = () =>
    store.change((d) => ({ ...d, items: d.items.map((i) => ({ ...i, review: { round: 1, reviewer: 'Rex-1', state: 'approved' as const } })) }));
  const item = async () => (await store.read()).items[0];
  const notes = async () => (await store.readTicket(await item())).activity.map((e) => e.body).filter((b) => /push/i.test(b));
  const onOrigin = () => git(origin, 'for-each-ref', '--format=%(objectname)', `refs/heads/${BRANCH}`);

  it("doesn't push a ticket that isn't approved", async () => {
    commit('one');
    await pushes.check();
    expect(onOrigin()).toBe('');
  });

  it('pushes on approval, again on new commits, and each tip once', async () => {
    const one = commit('one');
    await approve();
    pushes.approved('BL-1');
    await pushes.check();
    expect(onOrigin()).toBe(one);
    expect((await item()).pushed).toEqual([{ branch: BRANCH, commit: one }]);
    expect(await notes()).toEqual([`Pushed \`${BRANCH}\` to origin at \`${one.slice(0, 7)}\` (2 new commits), so CI runs on it.`]);

    await pushes.check();
    expect(await notes()).toHaveLength(1);

    const two = commit('two');
    await pushes.check();
    expect(onOrigin()).toBe(two);
    expect((await item()).pushed).toEqual([{ branch: BRANCH, commit: two }]);
    expect(await notes()).toHaveLength(2);
  });

  it('notes a refused push once per tip, and tries again when approved again', async () => {
    git(repo, '-c', 'user.name=Someone', '-c', 'user.email=s@example.com', 'commit', '-q', '--allow-empty', '-m', 'BL-1: theirs');
    await approve();
    await pushes.check();
    await pushes.check();
    expect(onOrigin()).toBe('');
    expect((await item()).pushed?.[0].error).toBe('identity');
    expect(await notes()).toHaveLength(1);
    pushes.approved('BL-1');
    await pushes.check();
    expect(await notes()).toHaveLength(2);
  });

  it('pushes nothing when the setting is off', async () => {
    setting.value = 'off';
    commit('one');
    await approve();
    pushes.approved('BL-1');
    await pushes.check();
    expect(onOrigin()).toBe('');
    expect((await item()).pushed).toBeUndefined();
  });

  it('pushes only to a local origin while the fake GitHub is on', async () => {
    const local = new BranchPush({
      backlog: store,
      repository: { current: [], onDidChange: () => ({ dispose() {} }) } as never,
      mainRoot: repo,
      isLeader: () => true,
      output: { appendLine: () => undefined } as never,
      localOnly: true,
    });
    try {
      const one = commit('one');
      await approve();
      git(repo, 'remote', 'set-url', '--push', 'origin', 'https://github.com/playground/app.git');
      await local.check();
      expect((await item()).pushed).toBeUndefined();
      expect(await notes()).toEqual([]);
      git(repo, 'config', '--unset', 'remote.origin.pushurl');
      await local.check();
      expect(onOrigin()).toBe(one);
    } finally {
      local.dispose();
    }
  });
});

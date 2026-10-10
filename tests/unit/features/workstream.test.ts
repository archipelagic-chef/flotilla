import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWorkstreams, findWorkstreamFor, type BuildOptions, type Workstream } from '../../../src/features/workstreams/workstream';
import { WorktreeService } from '../../../src/features/worktrees/worktreeService';
import { git, initRepo, makeStatDirty, removeDir, writeFile } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

const options = (currentWorktreeRoot: string): BuildOptions => ({
  currentWorktreeRoot,
  claudeHome: '/nonexistent-claude-home',
  settings: { activeWindowMinutes: 5, staleAfterDays: 7, agentStatusStaleMinutes: 10, defaultBase: '' },
  now: new Date(),
});

describe('buildWorkstreams', () => {
  it('combines signals and sorts by attention', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const service = new WorktreeService({ mainRoot: repo, commonDir: path.join(repo, '.git') }, () => ({ autoAdopt: true }));
    const a = await service.create({ kind: 'new', branch: 'a' });
    const b = await service.create({ kind: 'new', branch: 'b' });
    writeFile(a.path!, 'new.txt', 'x\n');
    fs.writeFileSync(
      path.join(b.adminDir, 'workstream.json'),
      JSON.stringify({ state: 'waiting-for-input', message: 'Need approval', updatedAt: new Date().toISOString() }),
    );

    const items = await buildWorkstreams(service, options(repo));
    expect(items[0]).toMatchObject({ attention: 'waiting-for-input', agent: { message: 'Need approval' } });
    expect(items[0].worktree.branch).toBe('b');
    const aItem = items.find((i) => i.worktree.branch === 'a')!;
    expect(aItem.changes).toEqual([{ path: 'new.txt', kind: 'untracked' }]);
    expect(aItem.unstaged).toEqual([{ path: 'new.txt', kind: 'untracked' }]);
    expect(aItem.staged).toEqual([]);
    expect(aItem.sync).toEqual({ upstream: undefined, ahead: 0, behind: 0, hasRemote: false });
    expect(aItem.attention).toBe('active');
    expect(aItem.progress).toMatchObject({ base: 'main', ahead: 0, behind: 0 });
    const main = items.find((i) => i.worktree.isMain)!;
    expect(main.isCurrent).toBe(true);
    expect(main.key).toBe(main.worktree.adminDir);
  });

  it('derives the agent state from the most urgent open chat', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const service = new WorktreeService({ mainRoot: repo, commonDir: path.join(repo, '.git') }, () => ({ autoAdopt: true }));
    const a = await service.create({ kind: 'new', branch: 'a' });
    const chats = path.join(a.adminDir, 'flotilla', 'chats');
    fs.mkdirSync(chats, { recursive: true });
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(chats, 'one.json'), JSON.stringify({ sessionId: 'one', state: 'working', updatedAt: at }));
    fs.writeFileSync(path.join(chats, 'two.json'), JSON.stringify({ sessionId: 'two', state: 'waiting-for-input', message: 'Proceed?', updatedAt: at }));
    // The legacy file loses to chat records.
    fs.writeFileSync(path.join(a.adminDir, 'workstream.json'), JSON.stringify({ state: 'done', updatedAt: at }));

    const item = (await buildWorkstreams(service, options(repo))).find((i) => i.key === a.adminDir)!;
    expect(item.chats.map((c) => c.id)).toEqual(['two', 'one']);
    expect(item.agent).toMatchObject({ state: 'waiting-for-input', message: 'Proceed?' });
    expect(item.attention).toBe('waiting-for-input');
    expect(item.hasHooks).toBe(false);
  });

  it('reports staged changes and the upstream state', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const service = new WorktreeService({ mainRoot: repo, commonDir: path.join(repo, '.git') }, () => ({ autoAdopt: true }));
    git(repo, 'remote', 'add', 'origin', repo);
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'branch', '-q', '--set-upstream-to', 'origin/main');
    writeFile(repo, 'staged.txt', 'x\n');
    git(repo, 'add', 'staged.txt');
    git(repo, 'commit', '-q', '-m', 'local');
    writeFile(repo, 'next.txt', 'y\n');
    git(repo, 'add', 'next.txt');
    const a = await service.create({ kind: 'new', branch: 'a' });

    const items = await buildWorkstreams(service, options(repo));
    const main = items.find((i) => i.worktree.isMain)!;
    expect(main.staged).toEqual([{ path: 'next.txt', kind: 'added' }]);
    expect(main.sync).toEqual({ upstream: 'origin/main', ahead: 1, behind: 0, hasRemote: true });
    const aItem = items.find((i) => i.key === a.adminDir)!;
    expect(aItem.sync).toMatchObject({ upstream: undefined, hasRemote: true });
  });

  it('does not modify the git index while refreshing', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const service = new WorktreeService({ mainRoot: repo, commonDir: path.join(repo, '.git') }, () => ({ autoAdopt: true }));
    makeStatDirty(repo, ['one.txt', 'two.txt', 'three.txt']);
    writeFile(repo, 'README.md', 'changed but same size?\n');
    const index = path.join(repo, '.git', 'index');
    const before = fs.statSync(index).mtimeMs;
    const content = fs.readFileSync(index);
    await buildWorkstreams(service, options(repo));
    await buildWorkstreams(service, options(repo));
    expect(fs.statSync(index).mtimeMs).toBe(before);
    expect(fs.readFileSync(index).equals(content)).toBe(true);
  });
});

describe('findWorkstreamFor', () => {
  const ws = (p: string | undefined) => ({ worktree: { path: p } as Workstream['worktree'] });
  const items = [ws('/r'), ws('/r/.worktrees/a'), ws(undefined), ws('/elsewhere/b')];
  it('picks the innermost worktree containing the path', () => {
    expect(findWorkstreamFor(items, '/r/.worktrees/a/src/x.ts')).toBe(items[1]);
    expect(findWorkstreamFor(items, '/r/.worktrees/a')).toBe(items[1]);
    expect(findWorkstreamFor(items, '/r/.worktrees/ab/x.ts')).toBe(items[0]);
    expect(findWorkstreamFor(items, '/r/src/x.ts')).toBe(items[0]);
    expect(findWorkstreamFor(items, '/elsewhere/b/y')).toBe(items[3]);
    expect(findWorkstreamFor(items, '/other')).toBeUndefined();
  });
});

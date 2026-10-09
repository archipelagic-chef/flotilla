import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWorkstreams, type BuildOptions } from '../../../src/features/workstreams/workstream';
import { WorktreeService } from '../../../src/features/worktrees/worktreeService';
import { initRepo, makeStatDirty, removeDir, writeFile } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

const options = (currentWorktreeRoot: string): BuildOptions => ({
  currentWorktreeRoot,
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
    expect(aItem.attention).toBe('active');
    expect(aItem.progress).toMatchObject({ base: 'main', ahead: 0, behind: 0 });
    const main = items.find((i) => i.worktree.isMain)!;
    expect(main.isCurrent).toBe(true);
    expect(main.key).toBe(main.worktree.adminDir);
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

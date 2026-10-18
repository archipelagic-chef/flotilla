import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BacklogData, BacklogItem } from '../../../src/features/backlog/backlog';
import { LocalBacklog } from '../../../src/features/backlog/localBacklog';
import { git, initRepo, removeDir, writeFile } from '../../helpers/gitRepo';

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
}));

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

const at = '2026-10-14T00:00:00Z';

/** A repo on main, and a local backlog in it (its items are set by the test). */
async function setup(items: BacklogItem[], branches: Record<string, number>): Promise<{ repo: string; backlog: LocalBacklog }> {
  const repo = initRepo();
  cleanup.push(repo);
  for (const [branch, commits] of Object.entries(branches)) {
    git(repo, 'checkout', '-q', '-b', branch);
    for (let n = 0; n < commits; n++) {
      writeFile(repo, `${branch.replace(/\W/g, '_')}-${n}.txt`, 'x\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', `${branch} ${n}`);
    }
    git(repo, 'checkout', '-q', 'main');
  }
  const backlog = new LocalBacklog(repo, path.join(repo, '.git'));
  const data: BacklogData = { version: 1, next: 1, items };
  await backlog.change(() => data);
  return { repo, backlog };
}

describe('Merges', () => {
  it('moves an item whose branch is merged (by the command line too) to Done, with a note', async () => {
    const { repo, backlog } = await setup([{ id: 'BL-1', title: 'Login', status: 'review', created: at, branches: ['feature/BL-1-login'] }], {
      'feature/BL-1-login': 1,
    });
    git(repo, 'merge', '-q', '--ff-only', 'feature/BL-1-login');
    const { Merges } = await import('../../../src/ui/backlog/merges');
    const merges = new Merges({ backlog, mainRoot: repo });
    await merges.refresh();
    expect((await backlog.read()).items[0].status).toBe('done');
    expect(merges.get('BL-1')?.state).toBe('merged');
    expect((await backlog.readTicket({ id: 'BL-1', title: 'Login' })).activity.at(-1)?.body).toContain('so it\'s done');
  });

  it("leaves an item in progress alone while its branch has no commits, and one with unmerged commits too", async () => {
    const { backlog, repo } = await setup(
      [
        { id: 'BL-2', title: 'Fresh', status: 'doing', created: at, branches: ['feature/BL-2-fresh'] },
        { id: 'BL-3', title: 'Work', status: 'doing', created: at, branches: ['feature/BL-3-work'] },
      ],
      { 'feature/BL-2-fresh': 0, 'feature/BL-3-work': 1 },
    );
    const { Merges } = await import('../../../src/ui/backlog/merges');
    const merges = new Merges({ backlog, mainRoot: repo });
    await merges.refresh();
    const items = (await backlog.read()).items;
    expect(items.map((i) => i.status)).toEqual(['doing', 'doing']);
    expect(merges.get('BL-3')).toMatchObject({ state: 'unmerged', commits: 1 });
    expect(merges.get('BL-2')).toMatchObject({ state: 'none' });
  });

  it('keeps a reopened Done item where it is while its old branch stays merged, and moves it once new work is merged', async () => {
    const { repo, backlog } = await setup([{ id: 'BL-5', title: 'Again', status: 'done', created: at, branches: ['feature/BL-5-again'] }], {
      'feature/BL-5-again': 1,
    });
    git(repo, 'merge', '-q', '--ff-only', 'feature/BL-5-again');
    const { Merges } = await import('../../../src/ui/backlog/merges');
    const merges = new Merges({ backlog, mainRoot: repo });
    await merges.refresh();
    await backlog.change((d) => ({ ...d, items: d.items.map((i) => ({ ...i, status: 'doing' as const })) }));
    await merges.refresh();
    expect((await backlog.read()).items[0].status).toBe('doing');
    git(repo, 'checkout', '-q', 'feature/BL-5-again');
    writeFile(repo, 'more.txt', 'x\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'more');
    git(repo, 'checkout', '-q', 'main');
    await merges.refresh();
    expect(merges.get('BL-5')?.state).toBe('unmerged');
    git(repo, 'merge', '-q', '--ff-only', 'feature/BL-5-again');
    await merges.refresh();
    expect((await backlog.read()).items[0].status).toBe('done');
  });

  it("doesn't move an item an agent is working on, even when its work is merged", async () => {
    const { repo, backlog } = await setup(
      [{ id: 'BL-4', title: 'Busy', status: 'review', created: at, branches: ['feature/BL-4-busy'], review: { round: 1, state: 'revising', reviewer: 'Kit-9' } }],
      { 'feature/BL-4-busy': 1 },
    );
    git(repo, 'merge', '-q', '--ff-only', 'feature/BL-4-busy');
    const { Merges } = await import('../../../src/ui/backlog/merges');
    await new Merges({ backlog, mainRoot: repo }).refresh();
    expect((await backlog.read()).items[0].status).toBe('review');
  });
});

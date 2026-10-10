import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addItem, branchFor, branchMatches, EMPTY_BACKLOG, moveItem, removeItem, updateItem, type BacklogData } from '../../../src/features/backlog/backlog';
import { LocalBacklog } from '../../../src/features/backlog/localBacklog';
import { makeTempDir, removeDir } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

const now = new Date('2026-10-10T12:00:00Z');

function backlog(...titles: string[]): BacklogData {
  // Added in reverse so the first title ends up on top.
  return [...titles].reverse().reduce((data, t) => addItem(data, t, 'BL', now).data, EMPTY_BACKLOG);
}

const order = (data: BacklogData) => data.items.map((i) => `${i.id}:${i.status}`);

describe('backlog', () => {
  it('numbers new items and puts them on top', () => {
    const data = backlog('first', 'second');
    expect(data.items.map((i) => [i.id, i.title])).toEqual([
      ['BL-2', 'first'],
      ['BL-1', 'second'],
    ]);
    expect(data.next).toBe(3);
  });

  it('moves items within and between lanes', () => {
    let data = backlog('a', 'b', 'c'); // BL-3 a, BL-2 b, BL-1 c
    data = moveItem(data, 'BL-1', 'todo', 'BL-3');
    expect(order(data)).toEqual(['BL-1:todo', 'BL-3:todo', 'BL-2:todo']);
    // Into an empty lane, without a target: after the last of that lane (none), so at the end.
    data = moveItem(data, 'BL-3', 'doing');
    expect(order(data)).toEqual(['BL-1:todo', 'BL-2:todo', 'BL-3:doing']);
    // Without a target into a lane that has items: after its last one.
    data = moveItem(data, 'BL-1', 'doing');
    expect(order(data)).toEqual(['BL-2:todo', 'BL-3:doing', 'BL-1:doing']);
    expect(moveItem(data, 'BL-9', 'done')).toBe(data);
  });

  it('updates and removes items', () => {
    let data = backlog('a');
    data = updateItem(data, 'BL-1', { title: 'renamed', status: 'done' });
    expect(data.items[0]).toMatchObject({ title: 'renamed', status: 'done' });
    expect(removeItem(data, 'BL-1').items).toEqual([]);
  });

  it('makes branch names and recognizes branches of an item', () => {
    expect(branchFor({ id: 'BL-12', title: 'Fix the login: über-slow!' }, 'feature/{id}-{slug}')).toBe('feature/BL-12-fix-the-login-uber-slow');
    expect(branchFor({ id: 'BL-1', title: '!!!' }, '{id}-{slug}')).toBe('BL-1-work');
    expect(branchMatches({ id: 'BL-12' }, 'feature/BL-12-login')).toBe(true);
    expect(branchMatches({ id: 'BL-12' }, 'feature/bl-12')).toBe(true);
    expect(branchMatches({ id: 'BL-1' }, 'feature/BL-12-login')).toBe(false);
    expect(branchMatches({ id: 'BL-1', branch: 'my-own' }, 'my-own')).toBe(true);
  });
});

describe('LocalBacklog', () => {
  it('keeps the backlog in the shared git dir', async () => {
    const dir = makeTempDir();
    cleanup.push(dir);
    const store = new LocalBacklog(dir);
    expect(await store.read()).toEqual(EMPTY_BACKLOG);
    await store.change((d) => addItem(d, 'first', 'BL', now).data);
    expect(store.file).toBe(path.join(dir, 'flotilla', 'backlog.json'));
    expect((await new LocalBacklog(dir).read()).items.map((i) => i.title)).toEqual(['first']);
    fs.writeFileSync(store.file, '{ broken');
    expect(await store.read()).toEqual(EMPTY_BACKLOG);
  });
});

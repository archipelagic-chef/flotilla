import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addBranch, addItem, currentPrefix, priorityFromName, branchFor, branchMatches, idProblem, itemBranches, linkIssue, linkedItem, unlinkIssue, nextId, EMPTY_BACKLOG, moveItem, removeItem, updateItem, type BacklogData } from '../../../src/features/backlog/backlog';
import { LocalBacklog } from '../../../src/features/backlog/localBacklog';
import { formatTicket, parseTicket, summaryOf } from '../../../src/features/backlog/ticket';
import { git, initRepo, removeDir } from '../../helpers/gitRepo';

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
    expect(data.counters).toEqual({ BL: 2 });
  });

  it('numbers per prefix, never reuses numbers, and takes chosen ids', () => {
    let data = backlog('a', 'b'); // BL-2, BL-1
    data = removeItem(data, 'BL-2');
    expect(nextId(data, 'BL')).toBe('BL-3');
    expect(nextId(data, 'WEB')).toBe('WEB-1');
    expect(nextId(data, 'ABC', ['ABC-41'])).toBe('ABC-42');
    data = addItem(data, 'chosen', 'BL', now, 'WEB-7').data;
    expect(data.items[0].id).toBe('WEB-7');
    expect(nextId(data, 'WEB')).toBe('WEB-8');
    expect(idProblem(data, 'web-7')).toMatch(/taken/);
    expect(idProblem(data, 'WEB-8', ['WEB-8'])).toMatch(/taken/);
    expect(idProblem(data, 'nope')).toMatch(/prefix, a dash and a number/);
    expect(() => addItem(data, 'x', 'BL', now, 'WEB-7')).toThrow(/taken/);
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

  it('sets and clears priorities, and reads the priority names of trackers', () => {
    let data = backlog('a');
    data = updateItem(data, 'BL-1', { priority: 'high' });
    expect(data.items[0].priority).toBe('high');
    data = updateItem(data, 'BL-1', { title: 'b' });
    expect(data.items[0].priority).toBe('high');
    data = updateItem(data, 'BL-1', { priority: null });
    expect('priority' in data.items[0]).toBe(false);
    expect(['Highest', 'High', 'Medium', 'Low', 'Lowest', 'P1', 'priority: low', 'Normal', 'whatever'].map(priorityFromName)).toEqual([
      'urgent',
      'high',
      'medium',
      'low',
      'low',
      'high',
      'low',
      'medium',
      undefined,
    ]);
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
    expect(branchMatches({ id: 'BL-1', branches: ['a', 'b'] }, 'b')).toBe(true);
  });

  it('records several branches for an item (an epic)', () => {
    let data = backlog('epic');
    data = { ...data, items: data.items.map((i) => ({ ...i, branch: 'old' })) };
    data = addBranch(addBranch(data, 'BL-1', 'feature/BL-1-api'), 'BL-1', 'feature/BL-1-api');
    expect(data.items[0].branches).toEqual(['old', 'feature/BL-1-api']);
    expect(data.items[0].branch).toBeUndefined();
    expect(itemBranches(data.items[0])).toEqual(['old', 'feature/BL-1-api']);
  });

  it('gives new items the prefix last chosen, else the setting', () => {
    expect(currentPrefix(EMPTY_BACKLOG, 'WEB')).toBe('WEB');
    expect(currentPrefix(EMPTY_BACKLOG, ' ')).toBe('BL');
    expect(currentPrefix({ ...EMPTY_BACKLOG, prefix: 'OPS' }, 'WEB')).toBe('OPS');
  });

  it('links items to issues in trackers', () => {
    const jira = { id: 'ABC-7', source: 'jira:x', url: 'https://x/browse/ABC-7', title: 'Old' };
    let data = backlog('a', 'b');
    data = linkIssue(linkIssue(data, 'BL-1', jira), 'BL-1', { ...jira, title: 'New' });
    data = linkIssue(data, 'BL-1', { id: 'GH-3', source: 'github:o/r', url: 'https://github.com/o/r/issues/3', title: 'Bug' });
    const item = data.items.find((i) => i.id === 'BL-1')!;
    expect(item.links?.map((l) => [l.id, l.title])).toEqual([['ABC-7', 'New'], ['GH-3', 'Bug']]);
    expect(linkedItem(data, 'GH-3')?.id).toBe('BL-1');
    expect(linkedItem(data, 'GH-4')).toBeUndefined();
    // Branches named after a linked issue work on the item.
    expect(branchMatches(item, 'feature/ABC-7-login')).toBe(true);
    expect(branchMatches(item, 'feature/ABC-70')).toBe(false);
    data = unlinkIssue(unlinkIssue(data, 'BL-1', 'ABC-7'), 'BL-1', 'GH-3');
    expect(data.items.find((i) => i.id === 'BL-1')!.links).toBeUndefined();
  });
});

describe('LocalBacklog', () => {
  it('keeps the backlog and tickets in .flotilla/backlog, ignored by git', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const commonDir = path.join(repo, '.git');
    const store = new LocalBacklog(repo, commonDir);
    expect(await store.read()).toEqual(EMPTY_BACKLOG);
    const data = await store.change((d) => addItem(d, 'first', 'BL', now).data);
    expect(store.file).toBe(path.join(repo, '.flotilla', 'backlog', 'backlog.json'));
    expect((await new LocalBacklog(repo, commonDir).read()).items.map((i) => i.title)).toEqual(['first']);
    expect(git(repo, 'status', '--porcelain')).toBe('');

    const item = data.items[0];
    await store.writeTicket(item.id, { title: 'first', description: 'Why and what.', activity: [{ date: '2026-10-10 12:00', author: 'You', body: 'A comment' }] });
    expect(await store.readTicket(item)).toMatchObject({ description: 'Why and what.', activity: [{ author: 'You', body: 'A comment' }] });
    const image = await store.saveImage(item.id, 'Screen shot.PNG', new Uint8Array([1, 2]));
    expect(image).toBe('BL-1/Screen-shot.png');
    expect(await store.saveImage(item.id, 'Screen shot.PNG', new Uint8Array([1]))).toBe('BL-1/Screen-shot-2.png');

    // Renaming in the ticket renames the item.
    fs.writeFileSync(store.docPath(item.id), '# Renamed\n\nWhy.\n');
    expect(await store.syncTitles()).toBe(true);
    expect((await store.read()).items[0].title).toBe('Renamed');
    expect(() => store.docPath('../x')).toThrow();

    fs.writeFileSync(store.file, '{ broken');
    expect(await store.read()).toEqual(EMPTY_BACKLOG);
  });
});

describe('tickets', () => {
  it('parses and writes description and activity', () => {
    const text = '# Login limit\n\nLock out after 5 tries.\n\n![](BL-3/a.png)\n\n## Activity\n\n### 2026-10-10 14:03 · You\nPlease also log it.\n\n### 2026-10-10 14:10 · Agent\nDone:\n- counter\n';
    const ticket = parseTicket(text);
    expect(ticket.title).toBe('Login limit');
    expect(ticket.description).toBe('Lock out after 5 tries.\n\n![](BL-3/a.png)');
    expect(ticket.activity).toEqual([
      { date: '2026-10-10 14:03', author: 'You', body: 'Please also log it.' },
      { date: '2026-10-10 14:10', author: 'Agent', body: 'Done:\n- counter' },
    ]);
    expect(parseTicket(formatTicket(ticket))).toEqual(ticket);
    expect(parseTicket('no heading', 'Fallback')).toEqual({ title: 'Fallback', description: 'no heading', activity: [] });
    expect(summaryOf('![](x.png)\n- [ ] Make it *fast*')).toBe('Make it *fast*');
  });
});

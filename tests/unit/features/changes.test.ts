import { describe, expect, it } from 'vitest';
import type { BacklogItem } from '../../../src/features/backlog/backlog';
import { describeChanges, lineDelta } from '../../../src/features/backlog/changes';

const item: BacklogItem = { id: 'BL-2', title: 'Rate-limit', status: 'todo', created: '2026-10-11T00:00:00Z' };

describe('changes noted in a ticket', () => {
  it('says who changed what', () => {
    expect(describeChanges(item, { ...item, status: 'doing' }, 'You')).toEqual(['You moved it from **To Do** to **In Progress**.']);
    expect(describeChanges(item, { ...item, status: 'review' }, 'Agent Nova-7')).toEqual(['Nova-7 (an agent) moved it from **To Do** to **In Review**.']);
    expect(describeChanges(item, { ...item, status: 'done' }, 'Flotilla')).toEqual(['Moved it from **To Do** to **Done**.']);
    expect(describeChanges({ ...item, priority: 'low' }, { ...item, priority: 'high' }, 'You')).toEqual(['You changed its priority from Low to **High**.']);
    expect(describeChanges(item, { ...item, title: 'Rate-limit the API', agent: { model: 'opus' }, branches: ['feature/BL-2'] }, 'You')).toEqual([
      'You renamed it from “Rate-limit”.',
      'You started branch `feature/BL-2` for it.',
      "You set its agents' model to **opus**.",
    ]);
    expect(describeChanges({ ...item, proposed: { by: 'a3f9' } }, item, 'You')).toEqual(['You accepted it into the backlog.']);
  });

  it('says nothing about what it leaves to others (reviews, notes)', () => {
    expect(describeChanges(item, { ...item, review: { round: 1, state: 'reviewing', reviewer: 'Vega-2' }, descriptionHash: 'x' }, 'Flotilla')).toEqual([]);
  });

  it('counts the lines an edit added and removed', () => {
    expect(lineDelta('a\nb\nc', 'a\nc\nd\ne')).toEqual({ added: 2, removed: 1 });
    expect(lineDelta('a\nb', 'b\na')).toEqual({ added: 0, removed: 0 });
  });
});

describe('the backlog notes changes in its tickets', () => {
  it('notes a status change, and description edits once', async () => {
    const fs = await import('node:fs');
    const { LocalBacklog } = await import('../../../src/features/backlog/localBacklog');
    const { makeTempDir, removeDir } = await import('../../helpers/gitRepo');
    const root = makeTempDir();
    try {
      const store = new LocalBacklog(root, `${root}/.git`);
      await store.change((d) => ({ ...d, items: [item] }));
      await store.writeTicket('BL-2', { title: item.title, description: 'Limit requests.', activity: [] });
      // First seen: remembered, not noted.
      await store.noteDescriptions();
      await store.change((d) => ({ ...d, items: d.items.map((i) => ({ ...i, status: 'doing' as const })) }), { by: 'Agent Nova-7' });
      let ticket = await store.readTicket(item);
      expect(ticket.activity.map((e) => [e.author, e.body])).toEqual([['Flotilla', 'Nova-7 (an agent) moved it from **To Do** to **In Progress**.']]);
      // An agent edits the file.
      fs.writeFileSync(store.docPath('BL-2'), fs.readFileSync(store.docPath('BL-2'), 'utf8').replace('Limit requests.', 'Limit requests.\n\n- [ ] Per API key'));
      await store.noteDescriptions();
      await store.noteDescriptions();
      ticket = await store.readTicket(item);
      expect(ticket.activity.at(-1)!.body).toBe('The description was edited in its file (+1 −0 lines): by an agent, or in an editor.');
      expect(ticket.activity).toHaveLength(2);
    } finally {
      removeDir(root);
    }
  });
});

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addItem } from '../../../src/features/backlog/backlog';
import { answeredBy, deleteEntry, editable, editEntry, entryEdit, showsDeleted } from '../../../src/features/backlog/commentEdits';
import { LocalBacklog } from '../../../src/features/backlog/localBacklog';
import { entryAnchors, entryThreads, formatTicket, parseTicket, replyLine, type TicketEntry } from '../../../src/features/backlog/ticket';
import { initRepo, removeDir } from '../../helpers/gitRepo';

const entry = (date: string, author: string, body = 'Text.'): TicketEntry => ({ date, author, body });
const NOW = '2026-10-25 09:00';

const comment = entry('2026-10-20 16:04', 'You', 'First thought.');
const report = entry('2026-10-20 16:10', 'Agent Iris-3', `${replyLine(comment, '2026-10-20-1604-you')}\nAnswered.`);

describe('editing a comment (BL-128)', () => {
  it('changes only its text, marks it edited and keeps its anchor', () => {
    const activity = [comment, entry('2026-10-20 16:05', 'Agent Nova-7', 'A report.')];
    const edited = editEntry(activity, '2026-10-20-1604-you', 'Second thought.', NOW)!;
    expect(edited[1]).toBe(activity[1]);
    expect(entryAnchors(edited)).toEqual(entryAnchors(activity));
    expect(entryEdit(edited[0].body)).toEqual({ text: 'Second thought.', edited: NOW });
    // It's written as plain Markdown, and read back the same.
    const text = formatTicket({ title: 'T', description: '', activity: edited });
    expect(text).toContain('Second thought.\n<!-- edited 2026-10-25 09:00 -->');
    expect(entryEdit(parseTicket(text).activity[0].body).text).toBe('Second thought.');
  });

  it('keeps a reply a reply', () => {
    const reply = entry('2026-10-20 16:20', 'You', `${replyLine(report, '2026-10-20-1610-agent-iris-3')}\nThanks.`);
    const edited = editEntry([comment, report, reply], '2026-10-20-1620-you', 'Thanks a lot.', NOW)!;
    expect(entryThreads(edited)[2].reply?.to).toBe('2026-10-20-1610-agent-iris-3');
    expect(entryEdit(edited[2].body).text).toBe('Thanks a lot.');
  });

  it("is only for your own comments, not agents' reports or Flotilla's notes", () => {
    const activity = [comment, report, entry('2026-10-20 16:11', 'Flotilla', 'Moved.')];
    expect(activity.map(editable)).toEqual([true, false, false]);
    expect(editEntry(activity, '2026-10-20-1610-agent-iris-3', 'Mine now.', NOW)).toBeUndefined();
    expect(editEntry(activity, '2026-10-20-1611-flotilla', 'Mine now.', NOW)).toBeUndefined();
    expect(editEntry(activity, 'gone', 'Mine now.', NOW)).toBeUndefined();
  });

  it('says which agent answered the earlier version', () => {
    const edited = editEntry([comment, report], '2026-10-20-1604-you', 'Second thought.', NOW)!;
    expect(answeredBy(edited, '2026-10-20-1604-you', NOW)).toEqual(['Iris-3']);
    // Without a reply, the agent whose report came next went on from it.
    const next = [comment, entry('2026-10-20 16:30', 'Agent Nova-7', 'Done.')];
    expect(answeredBy(next, '2026-10-20-1604-you', NOW)).toEqual(['Nova-7']);
    // An answer written after the edit read the new version.
    expect(answeredBy(next, '2026-10-20-1604-you', '2026-10-20 16:20')).toEqual([]);
  });
});

describe('deleting a comment (BL-128)', () => {
  it('without replies, it goes', () => {
    const activity = [comment, entry('2026-10-20 16:30', 'Agent Nova-7', 'Done.')];
    expect(deleteEntry(activity, '2026-10-20-1604-you', NOW)).toEqual([activity[1]]);
  });

  it('with replies, it leaves "Comment deleted" with its replies under it', () => {
    const deleted = deleteEntry([comment, report], '2026-10-20-1604-you', NOW)!;
    expect(deleted).toHaveLength(2);
    expect(entryEdit(deleted[0].body)).toEqual({ text: '', deleted: NOW });
    expect(deleted[0].body).toContain('_Comment deleted._');
    expect(entryThreads(deleted)[1].root).toBe(0);
    expect(showsDeleted(deleted, '2026-10-20-1604-you')).toBe(true);
    expect(editable(deleted[0])).toBe(false);
  });

  it("stays (hidden) when its going would change a later entry's anchor", () => {
    const second = entry('2026-10-20 16:04', 'You', 'Same minute.');
    const answer = entry('2026-10-20 16:10', 'Agent Iris-3', `${replyLine(second, '2026-10-20-1604-you-2')}\nOK.`);
    const deleted = deleteEntry([comment, second, answer], '2026-10-20-1604-you', NOW)!;
    expect(entryAnchors(deleted)).toEqual(['2026-10-20-1604-you', '2026-10-20-1604-you-2', '2026-10-20-1610-agent-iris-3']);
    expect(entryThreads(deleted)[2].root).toBe(1);
    expect(showsDeleted(deleted, '2026-10-20-1604-you')).toBe(false);
  });
});

describe('editing in the ticket file (BL-128)', () => {
  const cleanup: string[] = [];
  afterEach(() => cleanup.splice(0).forEach(removeDir));

  it('keeps the entries agents write meanwhile', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const store = new LocalBacklog(repo, path.join(repo, '.git'));
    const item = (await store.change((d) => addItem(d, 'Edited', 'BL', new Date()).data)).items[0];
    await store.appendActivity(item, comment);
    // An agent appends to the file itself, as its editor does (not through the queue).
    fs.appendFileSync(store.docPath(item.id), `\n### 2026-10-20 16:10 · Agent Iris-3\n${report.body}\n`);
    const other = new LocalBacklog(repo, path.join(repo, '.git'));
    await Promise.all([
      store.editTicket(item, (t) => ({ ...t, activity: editEntry(t.activity, '2026-10-20-1604-you', 'Second thought.', NOW)! })),
      ...Array.from({ length: 5 }, (_, i) => other.appendActivity(item, entry('2026-10-20 16:40', 'Agent Nova-7', `late ${i}`))),
    ]);
    const after = (await store.readTicket(item)).activity;
    expect(after).toHaveLength(7);
    expect(entryEdit(after[0].body).text).toBe('Second thought.');
    expect(after[1].body).toBe(report.body);

    await store.editTicket(item, (t) => ({ ...t, activity: deleteEntry(t.activity, '2026-10-20-1604-you', NOW)! }));
    const gone = (await store.readTicket(item)).activity;
    expect(gone).toHaveLength(7);
    expect(entryEdit(gone[0].body).deleted).toBe(NOW);
    expect(entryThreads(gone)[1].root).toBe(0);
  });
});

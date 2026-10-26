import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { addItem } from '../../../src/features/backlog/backlog';
import { parseProposal, takeInbox } from '../../../src/features/backlog/inbox';
import { LocalBacklog } from '../../../src/features/backlog/localBacklog';
import {
  addedTo,
  askedForLimit,
  asksUser,
  becameText,
  changedState,
  DRAFT_HINT,
  editEntry,
  nextNoteId,
  nextNotes,
  type Note,
  noteChatOf,
  noteFollowUp,
  notePrompt,
  noteQuestion,
  noteReopenPrompt,
  NoteStore,
  noteTitle,
  noteTools,
  ROW_MS,
  SETTLE_MS,
  textChange,
  withoutQuestions,
} from '../../../src/features/backlog/notes';
import { initRepo, makeTempDir, removeDir } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

function store(): NoteStore {
  const dir = makeTempDir();
  cleanup.push(dir);
  return new NoteStore(dir);
}

const T0 = Date.parse('2026-10-24T10:00:00Z');
function note(id: string, at: number, more: Partial<Note> = {}): Note {
  return { id, title: id, text: id, activity: [], became: [], created: new Date(at).toISOString(), status: 'open', ...more };
}

describe('storing notes', () => {
  it('gives each note the next id, with its file, state and images', async () => {
    const notes = store();
    const a = await notes.add('Another thing I want is\na dark mode', [], new Date(T0));
    const b = await notes.add('', [{ name: 'shot.png', bytes: new Uint8Array([1, 2, 3]) }], new Date(T0 + 1000));
    expect([a.id, b.id]).toEqual(['NOTE-1', 'NOTE-2']);
    expect(fs.readFileSync(notes.file('NOTE-1'), 'utf8')).toBe('# Another thing I want is\n\nAnother thing I want is\na dark mode\n');
    expect(fs.readFileSync(path.join(notes.dir, 'NOTE-2', 'shot.png'))).toEqual(Buffer.from([1, 2, 3]));
    const listed = await notes.list();
    expect(listed.map((n) => [n.id, n.status, n.text])).toEqual([
      ['NOTE-1', 'open', 'Another thing I want is\na dark mode'],
      ['NOTE-2', 'open', '![shot.png](NOTE-2/shot.png)'],
    ]);
  });

  it("doesn't give two notes added at once the same id", async () => {
    const notes = store();
    const added = await Promise.all([1, 2, 3, 4].map((n) => notes.add(`note ${n}`)));
    expect(new Set(added.map((n) => n.id)).size).toBe(4);
  });

  it('keeps its state, its activity and what it became', async () => {
    const notes = store();
    const { id } = await notes.add('A wish');
    await notes.setState(id, (s) => ({ ...s, status: 'asking', agent: 'Vega-2' }));
    await notes.append(id, { author: 'Agent Vega-2', body: 'Which one?' });
    await notes.append(id, { author: 'You', body: 'The first.' });
    await notes.recordBecame([id, 'NOTE-99'], { id: 'BL-180', kind: 'proposal' });
    await notes.recordBecame([id], { id: 'BL-180', kind: 'proposal' });
    await notes.recordBecame([id], { id: 'BL-12', kind: 'added' });
    const n = (await notes.read(id))!;
    expect(n).toMatchObject({ status: 'asking', agent: 'Vega-2', text: 'A wish' });
    expect(n.activity.map((e) => [e.author, e.body])).toEqual([
      ['Agent Vega-2', 'Which one?'],
      ['You', 'The first.'],
    ]);
    expect(n.became).toEqual([
      { id: 'BL-180', kind: 'proposal' },
      { id: 'BL-12', kind: 'added' },
    ]);
    expect(fs.existsSync(path.join(notes.dir, 'NOTE-99.became'))).toBe(false);
  });

  it('writes a draft in the New Note tab, sends it with text, and drops it when the tab closes unsent', async () => {
    const notes = store();
    const id = await notes.draft(new Date(T0));
    expect(fs.readFileSync(notes.file(id), 'utf8')).toBe(DRAFT_HINT);
    expect(await notes.read(id)).toMatchObject({ status: 'draft', text: '' });
    expect(await notes.send(id)).toBe(false);
    await notes.write(id, '**Another thing** I want is\na dark mode\n\n![shot](NOTE-1/shot.png)\n');
    expect(await notes.send(id, new Date(T0 + 5000))).toBe(true);
    expect(await notes.read(id)).toMatchObject({
      status: 'open',
      title: 'Another thing I want is',
      text: '**Another thing** I want is\na dark mode\n\n![shot](NOTE-1/shot.png)',
      created: new Date(T0 + 5000).toISOString(),
    });
    await expect(notes.write(id, 'again')).rejects.toThrow(/sent already/);
    await notes.send(id, new Date(T0 + 9000));
    expect(await notes.read(id)).toMatchObject({ created: new Date(T0 + 5000).toISOString(), edited: new Date(T0 + 9000).toISOString() });
    expect(await notes.drop(id)).toBe(false);
    await notes.append(id, { author: 'Agent Vega-2', body: 'Which one?' });
    expect(fs.readFileSync(notes.file(id), 'utf8')).toMatch(/^# Another thing I want is\n\n\*\*Another thing\*\* I want is\na dark mode/);

    const unsent = await notes.draft();
    await notes.write(unsent, 'Never mind');
    await notes.saveImage(unsent, 'pasted.png', new Uint8Array([1, 2, 3]));
    expect(await notes.drop(unsent)).toBe(true);
    expect(fs.existsSync(notes.file(unsent))).toBe(false);
    expect(fs.existsSync(path.join(notes.dir, unsent))).toBe(false);
    expect((await notes.list()).map((n) => n.id)).toEqual([id]);
  });

  it('deletes a note whatever its state, with the notes handled with it, and keeps its id from being taken again', async () => {
    const notes = store();
    const lead = await notes.add('A dark mode', [{ name: 'shot.png', bytes: new Uint8Array([1]) }], new Date(T0));
    const follower = await notes.add('and a light one', [], new Date(T0 + 1000));
    const other = await notes.add('Something else', [], new Date(T0 + 2000));
    await notes.setState(lead.id, (s) => ({ ...s, status: 'handled', agent: 'Vega-2', group: [follower.id] }));
    await notes.setState(follower.id, (s) => ({ ...s, status: 'handled', with: lead.id }));
    await notes.recordBecame([lead.id, follower.id], { id: 'BL-180', kind: 'proposal' });
    await notes.append(lead.id, { author: 'Agent Vega-2', body: 'Proposed BL-180.' });
    expect(await notes.groupOf(follower.id)).toEqual([lead.id, follower.id]);

    expect(await notes.delete(lead.id)).toEqual([lead.id, follower.id]);
    for (const id of [lead.id, follower.id]) {
      for (const f of [`${id}.md`, `${id}.json`, `${id}.became`, id]) expect(fs.existsSync(path.join(notes.dir, f))).toBe(false);
      expect(notes.wasDeleted(id)).toBe(true);
      expect(notes.exists(id)).toBe(false);
    }
    expect((await notes.list()).map((n) => n.id)).toEqual([other.id]);
    expect(notes.wasDeleted(other.id)).toBe(false);
    // The newest one deleted: the next note doesn't take its id.
    expect(await notes.delete(other.id)).toEqual([other.id]);
    expect((await notes.add('Next')).id).toBe('NOTE-4');
    expect(await notes.delete('NOTE-9')).toEqual([]);
  });

  it('refuses ids that are no note', () => {
    expect(() => store().file('../BL-1')).toThrow();
  });
});

describe('note helpers', () => {
  it('numbers past the highest note', () => {
    expect(nextNoteId([])).toBe('NOTE-1');
    expect(nextNoteId(['NOTE-2.md', 'NOTE-10.json', 'NOTE-3.became', 'other.md'])).toBe('NOTE-11');
  });

  it('titles a note by its first line of text', () => {
    expect(noteTitle('\n![x](a.png)\n- Fix the *login*  \nmore')).toBe('Fix the *login*');
    expect(noteTitle('x'.repeat(100))).toHaveLength(80);
    expect(noteTitle('')).toBe('Note');
  });

  it('reads a note agent chat from its first line', () => {
    expect(noteChatOf('You are agent Vega-2, handling note NOTE-12: "A wish".')).toEqual({ agent: 'Vega-2', note: 'NOTE-12' });
    expect(noteChatOf('You are agent Vega-2, working on backlog item BL-1: "x"')).toBeUndefined();
  });

  it('allows the agent only to read, write into the inbox and edit tickets', () => {
    expect(noteTools('/repo/.flotilla/backlog')).toEqual([
      'Read',
      'Grep',
      'Glob',
      'Edit(//repo/.flotilla/backlog/inbox/**)',
      'Edit(//repo/.flotilla/backlog/*.md)',
    ]);
  });
});

describe('picking notes up', () => {
  const settled = T0 + 10 * 60_000;

  it('takes the oldest open note, once it has settled', () => {
    const notes = [note('NOTE-2', T0 + ROW_MS + 60_000), note('NOTE-1', T0)];
    expect(nextNotes(notes, new Set(), settled)?.map((n) => n.id)).toEqual(['NOTE-1']);
    expect(nextNotes([note('NOTE-1', T0)], new Set(), T0 + SETTLE_MS - 1)).toBeUndefined();
  });

  it('waits for a note saved again to settle, and leaves drafts', () => {
    const edited = note('NOTE-1', T0, { edited: new Date(settled - 1000).toISOString() });
    expect(nextNotes([edited], new Set(), settled)).toBeUndefined();
    expect(nextNotes([note('NOTE-1', T0, { status: 'draft' })], new Set(), settled)).toBeUndefined();
  });

  it('takes notes written in a row together, and waits while the row may grow', () => {
    const row = [note('NOTE-1', T0), note('NOTE-2', T0 + 60_000), note('NOTE-3', T0 + 120_000), note('NOTE-4', T0 + 120_000 + ROW_MS + 1)];
    expect(nextNotes(row, new Set(), settled)?.map((n) => n.id)).toEqual(['NOTE-1', 'NOTE-2', 'NOTE-3']);
    expect(nextNotes(row, new Set(), T0 + 120_000 + 5000)).toBeUndefined();
  });

  it('skips notes being handled, asking or handled; an answered note goes on with its group', () => {
    const notes = [
      note('NOTE-1', T0, { status: 'handled' }),
      note('NOTE-2', T0 + 1000, { status: 'asking', session: 's' }),
      note('NOTE-3', T0 + 2000, { session: 's2', group: ['NOTE-4'] }),
      note('NOTE-4', T0 + 3000, { with: 'NOTE-3' }),
      note('NOTE-5', T0 + 4000),
    ];
    expect(nextNotes(notes, new Set(), settled)?.map((n) => n.id)).toEqual(['NOTE-3', 'NOTE-4']);
    expect(nextNotes(notes, new Set(['NOTE-3']), settled)?.map((n) => n.id)).toEqual(['NOTE-5']);
  });

  it('leaves a note whose agent waits for a limit until it lifts, then goes on in its chat (BL-203)', () => {
    const limit = { until: new Date(settled + 60_000).toISOString(), known: true, kind: 'usage' as const };
    const notes = [note('NOTE-1', T0, { session: 's', group: ['NOTE-2'], limit }), note('NOTE-2', T0 + 1000, { with: 'NOTE-1' }), note('NOTE-3', T0 + 2000)];
    expect(nextNotes(notes, new Set(), settled)?.map((n) => n.id)).toEqual(['NOTE-3']);
    expect(nextNotes(notes, new Set(), settled + 60_000)?.map((n) => n.id)).toEqual(['NOTE-1', 'NOTE-2']);
  });

  it('finds notes that asked only because their agent stopped on a limit, before BL-203', () => {
    const entry = (author: string, body: string) => ({ author, date: '2026-10-25 15:11', body });
    const stopped = entry('Flotilla', 'Nova-3 stopped on a limit (usage). Answer here and it goes on.');
    expect(askedForLimit(note('NOTE-1', T0, { status: 'asking', activity: [stopped] }))).toBe(true);
    expect(askedForLimit(note('NOTE-1', T0, { status: 'asking', activity: [stopped, entry('You', 'Go on')] }))).toBe(false);
    expect(askedForLimit(note('NOTE-1', T0, { status: 'open', activity: [stopped] }))).toBe(false);
    const error = entry('Flotilla', 'Nova-3 stopped without a reply (boom). Answer here and it goes on.');
    expect(askedForLimit(note('NOTE-1', T0, { status: 'asking', activity: [error] }))).toBe(false);
  });
});

describe("the agent's prompt and reply", () => {
  const prompt = notePrompt({ agent: 'Vega-2', notes: [{ id: 'NOTE-12', title: 'A wish', file: '/b/notes/NOTE-12.md' }], backlogDir: '/b' });

  it('names the agent and note first, and says how to propose and ask', () => {
    expect(prompt.startsWith('You are agent Vega-2, handling note NOTE-12: "A wish".')).toBe(true);
    expect(prompt).toContain('note: NOTE-12');
    expect(prompt).toContain('/b/inbox/');
    expect(prompt).toContain("**When it's done:**");
    expect(prompt).toContain('```question');
    expect(prompt).toContain('Added to:');
  });

  it('handles notes in a row together when they are about one thing', () => {
    const two = notePrompt({
      agent: 'Vega-2',
      notes: [
        { id: 'NOTE-1', title: 'a', file: 'f1' },
        { id: 'NOTE-2', title: 'b', file: 'f2' },
      ],
      backlogDir: '/b',
    });
    expect(two).toContain('note: NOTE-1, NOTE-2');
    expect(two).toContain('Notes about the same thing make tickets together');
  });

  it('tells a question from a finished reply', () => {
    const asking = 'Two ways to do it.\n\nNeeds from you: which one\n\n```question\nWhich?\n- A (recommended)\n- B\n```';
    expect(asksUser(asking)).toBe(true);
    expect(asksUser('Proposed BL-180 and BL-181.')).toBe(false);
    const q = noteQuestion({ status: 'asking', agent: 'Vega-2', activity: [{ date: '', author: 'Agent Vega-2', body: asking }] });
    expect(q?.reply).toBe('Two ways to do it.');
    expect(q?.since).toBeUndefined();
    expect(noteQuestion({ status: 'asking', activity: [{ date: '2026-10-25 14:05', author: 'Agent Vega-2', body: asking }] })?.since).toBe(
      new Date('2026-10-25T14:05').toISOString(),
    );
    expect(q?.questions.map((x) => [x.text, x.options.map((o) => o.text)])).toEqual([['Which?', ['A', 'B']]]);
    // The note's tab shows the reply without its question block, the question being its choices (BL-216).
    expect(withoutQuestions(asking)).toBe('Two ways to do it.\n\nNeeds from you: which one');
  });

  it("gives a note whose agent stopped without a reply Flotilla's line to answer, newer than an earlier reply (BL-203)", () => {
    const stopped = { date: '2026-10-25 15:11', author: 'Flotilla', body: 'Vega-2 stopped without a reply (boom). Answer here and it goes on.' };
    for (const activity of [[stopped], [{ date: '2026-10-25 14:05', author: 'Agent Vega-2', body: 'Earlier.\n\nNeeds from you: which' }, stopped]]) {
      const q = noteQuestion({ status: 'asking', activity });
      expect(q).toEqual({ reply: stopped.body, questions: [], since: new Date('2026-10-25T15:11').toISOString() });
    }
  });

  it('reads the tickets it added to, and says what a note became', () => {
    expect(addedTo('Done.\nAdded to: BL-12, bl-30, BL-99', ['BL-12', 'BL-30'])).toEqual(['BL-12', 'BL-30']);
    expect(
      becameText([
        { id: 'BL-180', kind: 'proposal' },
        { id: 'BL-181', kind: 'proposal' },
        { id: 'BL-12', kind: 'added' },
      ]),
    ).toBe('Became BL-180, BL-181 (proposals); added to BL-12');
    expect(becameText([{ id: 'BL-12', kind: 'added' }])).toBe('Added to BL-12');
    expect(becameText([])).toBe('Became no ticket');
  });
});

describe('proposals from notes', () => {
  it('reads the note field', () => {
    expect(parseProposal('---\nnote: note-12, NOTE-13\n---\n# T\n')).toMatchObject({ notes: ['NOTE-12', 'NOTE-13'] });
  });

  it('links the proposal back to its note, and records it there', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const backlog = new LocalBacklog(repo, path.join(repo, '.git'));
    await backlog.change((d) => addItem(d, 'SSO', 'BL', new Date()).data);
    const notes = new NoteStore(backlog.dir);
    const { id } = await notes.add('I want dark mode');
    const inbox = path.join(backlog.dir, 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, 'dark.md'), `---\nnote: ${id}\nagent: Vega-2\n---\n# Dark mode\n\n**When it's done:** it's dark.\n`);
    const old = new Date(Date.now() - 5000);
    fs.utimesSync(path.join(inbox, 'dark.md'), old, old);
    await takeInbox(backlog, {
      prefix: 'BL',
      mode: 'propose',
      taken: [],
      onFromNotes: (ids, item) => notes.recordBecame(ids, { id: item.id, kind: 'proposal' }),
    });
    const ticket = await backlog.readTicket({ id: 'BL-2', title: '' });
    expect(ticket.description).toBe("**When it's done:** it's dark.\n\nFrom [NOTE-1](notes/NOTE-1.md).");
    expect((await notes.read(id))?.became).toEqual([{ id: 'BL-2', kind: 'proposal' }]);
  });
});

describe('editing a sent note and writing more in it (BL-204)', () => {
  const at = '2026-10-25T12:00:00.000Z';

  it('puts the note where its agent takes the change in, whatever its state', () => {
    // Not picked up yet: updated, it settles again.
    expect(changedState({ created: at, status: 'open' }, at)).toEqual({ created: at, status: 'open', edited: at });
    // Being worked on, or waiting for a limit: its chat goes on with the change.
    const limit = { until: at, known: true, kind: 'usage' as const };
    expect(changedState({ created: at, status: 'open', session: 's', limit }, at)).toMatchObject({ status: 'open', changed: at, limit });
    // Asking: it's your answer.
    expect(changedState({ created: at, status: 'asking', session: 's' }, at)).toMatchObject({ status: 'open', changed: at });
    // Handled: opened again.
    const reopened = changedState({ created: at, status: 'handled', session: 's', handled: at }, at);
    expect(reopened).toEqual({ created: at, status: 'open', session: 's', changed: at, reopened: at });
    // A note handled with another goes on with it.
    expect(changedState({ created: at, status: 'open', with: 'NOTE-1' }, at)).toMatchObject({ changed: at });
    expect(changedState({ created: at, status: 'draft' }, at)).toEqual({ created: at, status: 'draft' });
  });

  it('says what an edit changed, line by line', () => {
    expect(textChange('Make it green\nand round', 'Make it blue\nand round\nand big')).toEqual(['- Make it green', '+ Make it blue', '+ and big']);
    expect(editEntry('a', 'b')).toBe('You edited the note:\n\n```diff\n- a\n+ b\n```');
  });

  it('saves an edit with its title and an entry, and a comment, in every state', async () => {
    const notes = store();
    const n = await notes.add('Make the button green', [], new Date(T0));
    expect(await notes.edit(n.id, 'Make the button green', new Date(T0 + 1000))).toBe(false);

    expect(await notes.edit(n.id, 'Make the button blue\n\n![shot.png](NOTE-1/shot.png)', new Date(T0 + 1000))).toBe(true);
    let read = await notes.read(n.id);
    expect(read).toMatchObject({ title: 'Make the button blue', text: 'Make the button blue\n\n![shot.png](NOTE-1/shot.png)', status: 'open' });
    expect(read?.edited).toBe(new Date(T0 + 1000).toISOString());
    expect(read?.activity).toEqual([
      expect.objectContaining({ author: 'You', body: expect.stringContaining('- Make the button green\n+ Make the button blue') }),
    ]);

    await notes.setState(n.id, (s) => ({ ...s, status: 'handled', session: 's-1', handled: 'x' }));
    expect(await notes.comment(n.id, 'And make it round', new Date(T0 + 2000))).toBe(true);
    read = await notes.read(n.id);
    expect(read).toMatchObject({ status: 'open', reopened: new Date(T0 + 2000).toISOString(), session: 's-1' });
    expect(read?.handled).toBeUndefined();
    expect(read?.activity.at(-1)).toMatchObject({ author: 'You', body: 'And make it round' });
  });

  it('writes a comment on a note handled with another into the one that leads, and moves both', async () => {
    const notes = store();
    const a = await notes.add('One', [], new Date(T0));
    const b = await notes.add('Two', [], new Date(T0 + 1000));
    await notes.setState(a.id, (s) => ({ ...s, status: 'asking', session: 's-1', group: [b.id] }));
    await notes.setState(b.id, (s) => ({ ...s, status: 'asking', with: a.id }));
    await notes.comment(b.id, 'Both, please');
    expect((await notes.read(a.id))?.activity.at(-1)?.body).toBe('Both, please');
    expect((await notes.list()).map((n) => n.status)).toEqual(['open', 'open']);
  });

  it('tells a reopened note agent to update the tickets it became', () => {
    const o = {
      agent: 'Nova-3',
      notes: [{ id: 'NOTE-1', title: 'Green', file: '/b/notes/NOTE-1.md' }],
      backlogDir: '/b',
      became: [{ id: 'BL-9', kind: 'proposal' as const }],
    };
    expect(noteFollowUp(o, 'reopened')).toMatch(/^The note was handled \(Became BL-9 \(proposal\)\), and the user wrote in it since/);
    const fresh = noteReopenPrompt(o);
    expect(fresh).toMatch(/^You are agent Nova-3, handling note NOTE-1/);
    expect(fresh).toMatch(/update the proposals' descriptions/);
    expect(noteFollowUp(o)).toMatch(/You edited the note" gives what changed/);
  });
});

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

type Finished = { code: number | null; error?: string; reply?: string; limit?: { until: Date; known: boolean; kind: 'usage' | 'rate' | 'overloaded' } };

const ui = vi.hoisted(() => ({ answer: 'Delete' as string | undefined, asked: [] as string[], closed: [] as string[] }));

const runs = vi.hoisted(() => ({
  started: [] as Array<{ prompt: string; resume?: string; sessionId: string; stopped: boolean; resolve: (r: Finished) => void }>,
}));

vi.mock('vscode', () => ({
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  window: { showWarningMessage: async (message: string) => (ui.asked.push(message), ui.answer) },
}));
vi.mock('../../../src/ui/progress', () => ({ trackProgress: () => undefined }));
vi.mock('../../../src/ui/backlog/notePanel', () => ({ openNotePanel: async () => undefined, closeNotePanel: (id: string) => void ui.closed.push(id) }));
vi.mock('../../../src/ui/backlog/agentRunner', () => ({
  agentChoice: () => ({}),
  memoryShortage: () => false,
  validSession: (s?: string) => s,
  runAgentHeadless: (o: { prompt: string; resume?: string }) => {
    const sessionId = o.resume ?? crypto.randomUUID();
    let resolve!: (r: Finished) => void;
    const done = new Promise<Finished>((r) => (resolve = r));
    const run = { ...o, sessionId, stopped: false, resolve };
    runs.started.push(run);
    return {
      sessionId,
      done,
      stop: () => {
        run.stopped = true;
        resolve({ code: null, error: 'stopped' });
      },
    };
  },
}));

import { NoteStore } from '../../../src/features/backlog/notes';
import { NoteAgents } from '../../../src/ui/backlog/notes';

describe('NoteAgents and Pause All (BL-193)', () => {
  let dir: string;
  let store: NoteStore;
  let agents: NoteAgents;
  let held = false;
  let chatThere = true;
  const slots: number[] = [];

  beforeEach(async () => {
    runs.started.length = 0;
    held = false;
    chatThere = true;
    slots.length = 0;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-'));
    store = new NoteStore(dir);
    agents = new NoteAgents({
      extensionUri: {} as never,
      notes: store,
      backlog: { dir, read: async () => ({ version: 1, next: 1, items: [{ id: 'BL-9' }] }) } as never,
      repository: { current: [], onDidChange: () => ({ dispose() {} }) } as never,
      mainRoot: dir,
      output: { appendLine() {} } as never,
      isLeader: () => true,
      admit: () => (slots.push(1), slots.length),
      giveBack: () => void slots.pop(),
      pausedAll: () => held,
      chatExists: () => chatThere,
    });
    await store.add('Make the button green', [], new Date(Date.now() - 60 * 60_000));
  });

  afterEach(() => {
    agents.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stops a running note agent, keeps its note open with its session, and resumes that chat once lifted', async () => {
    await agents.tick();
    expect(runs.started).toHaveLength(1);
    const [first] = runs.started;
    const [note] = await store.list();
    expect(agents.agentOf(note.id)).toBeDefined();

    held = true;
    const paused = await agents.pauseForAll();
    expect(paused).toEqual([{ id: note.id, kind: 'note', session: first.sessionId }]);
    expect(first.stopped).toBe(true);
    await vi.waitFor(() => expect(agents.agentOf(note.id)).toBeUndefined());
    const after = await store.read(note.id);
    expect(after).toMatchObject({ status: 'open', session: first.sessionId });
    // Nothing was written to the note: it didn't stop "without a reply".
    expect(after?.activity).toEqual([]);
    expect(slots).toHaveLength(0);
    expect(await agents.resumeForAll(note.id, first.sessionId)).toBe('running');

    // Nothing starts while the hold is on.
    await agents.tick();
    expect(runs.started).toHaveLength(1);

    held = false;
    await agents.tick();
    expect(runs.started).toHaveLength(2);
    expect(runs.started[1].resume).toBe(first.sessionId);
    expect(runs.started[1].prompt).toMatch(/You were paused \(Pause All\)/);
  });

  it('stops its agents when Pause All holds from another window', async () => {
    await agents.tick();
    held = true;
    await agents.tick();
    await vi.waitFor(() => expect(runs.started[0].stopped).toBe(true));
  });

  describe('deleting a note (BL-215)', () => {
    beforeEach(() => {
      ui.answer = 'Delete';
      ui.asked.length = 0;
      ui.closed.length = 0;
    });

    it('asks once, stops its running agent (its slot given back), deletes it with the notes handled with it, and closes their tabs', async () => {
      const [lead] = await store.list();
      const follower = await store.add('and the link blue', [], new Date(Date.now() - 59 * 60_000));
      await agents.tick();
      expect(runs.started).toHaveLength(1);
      expect(agents.agentOf(follower.id)).toBeDefined();

      await agents.deleteNote(follower.id);
      expect(ui.asked).toEqual([`Delete ${lead.id} and ${follower.id}, handled with it? Its agent stops; the tickets it became stay.`]);
      expect(runs.started[0].stopped).toBe(true);
      expect(agents.agentOf(lead.id)).toBeUndefined();
      expect(slots).toHaveLength(0);
      expect(await store.list()).toEqual([]);
      expect(ui.closed).toEqual([lead.id, follower.id]);
      // Nothing was written back: no note was made again.
      expect(store.exists(lead.id)).toBe(false);
    });

    it('keeps the note when you cancel', async () => {
      ui.answer = undefined;
      const [note] = await store.list();
      await agents.deleteNote(note.id);
      expect(ui.asked).toHaveLength(1);
      expect(await store.list()).toHaveLength(1);
    });
  });

  describe('a usage limit (BL-203)', () => {
    const limit = (ms: number) => ({ until: new Date(Date.now() + ms), known: true, kind: 'usage' as const });

    it('leaves its note open with its session, waiting, and goes on in its chat once the limit lifts', async () => {
      await agents.tick();
      const [first] = runs.started;
      const [note] = await store.list();
      first.resolve({ code: 1, limit: limit(60 * 60_000) });
      await vi.waitFor(() => expect(agents.agentOf(note.id)).toBeUndefined());
      const after = await store.read(note.id);
      expect(after).toMatchObject({ status: 'open', session: first.sessionId, limit: { known: true, kind: 'usage' } });
      expect(after?.activity.at(-1)?.body).toMatch(/stopped on Claude's usage limit\. It goes on by itself when it resets/);
      const [view] = await agents.views();
      expect(view).toMatchObject({ status: 'open', waits: { known: true, kind: 'usage' } });
      expect(view.asks).toBeUndefined();

      // Not before the limit lifts.
      await agents.tick();
      expect(runs.started).toHaveLength(1);

      await agents.limitLifted();
      expect(runs.started).toHaveLength(2);
      expect(runs.started[1].resume).toBe(first.sessionId);
      expect(runs.started[1].prompt).toMatch(/You were paused/);

      // It gets through: the limit's gone from its note.
      runs.started[1].resolve({ code: 0, reply: 'Proposed nothing.' });
      await vi.waitFor(async () => expect((await store.read(note.id))?.status).toBe('handled'));
      expect((await store.read(note.id))?.limit).toBeUndefined();
    });

    it('goes on by itself when the reset comes', async () => {
      await agents.tick();
      const [note] = await store.list();
      runs.started[0].resolve({ code: 1, limit: limit(-1000) });
      await vi.waitFor(() => expect(runs.started).toHaveLength(2));
      expect(runs.started[1].resume).toBe(runs.started[0].sessionId);
      expect((await store.read(note.id))?.status).toBe('open');
    });

    it('still asks you when its agent stops with an error or without a reply', async () => {
      await agents.tick();
      const [note] = await store.list();
      runs.started[0].resolve({ code: 1, error: 'boom' });
      await vi.waitFor(async () => expect((await store.read(note.id))?.status).toBe('asking'));
      expect((await store.read(note.id))?.activity.at(-1)?.body).toMatch(/stopped without a reply \(boom\)\. Answer here and it goes on\./);
      // Its card has a box to answer in, with Flotilla's line.
      expect((await agents.views())[0].asks).toMatchObject({ reply: expect.stringMatching(/stopped without a reply/), questions: [] });
    });

    it('opens again the notes that asked only because of a limit, before BL-203', async () => {
      const [note] = await store.list();
      await store.setState(note.id, (s) => ({ ...s, status: 'asking', agent: 'Nova-3', session: 's-1' }));
      await store.append(note.id, { author: 'Flotilla', body: 'Nova-3 stopped on a limit (usage). Answer here and it goes on.' });
      const again = new NoteAgents({ ...(agents as unknown as { deps: ConstructorParameters<typeof NoteAgents>[0] }).deps });
      try {
        await vi.waitFor(async () => expect((await store.read(note.id))?.status).toBe('open'));
      } finally {
        again.dispose();
      }
    });
  });

  describe('editing a note and writing more in it (BL-204)', () => {
    const handle = async () => {
      await agents.tick();
      const [note] = await store.list();
      runs.started.at(-1)!.resolve({ code: 0, reply: 'Proposed BL-9.' });
      await vi.waitFor(async () => expect((await store.read(note.id))?.status).toBe('handled'));
      return note;
    };

    it('updates a note no agent has picked up yet, which settles again', async () => {
      const [note] = await store.list();
      await store.edit(note.id, 'Make the button blue');
      await agents.tick();
      expect(runs.started).toHaveLength(0);
      expect(await store.read(note.id)).toMatchObject({ status: 'open', title: 'Make the button blue' });
    });

    it('gives a change made while its agent works when it ends its turn, before the note counts as handled', async () => {
      await agents.tick();
      const [note] = await store.list();
      await store.edit(note.id, 'Make the button blue');
      runs.started[0].resolve({ code: 0, reply: 'Proposed BL-9.' });
      await vi.waitFor(() => expect(runs.started).toHaveLength(2));
      expect(runs.started[1].resume).toBe(runs.started[0].sessionId);
      expect(runs.started[1].prompt).toMatch(/^The user wrote in the note since your last reply/);
      const read = await store.read(note.id);
      expect(read?.status).toBe('open');
      expect(read?.activity.map((e) => e.author)).toEqual(['You', 'Agent ' + read?.agent]);
      runs.started[1].resolve({ code: 0, reply: 'Updated BL-9.' });
      await vi.waitFor(async () => expect((await store.read(note.id))?.status).toBe('handled'));
      expect((await store.read(note.id))?.changed).toBeUndefined();
    });

    it('takes a comment on a note that asks as your answer', async () => {
      await agents.tick();
      const [note] = await store.list();
      runs.started[0].resolve({ code: 0, reply: 'Which button?\n\nNeeds from you: which one' });
      await vi.waitFor(async () => expect((await store.read(note.id))?.status).toBe('asking'));
      await agents.answer(note.id, 'The blue one');
      await vi.waitFor(() => expect(runs.started).toHaveLength(2));
      expect(runs.started[1].resume).toBe(runs.started[0].sessionId);
      expect(runs.started[1].prompt).toMatch(/^The user wrote in the note/);
    });

    it('opens a handled note again, and its agent goes on in its chat to update the tickets it became', async () => {
      const note = await handle();
      await store.recordBecame([note.id], { id: 'BL-9', kind: 'proposal' });
      await agents.answer(note.id, 'Make it round too');
      await vi.waitFor(() => expect(runs.started).toHaveLength(2));
      expect(runs.started[1].resume).toBe(runs.started[0].sessionId);
      expect(runs.started[1].prompt).toMatch(/^The note was handled \(Became BL-9 \(proposal\)\)/);
      expect((await store.read(note.id))?.reopened).toBeUndefined();
      // Its reply's "Added to" names its own proposal: it stays a proposal.
      runs.started[1].resolve({ code: 0, reply: 'Updated BL-9.\n\nAdded to: BL-9' });
      await vi.waitFor(async () => expect((await store.read(note.id))?.status).toBe('handled'));
      expect((await store.read(note.id))?.became).toEqual([{ id: 'BL-9', kind: 'proposal' }]);
    });

    it('starts a new chat for a reopened note whose chat is gone', async () => {
      const note = await handle();
      chatThere = false;
      await store.edit(note.id, 'Make the button blue');
      await agents.tick();
      expect(runs.started).toHaveLength(2);
      expect(runs.started[1].resume).toBeUndefined();
      expect(runs.started[1].prompt).toMatch(/^You are agent \S+, handling note NOTE-1[\s\S]*The note was handled/);
    });
  });
});

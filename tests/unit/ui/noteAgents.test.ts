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

type Finished = { code: number | null; error?: string; reply?: string };

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
}));
vi.mock('../../../src/ui/progress', () => ({ trackProgress: () => undefined }));
vi.mock('../../../src/ui/backlog/notePanel', () => ({ openNotePanel: async () => undefined }));
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
  const slots: number[] = [];

  beforeEach(async () => {
    runs.started.length = 0;
    held = false;
    slots.length = 0;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-'));
    store = new NoteStore(dir);
    agents = new NoteAgents({
      extensionUri: {} as never,
      notes: store,
      backlog: { dir, read: async () => ({ version: 1, next: 1, items: [] }) } as never,
      repository: { current: [], onDidChange: () => ({ dispose() {} }) } as never,
      mainRoot: dir,
      output: { appendLine() {} } as never,
      isLeader: () => true,
      admit: () => (slots.push(1), slots.length),
      giveBack: () => void slots.pop(),
      pausedAll: () => held,
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
});

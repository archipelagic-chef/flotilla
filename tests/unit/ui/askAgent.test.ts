import * as crypto from 'node:crypto';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { BacklogItem } from '../../../src/features/backlog/backlog';
import type { TicketEntry } from '../../../src/features/backlog/ticket';

type Finished = { code: number | null; error?: string; reply?: string };

const runs = vi.hoisted(() => ({
  started: [] as Array<{ prompt: string; resume?: string; tools?: string[]; cwd: string; sessionId: string; stopped: boolean; resolve: (r: Finished) => void }>,
  headless: new Set<string>(),
}));

vi.mock('vscode', () => ({
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  window: { showInformationMessage: async () => undefined },
}));
vi.mock('../../../src/ui/progress', () => ({ trackProgress: () => undefined }));
vi.mock('../../../src/ui/backlog/agentRunner', () => ({
  agentChoice: () => ({}),
  isRunningHeadless: (id: string) => runs.headless.has(id),
  runningAgentCount: () => 0,
  runAgentHeadless: (o: { prompt: string; resume?: string; tools?: string[]; cwd: string }) => {
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

import { AskAgent } from '../../../src/ui/backlog/askAgent';

const COMMENT: TicketEntry = { date: '2026-10-25 10:00', author: 'You', body: 'Why is the button blue?' };
const ANCHOR = '2026-10-25-1000-you';
const SESSION = '11111111-1111-4111-8111-111111111111';

function fakeBacklog(item: Partial<BacklogItem> = {}) {
  let data = { version: 1 as const, next: 2, items: [{ id: 'BL-1', title: 'A ticket', status: 'doing' as const, created: '', ...item }] };
  const activity: TicketEntry[] = [structuredClone(COMMENT)];
  return {
    get data() {
      return data;
    },
    activity,
    backlog: {
      read: async () => structuredClone(data),
      change: async (fn: (d: typeof data) => typeof data) => void (data = await fn(structuredClone(data))),
      ensureDocument: async () => '/t/BL-1.md',
      appendActivity: async (_item: unknown, e: TicketEntry) => void activity.push(e),
      readTicket: async () => ({ title: 'A ticket', description: '', activity: structuredClone(activity) }),
    },
  };
}

type FakeChat = { id: string; firstPrompt?: string; state: 'working' | 'waiting-for-input' | 'done' | 'ended'; updatedAt: Date; open: boolean };
function fakeRepository(chats: FakeChat[] = []) {
  const listeners: Array<() => void> = [];
  return {
    current: [{ key: 'wt', worktree: { path: '/wt' }, chats }],
    onDidChange: (l: () => void) => {
      listeners.push(l);
      return { dispose: () => undefined };
    },
    fire: () => listeners.forEach((l) => l()),
  };
}

const implementerChat = (state: FakeChat['state']): FakeChat => ({
  id: SESSION,
  firstPrompt: 'You are agent Iris-3, working on backlog item BL-1: "A ticket".',
  state,
  updatedAt: new Date(),
  open: false,
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const asking = (backlog: ReturnType<typeof fakeBacklog>['backlog'], repository = fakeRepository(), open = false) =>
  new AskAgent({
    backlog: backlog as never,
    repository: repository as never,
    mainRoot: '/repo',
    output: { appendLine: () => undefined } as never,
    isOpen: () => open,
    open: async () => undefined,
  });

beforeEach(() => {
  runs.started.length = 0;
  runs.headless.clear();
});

describe('who answers a comment (BL-127)', () => {
  it('is the implementer, its chat resumed in its worktree, when it is idle', async () => {
    const b = fakeBacklog();
    const asks = asking(b.backlog, fakeRepository([implementerChat('done')]));
    await asks.ask('BL-1', ANCHOR);
    expect(runs.started).toHaveLength(1);
    expect(runs.started[0]).toMatchObject({ resume: SESSION, cwd: '/wt' });
    expect(runs.started[0].prompt).toContain('> Why is the button blue?');
    expect(asks.viewsOf('BL-1')[ANCHOR]).toMatchObject({ agent: 'Iris-3', state: 'thinking' });
  });

  it('waits for the implementer while it is running, and starts once its turn ends', async () => {
    const b = fakeBacklog();
    const chat = implementerChat('working');
    const repository = fakeRepository([chat]);
    const asks = asking(b.backlog, repository);
    await asks.ask('BL-1', ANCHOR);
    expect(runs.started).toHaveLength(0);
    expect(asks.viewsOf('BL-1')[ANCHOR]).toEqual({ agent: 'Iris-3', state: 'waiting' });
    chat.state = 'done';
    repository.fire();
    await flush();
    await flush();
    expect(runs.started).toHaveLength(1);
    expect(runs.started[0].resume).toBe(SESSION);
  });

  it('is a separate agent on Answer Now while the implementer runs', async () => {
    const b = fakeBacklog();
    const asks = asking(b.backlog, fakeRepository([implementerChat('working')]));
    await asks.ask('BL-1', ANCHOR);
    await asks.ask('BL-1', ANCHOR, { now: true });
    expect(runs.started).toHaveLength(1);
    expect(runs.started[0].resume).toBeUndefined();
    expect(runs.started[0].cwd).toBe('/repo');
  });

  it('is a fresh agent, with only the ticket to change, when nobody has worked on it', async () => {
    const b = fakeBacklog({ status: 'todo', shaping: { agent: 'Sage-4', session: '' } });
    const asks = asking(b.backlog);
    await asks.ask('BL-1', ANCHOR);
    expect(runs.started).toHaveLength(1);
    expect(runs.started[0].resume).toBeUndefined();
    expect(runs.started[0].prompt).toMatch(/^You are agent Sage-4, working on backlog item BL-1, answering a comment/);
    expect(runs.started[0].tools?.some((t) => t.startsWith('Bash'))).toBe(false);
  });
});

describe('the reply (BL-127)', () => {
  it('is written as a reply to the comment once the agent is done, and counted while the ticket is not open', async () => {
    const b = fakeBacklog();
    const asks = asking(b.backlog, fakeRepository([implementerChat('done')]));
    await asks.ask('BL-1', ANCHOR);
    runs.started[0].resolve({ code: 0, reply: 'It follows the theme.' });
    await flush();
    await flush();
    expect(b.activity.at(-1)).toMatchObject({ author: 'Agent Iris-3', body: `↩ [Reply to You, 2026-10-25 10:00](#${ANCHOR})\nIt follows the theme.` });
    expect(asks.viewsOf('BL-1')[ANCHOR].state).toBe('answered');
    expect(b.data.items[0]).toMatchObject({ unseenReplies: 1 });
  });

  it('is not written when the user stops the agent, and Retry starts again with the same comment', async () => {
    const b = fakeBacklog();
    const asks = asking(b.backlog, fakeRepository([implementerChat('done')]));
    await asks.ask('BL-1', ANCHOR);
    asks.stop('BL-1', ANCHOR);
    await flush();
    expect(runs.started[0].stopped).toBe(true);
    expect(b.activity).toHaveLength(1);
    expect(asks.viewsOf('BL-1')[ANCHOR].state).toBe('stopped');
    await asks.ask('BL-1', ANCHOR);
    expect(runs.started).toHaveLength(2);
    expect(runs.started[1].prompt).toBe(runs.started[0].prompt);
  });

  it('is not written after a failure, which offers Retry', async () => {
    const b = fakeBacklog();
    const asks = asking(b.backlog, fakeRepository([implementerChat('done')]), true);
    await asks.ask('BL-1', ANCHOR);
    runs.started[0].resolve({ code: 1, error: 'crashed' });
    await flush();
    expect(b.activity).toHaveLength(1);
    expect(asks.viewsOf('BL-1')[ANCHOR]).toMatchObject({ state: 'failed', error: 'crashed' });
  });

  it('starts once however many clicks come at once', async () => {
    const b = fakeBacklog();
    const asks = asking(b.backlog, fakeRepository([implementerChat('done')]));
    await Promise.all([asks.ask('BL-1', ANCHOR), asks.ask('BL-1', ANCHOR)]);
    expect(runs.started).toHaveLength(1);
  });
});

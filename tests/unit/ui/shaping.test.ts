import * as crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentChatItem, type BacklogItem } from '../../../src/features/backlog/backlog';
import { isDiscussionChat } from '../../../src/features/backlog/shaping';
import type { TicketEntry } from '../../../src/features/backlog/ticket';

type Finished = { code: number | null; error?: string; reply?: string };

const runs = vi.hoisted(() => ({
  started: [] as Array<{ prompt: string; resume?: string; tools?: string[]; name: string; resolve: (r: Finished) => void; sessionId: string }>,
}));

vi.mock('vscode', () => ({
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  window: { showErrorMessage: async () => undefined },
}));
vi.mock('../../../src/ui/progress', () => ({ trackProgress: () => undefined }));
vi.mock('../../../src/ui/backlog/agentRunner', () => ({
  agentChoice: () => ({}),
  validSession: (s: string | undefined) => (s && /^[0-9a-f-]{36}$/.test(s) ? s : undefined),
  runAgentHeadless: (o: { prompt: string; resume?: string; tools?: string[]; name: string }) => {
    const sessionId = o.resume ?? crypto.randomUUID();
    let resolve!: (r: Finished) => void;
    const done = new Promise<Finished>((r) => (resolve = r));
    runs.started.push({ ...o, sessionId, resolve });
    return { sessionId, done, stop: () => undefined };
  },
}));

import { Shaping } from '../../../src/ui/backlog/shaping';

/** A backlog and its ticket in memory: what Shaping reads and writes. */
function fakeBacklog(item: Partial<BacklogItem>) {
  let data = { version: 1 as const, next: 2, items: [{ id: 'BL-1', title: 'A ticket', status: 'todo' as const, created: '', ...item }] };
  const activity: TicketEntry[] = [];
  const watchers: Array<() => void> = [];
  return {
    get data() {
      return data;
    },
    activity,
    backlog: {
      dir: '/t',
      read: async () => structuredClone(data),
      change: async (fn: (d: typeof data) => typeof data) => {
        data = await fn(structuredClone(data));
        watchers.forEach((w) => w());
      },
      watch: (w: () => void) => {
        watchers.push(w);
        return { dispose: () => undefined };
      },
      ensureDocument: async () => '/t/BL-1.md',
      appendActivity: async (_item: unknown, e: TicketEntry) => void activity.push(e),
      readTicket: async () => ({ title: 'A ticket', description: '', activity: structuredClone(activity) }),
      docPath: () => '/t/BL-1.md',
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
/** The worktrees' chats, as the repository lists them; fire() tells Shaping they changed. */
function fakeRepository() {
  const listeners: Array<() => void> = [];
  return {
    current: [] as Array<{ key: string; chats: Array<{ id: string; firstPrompt?: string; open: boolean; updatedAt: Date }> }>,
    onDidChange: (l: () => void) => {
      listeners.push(l);
      return { dispose: () => undefined };
    },
    fire: () => listeners.forEach((l) => l()),
  };
}

const chats = { started: [] as Array<{ lead: string; task: string }>, opened: [] as Array<{ key: string; chatId: string }> };
const shaping = (backlog: ReturnType<typeof fakeBacklog>['backlog'], repository = fakeRepository()) =>
  new Shaping({
    backlog: backlog as never,
    repository: repository as never,
    mainRoot: '/repo',
    output: { appendLine: () => undefined } as never,
    newChat: async (lead, task) => void chats.started.push({ lead, task }),
    openChat: async (key, chatId) => void chats.opened.push({ key, chatId }),
  });

describe('an agent replying in the ticket (BL-45)', () => {
  beforeEach(() => {
    runs.started.length = 0;
  });

  it('starts an agent that may only read and edit the ticket, and says when the ticket is ready', async () => {
    const fake = fakeBacklog({});
    const s = shaping(fake.backlog);
    await s.reply('BL-1');
    expect(runs.started).toHaveLength(1);
    const [first] = runs.started;
    expect(first.resume).toBeUndefined();
    expect(first.tools).toEqual(['Read', 'Grep', 'Glob', 'Edit(//t/BL-1.md)']);
    expect(first.prompt).toContain('You change no code');
    expect(fake.data.items[0].shaping?.session).toBe(first.sessionId);
    expect(fake.activity[0].body).toMatch(/^Opened a chat for agent/);
    expect(s.isRunning('BL-1')).toBe(true);

    first.resolve({ code: 0, reply: 'Agreed on the scope.\n\nReady to start.' });
    await flush();
    const agent = fake.data.items[0].shaping!.agent;
    expect(fake.activity.at(-1)).toMatchObject({ author: `Agent ${agent}`, body: 'Agreed on the scope.\n\nReady to start.' });
    expect(s.isRunning('BL-1')).toBe(false);
    expect(fake.data.items[0].shaping?.ready).toBe(true);
  });

  it('puts the reply at the end of the ticket, after a comment written while the agent ran', async () => {
    const fake = fakeBacklog({});
    const s = shaping(fake.backlog);
    await s.reply('BL-1');
    // The owner writes in the ticket while the agent is still working.
    fake.activity.push({ date: '2026-10-12 21:59', author: 'You', body: 'Also the tags, please.' });
    runs.started[0].resolve({ code: 0, reply: '  Tags too.\n\nReady to start.\n' });
    await flush();
    const agent = fake.data.items[0].shaping!.agent;
    expect(fake.activity.map((e) => e.author)).toEqual(['Flotilla', 'You', `Agent ${agent}`]);
    expect(fake.activity.at(-1)?.body).toBe('Tags too.\n\nReady to start.');
    expect(fake.activity.at(-1)?.date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(fake.data.items[0].shaping?.ready).toBe(true);
  });

  it('a reply without the ready line leaves the ticket not ready', async () => {
    const fake = fakeBacklog({});
    const s = shaping(fake.backlog);
    await s.reply('BL-1');
    runs.started[0].resolve({ code: 0, reply: 'Shall it match case?' });
    await flush();
    expect(fake.activity.at(-1)?.body).toBe('Shall it match case?');
    expect(fake.data.items[0].shaping?.ready).toBeUndefined();
  });

  it('says so in the ticket when the agent finishes with an empty reply', async () => {
    const fake = fakeBacklog({});
    const s = shaping(fake.backlog);
    await s.reply('BL-1');
    runs.started[0].resolve({ code: 0, reply: '  \n' });
    await flush();
    expect(fake.activity.at(-1)?.body).toMatch(/^\S+ stopped without a reply\. /);
    expect(fake.activity.some((e) => e.author.startsWith('Agent'))).toBe(false);
    expect(fake.data.items[0].shaping?.ready).toBeUndefined();
  });

  it('resumes the same chat on the next comment, and answers a comment that came while it ran', async () => {
    const fake = fakeBacklog({});
    const s = shaping(fake.backlog);
    await s.reply('BL-1');
    const [first] = runs.started;
    first.resolve({ code: 0, reply: 'Noted.' });
    await flush();

    await s.reply('BL-1');
    expect(runs.started).toHaveLength(2);
    expect(runs.started[1].resume).toBe(first.sessionId);
    expect(runs.started[1].prompt).toContain('wrote in the ticket since your last reply');
    // Another comment while it replies: no second agent; it goes on once this one stops.
    await s.reply('BL-1');
    expect(runs.started).toHaveLength(2);
    runs.started[1].resolve({ code: 0, reply: 'Noted.' });
    await flush();
    expect(runs.started).toHaveLength(3);
    expect(runs.started[2].resume).toBe(first.sessionId);
    runs.started[2].resolve({ code: 0, reply: 'Noted.' });
    await flush();
    expect(runs.started).toHaveLength(3);
  });

  it('Discuss without a comment says so to a resumed chat', async () => {
    const fake = fakeBacklog({});
    const s = shaping(fake.backlog);
    await s.reply('BL-1');
    runs.started[0].resolve({ code: 0, reply: 'Noted.' });
    await flush();
    await s.reply('BL-1', true);
    expect(runs.started[1].prompt).toContain('without a comment yet');
  });

  it('starts one agent for calls made at once, and drops a Discuss without a comment that comes meanwhile', async () => {
    const fake = fakeBacklog({});
    const s = shaping(fake.backlog);
    await Promise.all([s.reply('BL-1'), s.reply('BL-1', true)]);
    await flush();
    expect(runs.started).toHaveLength(1);
    runs.started[0].resolve({ code: 0, reply: 'Noted.' });
    await flush();
    expect(runs.started).toHaveLength(1);
  });

  it('answers a comment that comes while the agent is being started', async () => {
    const fake = fakeBacklog({});
    const s = shaping(fake.backlog);
    await Promise.all([s.reply('BL-1'), s.reply('BL-1')]);
    await flush();
    expect(runs.started).toHaveLength(1);
    runs.started[0].resolve({ code: 0, reply: 'Noted.' });
    await flush();
    expect(runs.started).toHaveLength(2);
    expect(runs.started[1].resume).toBe(runs.started[0].sessionId);
  });

  it('leaves a ticket that is being worked on alone', async () => {
    const fake = fakeBacklog({ status: 'doing' });
    await shaping(fake.backlog).reply('BL-1');
    expect(runs.started).toHaveLength(0);
  });

  it('keeps discussing: dismisses "ready to start"', async () => {
    const fake = fakeBacklog({ shaping: { agent: 'Nova-7', session: crypto.randomUUID(), ready: true } });
    const s = shaping(fake.backlog);
    await s.keepDiscussing('BL-1');
    expect(fake.data.items[0].shaping?.ready).toBeUndefined();
  });

  it('says so in the ticket when its agent stops without a reply', async () => {
    const fake = fakeBacklog({});
    const s = shaping(fake.backlog);
    await s.reply('BL-1');
    runs.started[0].resolve({ code: 1, error: 'boom' });
    await flush();
    expect(fake.activity.at(-1)?.body).toMatch(/stopped without a reply \(boom\)/);
    expect(fake.data.items[0].shaping?.ready).toBeUndefined();
  });
});

describe('Discuss: a chat with the agent (BL-188)', () => {
  const SESSION = '11111111-2222-3333-4444-555555555555';
  beforeEach(() => {
    runs.started.length = 0;
    chats.started.length = 0;
    chats.opened.length = 0;
  });

  /** Claude Code lists the chat once its first message is sent: what the user sent is the filled-in message. */
  const sent = (repo: ReturnType<typeof fakeRepository>, open = true) => {
    const { lead, task } = chats.started.at(-1)!;
    repo.current = [{ key: 'main', chats: [{ id: SESSION, firstPrompt: `${lead}\n\n${task}`.slice(0, 200), open, updatedAt: new Date() }] }];
    repo.fire();
  };

  it('opens a chat whose first message names the ticket and gives the discussion its rules', async () => {
    const fake = fakeBacklog({});
    const s = shaping(fake.backlog);
    await s.discuss('BL-1');
    expect(runs.started).toHaveLength(0);
    expect(chats.started).toHaveLength(1);
    const { lead, task } = chats.started[0];
    const agent = fake.data.items[0].shaping!.agent;
    expect(agentChatItem(lead)).toEqual({ agent, item: 'BL-1' });
    expect(isDiscussionChat(lead)).toBe(true);
    expect(task).toContain('/t/BL-1.md');
    expect(task).toContain('Open the conversation now, without waiting');
    expect(task).toContain('You change no code');
    expect(task).toContain(`### YYYY-MM-DD HH:MM · Agent ${agent}`);
    expect(fake.data.items[0].shaping).toMatchObject({ agent, session: '', chat: { since: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/) } });
    expect(fake.activity[0].body).toMatch(/^Opened a chat for agent/);
    expect(s.isRunning('BL-1')).toBe(false);
  });

  it('links the chat to the ticket once its first message is sent, and Discuss again opens that chat', async () => {
    const fake = fakeBacklog({});
    const repo = fakeRepository();
    const s = shaping(fake.backlog, repo);
    await s.discuss('BL-1');
    expect(s.chatOf(fake.data.items[0])).toBeUndefined();
    sent(repo);
    await flush();
    expect(fake.data.items[0].shaping?.session).toBe(SESSION);
    expect(s.chatOf(fake.data.items[0])).toMatchObject({ key: 'main', chat: { id: SESSION, open: true } });
    await s.discuss('BL-1');
    expect(chats.started).toHaveLength(1);
    expect(chats.opened).toEqual([{ key: 'main', chatId: SESSION }]);
    expect(fake.activity).toHaveLength(1);
  });

  it('reopens a closed chat rather than starting another', async () => {
    const fake = fakeBacklog({ shaping: { agent: 'Iris-7', session: SESSION, chat: { since: '2026-10-24 07:00' } } });
    const repo = fakeRepository();
    repo.current = [{ key: 'main', chats: [{ id: SESSION, firstPrompt: 'You are agent Iris-7, working on backlog item BL-1, discussing it with its owner: "A ticket".', open: false, updatedAt: new Date() }] }];
    const s = shaping(fake.backlog, repo);
    await s.discuss('BL-1');
    expect(chats.started).toHaveLength(0);
    expect(chats.opened).toEqual([{ key: 'main', chatId: SESSION }]);
  });

  it("doesn't take another agent's chat, or a working agent's, for the discussion", async () => {
    const fake = fakeBacklog({ shaping: { agent: 'Iris-7', session: '', chat: { since: '2026-10-24 07:00' } } });
    const repo = fakeRepository();
    repo.current = [
      {
        key: 'main',
        chats: [
          { id: 'a', firstPrompt: 'You are agent Iris-7, working on backlog item BL-1: "A ticket".', open: true, updatedAt: new Date() },
          { id: 'b', firstPrompt: 'You are agent Nova-2, working on backlog item BL-1, discussing it with its owner: "A ticket".', open: true, updatedAt: new Date() },
        ],
      },
    ];
    const s = shaping(fake.backlog, repo);
    expect(s.chatOf(fake.data.items[0])).toBeUndefined();
  });

  it('notes a chat closed without a summary, with a link to it', async () => {
    const fake = fakeBacklog({});
    const repo = fakeRepository();
    const s = shaping(fake.backlog, repo);
    await s.discuss('BL-1');
    sent(repo);
    await flush();
    sent(repo, false);
    await flush();
    expect(fake.activity.at(-1)).toMatchObject({ author: 'Flotilla', body: expect.stringContaining(`(flotilla-chat:${SESSION})`) });
  });

  it('a chat closed after the summary adds no note, and its "Ready to start." says the ticket is ready', async () => {
    const fake = fakeBacklog({});
    const repo = fakeRepository();
    const s = shaping(fake.backlog, repo);
    await s.discuss('BL-1');
    sent(repo);
    await flush();
    const agent = fake.data.items[0].shaping!.agent;
    fake.activity.push({ date: '2999-01-01 00:00', author: `Agent ${agent}`, body: 'Discussed with you: agreed X.\n\nReady to start.' });
    sent(repo, false);
    await flush();
    expect(fake.activity.map((e) => e.author)).toEqual(['Flotilla', `Agent ${agent}`]);
    expect(fake.data.items[0].shaping?.ready).toBe(true);
  });
});

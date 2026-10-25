import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({
  short: undefined as { freeMB: number; minMB: number } | undefined,
  /** When set, the check counts the reserved starts (300 MB each) against it, as the real gate does. */
  free: undefined as number | undefined,
  /** The reserved starts (their slots). */
  live: new Set<number>(),
  next: 0,
  /** Holds the next resolveBase (a start awaiting between its check and its spawn). */
  gate: undefined as Promise<void> | undefined,
  /** Makes the next resolveBase fail (a start that errors after its check). */
  fail: false,
}));
const spawn = vi.hoisted(() => vi.fn());
const terminal = vi.hoisted(() => vi.fn(() => ({ sessionId: 'terminal-session' })));
/** Is Claude still limited? (undefined: it takes work again.) */
const probe = vi.hoisted(() => vi.fn(async (): Promise<unknown> => undefined));
/** The token use agents' transcripts show (see watchRunaways); none: no transcript. */
const transcript = vi.hoisted(() => ({ usage: undefined as Record<string, number> | undefined }));
const levels = vi.hoisted(() => ({ now: {} as { strong?: string; light?: string } }));
const quick = vi.hoisted(() => ({ choose: undefined as undefined | ((items: Array<{ id: string }>) => { id: string } | undefined | Promise<{ id: string } | undefined>) }));

vi.mock('vscode', () => ({
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d, inspect: () => undefined }) },
  window: {
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showQuickPick: async (items: Array<{ id: string }>) => quick.choose?.(items),
  },
  commands: { executeCommand: async () => undefined },
  env: { clipboard: { writeText: async () => undefined } },
}));
vi.mock('../../../src/ui/backlog/agentRunner', () => ({
  agentChoice: (item?: { agent?: unknown }) => item?.agent ?? {},
  confirmMemory: async () => false,
  describeChoice: () => '',
  isRunningHeadless: () => false,
  isRunningInTerminal: () => false,
  runAgentInTerminal: terminal,
  stopTerminalAgent: async () => false,
  modelLevels: () => levels.now,
  probeLimit: probe,
  memoryShortage: () => {
    if (memory.free === undefined) return memory.short;
    const left = memory.free - memory.live.size * 300;
    return left < 2048 ? { freeMB: left, minMB: 2048 } : undefined;
  },
  reserveStart: () => {
    memory.next += 1;
    memory.live.add(memory.next);
    return memory.next;
  },
  releaseStart: (slot?: number) => {
    if (slot !== undefined) memory.live.delete(slot);
  },
  runAgentHeadless: spawn,
  validSession: (s: string | undefined) => s,
}));
vi.mock('../../../src/ui/commands', () => ({ agentPrompt: () => 'prompt' }));
vi.mock('../../../src/ui/progress', () => ({ trackProgress: () => undefined }));
vi.mock('../../../src/ui/format', () => ({ workstreamLabel: () => 'feature/BL-1' }));
vi.mock('../../../src/features/workstreams/progress', () => ({
  resolveBase: async () => {
    if (memory.fail) throw new Error('no base');
    const gate = memory.gate;
    memory.gate = undefined;
    await gate;
    return 'main';
  },
}));
vi.mock('../../../src/features/chats/chats', async (actual) => ({
  ...(await actual<typeof import('../../../src/features/chats/chats')>()),
  readTranscript: async () => (transcript.usage ? { usage: { ...transcript.usage } } : undefined),
}));

const at = '2026-10-11T00:00:00Z';
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the review loop and memory', () => {
  let data: { version: 1; next: number; items: Array<Record<string, unknown>> };
  let loop: { start(id: string, manual?: boolean): Promise<void>; dispose(): void };
  let retry: () => Promise<void>;

  beforeEach(async () => {
    vi.resetModules();
    spawn.mockReset();
    spawn.mockImplementation(() => ({ sessionId: 's', done: new Promise(() => undefined), stop() {} }));
    memory.short = { freeMB: 512, minMB: 2048 };
    memory.free = undefined;
    memory.live = new Set();
    memory.gate = undefined;
    memory.fail = false;
    data = {
      version: 1,
      next: 3,
      items: [
        { id: 'BL-1', title: 'Review me', status: 'review', created: at },
        { id: 'BL-2', title: 'Review me too', status: 'review', created: at },
      ],
    };
    const { ReviewLoop } = await import('../../../src/ui/backlog/reviewLoop');
    const backlog = {
      dir: '/unused',
      watch: () => ({ dispose() {} }),
      read: async () => structuredClone(data),
      change: async (fn: (d: typeof data) => typeof data) => {
        data = fn(data);
      },
      readTicket: async () => ({ title: 'Review me', description: '', activity: [] }),
      writeTicket: async () => undefined,
      ensureDocument: async () => '/unused/BL-1.md',
      docPath: () => '/unused/BL-1.md',
      appendActivity: async () => undefined,
    };
    const repository = {
      onDidChange: () => ({ dispose() {} }),
      current: [
        { key: 'wt', worktree: { isMain: false, path: '/wt', branch: 'feature/BL-1-review', adminDir: '/wt/.git' }, chats: [] },
        { key: 'wt2', worktree: { isMain: false, path: '/wt2', branch: 'feature/BL-2-review', adminDir: '/wt2/.git' }, chats: [] },
      ],
    };
    const created = new ReviewLoop({ backlog, repository, mainRoot: '/main', output: { appendLine() {} }, openTicket() {} } as never);
    loop = created;
    retry = () => (created as unknown as { retry(): Promise<void> }).retry();
    await tick();
  });

  it('moves a Light ticket up to the strong model when changes are requested a second time, not the first (BL-69)', async () => {
    levels.now = { strong: 'opus', light: 'sonnet' };
    try {
      const review = { reviewer: 'Rex', implementer: 'Nova', state: 'yours' };
      data.items[0] = { ...data.items[0], agent: { light: true }, review: { ...review, round: 0 } };
      data.items[1] = { ...data.items[1], agent: { light: true }, review: { ...review, round: 1 } };
      const user = loop as unknown as { userReview(id: string, v: string, text: string): Promise<void> };
      await user.userReview('BL-1', 'changes', 'Rename it.');
      await user.userReview('BL-2', 'changes', 'Still wrong.');
      expect(data.items[0].agent).toEqual({ light: true });
      expect(data.items[1].agent).toMatchObject({ model: 'opus', movedUp: { from: 'sonnet', to: 'opus', reason: 'you requested changes in review round 2' } });
      expect(data.items[1].agent).not.toHaveProperty('light');
    } finally {
      levels.now = {};
    }
  });

  it('starts nothing while memory is short, and a manual start after that starts the agent once', async () => {
    await loop.start('BL-1');
    expect(spawn).not.toHaveBeenCalled();

    memory.short = undefined;
    await loop.start('BL-1', true);
    expect(spawn).toHaveBeenCalledTimes(1);

    // The waiting start was settled by the manual one: the minute's retry doesn't start a second reviewer.
    await retry();
    expect(spawn).toHaveBeenCalledTimes(1);
    loop.dispose();
  });

  it('drops a waiting start once the item has left review', async () => {
    await loop.start('BL-1');
    expect(spawn).not.toHaveBeenCalled();

    memory.short = undefined;
    data.items[0].status = 'done';
    await retry();
    expect(spawn).not.toHaveBeenCalled();
    loop.dispose();
  });

  it('runs a waiting start once there is room, when the item is still as it was', async () => {
    await loop.start('BL-1');
    memory.short = undefined;
    await retry();
    expect(spawn).toHaveBeenCalledTimes(1);
    loop.dispose();
  });
  it('runs a manual start on an item that Start Review moves into review, once there is room', async () => {
    data.items[0].status = 'doing';
    await loop.start('BL-1');
    expect(spawn).not.toHaveBeenCalled();

    memory.short = undefined;
    await retry();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect((data.items[0] as { status: string }).status).toBe('review');
    loop.dispose();
  });

  it('runs a restarted loop once there is room, from round 1', async () => {
    data.items[0].review = { round: 3, state: 'stopped', reviewer: 'Astro-3', implementer: 'Servo-7', reason: 'rounds', handled: [] };
    await loop.start('BL-1');
    expect(spawn).not.toHaveBeenCalled();

    memory.short = undefined;
    await retry();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect((data.items[0].review as { round: number }).round).toBe(1);
    loop.dispose();
  });
  it('holds a start\'s memory from its check, so a start checked while it awaits sees it', async () => {
    // Room for one agent: the first start passes the check, then awaits (the base); a second start is checked meanwhile.
    memory.free = 2048 + 300 - 1;
    let open!: () => void;
    memory.gate = new Promise<void>((r) => (open = r));
    const first = loop.start('BL-1');
    await tick();
    await loop.start('BL-2', true);
    expect(spawn).not.toHaveBeenCalled();

    open();
    await first;
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0].name).toContain('BL-1');
    loop.dispose();
  });

  it('gives back the memory of a start that is given up after its check', async () => {
    memory.free = 10_000;
    let open!: () => void;
    memory.gate = new Promise<void>((r) => (open = r));
    const first = loop.start('BL-1');
    await tick();
    // A manual start for the same item spawns meanwhile, so the first one is given up once its base is resolved.
    await loop.start('BL-1', true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(memory.live.size).toBe(2);

    open();
    await first;
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(memory.live.size).toBe(1);
    loop.dispose();
  });

  it('reserves no memory for a start that waits', async () => {
    memory.free = 2048 - 1;
    await loop.start('BL-1');
    expect(spawn).not.toHaveBeenCalled();
    expect(memory.live.size).toBe(0);
    loop.dispose();
  });

  it('lets two starts checked in one window through only while free memory minus both holds', async () => {
    // Room for two agents, not three: the first start awaits (its base) with its memory held; a second one is checked
    // meanwhile and gets through; a third, checked after both, waits.
    memory.free = 2048 + 2 * 300 - 1;
    data.items.push({ id: 'BL-3', title: 'Review me three', status: 'review', created: at });
    let open!: () => void;
    memory.gate = new Promise<void>((r) => (open = r));
    const first = loop.start('BL-1');
    await tick();
    await loop.start('BL-2');
    await loop.start('BL-3');
    expect(spawn.mock.calls.map((c) => c[0].name)).toEqual([expect.stringContaining('BL-2')]);

    open();
    await first;
    expect(spawn.mock.calls.map((c) => c[0].name)).toEqual([expect.stringContaining('BL-2'), expect.stringContaining('BL-1')]);
    expect(memory.live.size).toBe(2);
    loop.dispose();
  });

  it('gives back the memory of a start that fails after its check', async () => {
    memory.free = 10_000;
    memory.fail = true;
    await expect(loop.start('BL-1')).rejects.toThrow('no base');
    expect(spawn).not.toHaveBeenCalled();
    expect(memory.live.size).toBe(0);
    loop.dispose();
  });

  it('gives up a start decided on an item the ticket no longer matches, and starts no agent for it', async () => {
    memory.free = 10_000;
    // The caller read BL-1 as in review; the ticket has it done since.
    data.items[0].status = 'done';
    await (loop as unknown as { startRound(item: unknown): Promise<void> }).startRound({ ...data.items[0], status: 'review' });
    expect(spawn).not.toHaveBeenCalled();
    expect(memory.live.size).toBe(0);
    loop.dispose();
  });

  it('gives up a start whose item changed after its check, and gives back its memory', async () => {
    memory.free = 10_000;
    let open!: () => void;
    memory.gate = new Promise<void>((r) => (open = r));
    const first = loop.start('BL-1');
    await tick();
    // Moved on while the start awaits its base: it's done now, so no agent is spawned for it.
    data.items[0].status = 'done';
    open();
    await first;
    expect(spawn).not.toHaveBeenCalled();
    expect(memory.live.size).toBe(0);
    loop.dispose();
  });
});

describe('the agent limit', () => {
  let data: { version: 1; next: number; items: Array<Record<string, unknown>> };
  let notes: string[];
  let finish: Array<(result: { code: number }) => void>;
  let loop: {
    start(id: string, manual?: boolean): Promise<void>;
    startWork(item: unknown, ws: unknown, o?: { byHand?: boolean }): Promise<void>;
    stop(id: string): Promise<void>;
    resumePaused(): Promise<void>;
    tryPausedNow(): Promise<{ tried: Date; resumed: number; limited?: Date } | undefined>;
    pausedUntil(): Promise<Date | undefined>;
    dispose(): void;
  };
  /** While set, every backlog read waits for it: a read that's still pending when the user acts. */
  let holdReads: Promise<void>;
  let worktrees: Array<{ key: string; worktree: { isMain: boolean; path: string; branch: string; adminDir: string }; chats: unknown[] }>;

  /** Lets the queue and the runs' callbacks finish. */
  const settle = async () => {
    for (let i = 0; i < 30; i++) await tick();
  };
  const started = () => spawn.mock.calls.map((c) => (c[0] as { name: string }).name);

  beforeEach(async () => {
    vi.resetModules();
    spawn.mockReset();
    finish = [];
    let runs = 0;
    spawn.mockImplementation(() => {
      runs++;
      return { sessionId: `session-${runs}`, done: new Promise((resolve) => finish.push(resolve)), stop() {} };
    });
    memory.short = undefined;
    memory.free = undefined;
    memory.live = new Set();
    memory.gate = undefined;
    memory.fail = false;
    holdReads = Promise.resolve();
    data = {
      version: 1,
      next: 6,
      items: [1, 2, 3, 4, 5].map((n) => ({ id: `BL-${n}`, title: `Item ${n}`, status: 'review', created: at, branch: `feature/BL-${n}-review` })),
    };
    notes = [];
    worktrees = [1, 2, 3, 4, 5].map((n) => ({ key: `wt-${n}`, worktree: { isMain: false, path: `/wt/${n}`, branch: `feature/BL-${n}-review`, adminDir: `/wt/${n}/.git` }, chats: [] }));
    const { ReviewLoop } = await import('../../../src/ui/backlog/reviewLoop');
    const backlog = {
      dir: '/unused',
      watch: () => ({ dispose() {} }),
      // The content is taken when the read starts (as a file read does): a write during the hold isn't in it.
      read: async () => {
        const snapshot = structuredClone(data);
        await holdReads;
        return snapshot;
      },
      change: async (fn: (d: typeof data) => typeof data) => {
        data = fn(data);
      },
      readTicket: async () => ({ title: 'Item', description: '', activity: [] }),
      writeTicket: async () => undefined,
      ensureDocument: async () => '/unused/ticket.md',
      docPath: () => '/unused/ticket.md',
      appendActivity: async (item: { id: string }, entry: { body: string }) => void notes.push(`${item.id}: ${entry.body}`),
    };
    const repository = { onDidChange: () => ({ dispose() {} }), current: worktrees };
    loop = new ReviewLoop({ backlog, repository, mainRoot: '/main', output: { appendLine() {} }, openTicket() {} } as never) as never;
    await settle();
  });

  it('queues an agent past the limit, and starts it when a slot frees', async () => {
    await loop.start('BL-1');
    await loop.start('BL-2');
    await loop.start('BL-3');
    expect(started()).toHaveLength(2);
    expect(notes).toContain('BL-3: Queued: an agent takes this up when one is free (1st in line).');

    finish[0]({ code: 0 });
    await settle();
    expect(started()).toHaveLength(3);
    expect(started()[2]).toContain('BL-3');
    loop.dispose();
  });

  it('runs a start the user asks for at once, past the limit, and counts it toward the limit', async () => {
    await loop.start('BL-1');
    await loop.start('BL-2');
    await loop.start('BL-3');
    await loop.start('BL-4', true);
    expect(started()).toHaveLength(3);
    expect(started()[2]).toContain('BL-4');

    // BL-2 and BL-4 still run after BL-1 ends: BL-3 keeps waiting for the room.
    finish[0]({ code: 0 });
    await settle();
    expect(started()).toHaveLength(3);
    finish[1]({ code: 0 });
    await settle();
    expect(started()).toHaveLength(4);
    expect(started()[3]).toContain('BL-3');
    loop.dispose();
  });

  it('runs an agent started by hand from its ticket without a window, with its choice, and queues it at the limit (BL-122)', async () => {
    terminal.mockClear();
    await loop.start('BL-1');
    await loop.start('BL-2');
    data.items[4] = { ...data.items[4], status: 'doing', agent: { model: 'opus', effort: 'high' } };
    await loop.startWork(structuredClone(data.items[4]), worktrees[4], { byHand: true });
    expect(started()).toHaveLength(2);
    expect(notes).toContain('BL-5: Queued: an agent takes this up when one is free (1st in line).');

    finish[0]({ code: 0 });
    await settle();
    expect(started()).toHaveLength(3);
    const call = spawn.mock.calls[2][0] as { name: string; cwd: string; choice: unknown; prompt: string };
    expect(call).toMatchObject({ name: expect.stringContaining('BL-5'), cwd: '/wt/5', choice: { model: 'opus', effort: 'high' } });
    expect(call.prompt).toContain('You were started from your ticket and run without a window');
    expect(terminal).not.toHaveBeenCalled();
    expect(data.items[4].review).toMatchObject({ state: 'working', autopilot: false, byHand: true, implementerSession: 'session-3' });
    expect(notes.some((n) => /^BL-5: Opened a chat for agent .* It works without a window and reports here\.$/.test(n))).toBe(true);
    loop.dispose();
  });

  it('a stopped run gives its slot back at once, though its chat still says working', async () => {
    await loop.start('BL-1');
    await loop.start('BL-2');
    // The stopped process never records "done": its chat stays "working" in the repository.
    worktrees[0].chats = [{ id: 'session-1', state: 'working', firstPrompt: 'You are agent Ada-1, working on backlog item BL-1: "Item 1"' }];
    await loop.start('BL-3');
    expect(started()).toHaveLength(2);

    await loop.stop('BL-1');
    await settle();
    expect(started()).toHaveLength(3);
    expect(started()[2]).toContain('BL-3');
    loop.dispose();
  });

  it("notes what Claude said when it doesn't understand the reset, with the guess (BL-184)", async () => {
    await loop.start('BL-1');
    finish[0]({ code: 1, limit: { until: new Date(Date.now() + 5 * 60_000), known: false, kind: 'rate', said: 'API Error: 429 slow down' } } as never);
    await settle();
    expect(data.items[0].review).toMatchObject({ state: 'paused', paused: { known: false, kind: 'rate' } });
    const note = notes.find((n) => n.includes("Claude's rate limit"));
    expect(note).toContain('Claude said: “API Error: 429 slow down”; reset time not understood, retrying in 5 min.');
    loop.dispose();
  });

  it('a resume that waits for a slot after a usage limit starts once one frees', async () => {
    await loop.start('BL-1');
    await loop.start('BL-2');
    data.items[2].review = {
      round: 1,
      state: 'paused',
      reviewer: '',
      paused: { until: '2026-10-11T00:00:00Z', known: true, phase: 'work', session: 'session-3', agent: 'Ada-3', resume: 'revising' },
    };
    await loop.resumePaused();
    expect(started()).toHaveLength(2);
    expect(notes).toContain('BL-3: Queued: an agent takes this up when one is free (1st in line).');

    finish[0]({ code: 0 });
    await settle();
    expect(started()).toHaveLength(3);
    expect(spawn.mock.calls[2][0]).toMatchObject({ resume: 'session-3' });
    loop.dispose();
  });

  it('retries a guessed-at limit outside the chat, waiting longer each time, with one note when it stops and one when it goes on (BL-82)', async () => {
    const minutesLeft = () => Math.round((Date.parse((data.items[2].review as { paused: { until: string } }).paused.until) - Date.now()) / 60_000);
    const paused = () => (data.items[2].review as { paused?: { tries?: number } }).paused;
    const due = () => ((data.items[2].review as { paused: { until: string } }).paused.until = new Date(Date.now() - 1000).toISOString());
    const rate = { until: new Date(Date.now() + 5 * 60_000), known: false, kind: 'rate' };
    data.items[2].review = {
      round: 1,
      state: 'paused',
      reviewer: '',
      paused: { until: at, known: false, kind: 'rate', tries: 0, since: new Date().toISOString(), phase: 'work', session: 'session-9', agent: 'Ada-3', resume: 'revising' },
    };
    probe.mockReset();
    probe.mockResolvedValue(rate);
    // Two tries fail: nothing is sent to the chat, nothing is written in the ticket, and the waits double.
    await loop.resumePaused();
    expect(paused()?.tries).toBe(1);
    expect(minutesLeft()).toBe(10);
    due();
    await loop.resumePaused();
    expect(paused()?.tries).toBe(2);
    expect(minutesLeft()).toBe(20);
    expect(started()).toHaveLength(0);
    expect(notes).toEqual([]);

    // The third gets through: the chat is resumed once, and the ticket says after how many tries.
    probe.mockResolvedValue(undefined);
    due();
    await loop.resumePaused();
    await settle();
    expect(started()).toHaveLength(1);
    expect(spawn.mock.calls[0][0]).toMatchObject({ resume: 'session-9' });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^BL-3: The limit reset after 3 tries \(since .+\): resumed the chat for agent Ada-3/);

    // The resumed run hits the limit again: it goes on counting and backing off, with no new note.
    finish[0]({ code: 1, limit: rate } as never);
    await settle();
    expect(data.items[2].review).toMatchObject({ state: 'paused', paused: { tries: 3, session: 'session-1' } });
    expect(minutesLeft()).toBe(40);
    expect(notes).toHaveLength(1);
    loop.dispose();
  });

  /** Agents paused on one guessed-at rate limit, the n-th since `minutesAgo[n]` minutes, all due for a try now. */
  const pauseGuessed = (minutesAgo: Record<number, number>) => {
    for (const [n, ago] of Object.entries(minutesAgo)) {
      pauseOn(Number(n), new Date(Date.now() - 1000).toISOString());
      Object.assign((data.items[Number(n)].review as { paused: object }).paused, { known: false, kind: 'rate', tries: 0, since: new Date(Date.now() - ago * 60_000).toISOString() });
    }
  };

  it('one probe tries a limit for every agent paused on it, and they all go on together, oldest pause first (BL-179)', async () => {
    probe.mockReset();
    probe.mockResolvedValue(undefined);
    pauseGuessed({ 1: 10, 2: 30, 3: 20 });
    await loop.resumePaused();
    await settle();
    expect(probe).toHaveBeenCalledTimes(1);
    // Two slots: the oldest two go on, the third is first in line.
    expect(spawn.mock.calls.map((c) => (c[0] as { resume?: string }).resume)).toEqual(['session-p2', 'session-p3']);
    expect(notes).toContain('BL-4: The limit lifted (found while resuming Ada-2): resumed the chat for agent Ada-3 to go on.');
    expect(notes).toContain('BL-2: Queued: an agent takes this up when one is free (1st in line).');
    const live = loop as unknown as { canStartNew(): boolean };
    finish[0]({ code: 0 });
    // The freed slot goes to the waiting agent, not to a new ticket.
    expect(live.canStartNew()).toBe(false);
    await settle();
    expect((spawn.mock.calls[2][0] as { resume?: string }).resume).toBe('session-p1');
    expect(notes).toContain('BL-2: The limit lifted (found while resuming Ada-2): resumed the chat for agent Ada-1 to go on.');
    loop.dispose();
  });

  it('a limit still there moves every agent paused on it to the same next try, and no new ticket starts meanwhile (BL-179)', async () => {
    probe.mockReset();
    probe.mockResolvedValue({ until: new Date(Date.now() + 5 * 60_000), known: false, kind: 'rate' });
    pauseGuessed({ 1: 10, 2: 30 });
    // Due but not tried yet: the autopilot holds now.
    expect((await loop.pausedUntil())!.getTime()).toBeLessThanOrEqual(Date.now());
    await loop.resumePaused();
    expect(probe).toHaveBeenCalledTimes(1);
    const untils = [1, 2].map((n) => (data.items[n].review as { paused: { until: string; tries: number } }).paused);
    expect(untils[0].until).toBe(untils[1].until);
    expect(untils.map((u) => u.tries)).toEqual([1, 1]);
    expect((await loop.pausedUntil())?.toISOString()).toBe(untils[0].until);
    expect(started()).toHaveLength(0);
    loop.dispose();
  });

  it('the probe of a limit that lasts over an hour tries again every 15 minutes at most (BL-179)', async () => {
    probe.mockReset();
    probe.mockResolvedValue({ until: new Date(Date.now() + 5 * 60_000), known: false, kind: 'rate' });
    pauseGuessed({ 1: 90 });
    (data.items[1].review as { paused: { tries: number } }).paused.tries = 5;
    await loop.resumePaused();
    const until = Date.parse((data.items[1].review as { paused: { until: string } }).paused.until);
    expect(Math.round((until - Date.now()) / 60_000)).toBe(15);
    loop.dispose();
  });

  it("another agent's run that gets through resumes the agents paused on a guessed-at limit (BL-179)", async () => {
    probe.mockReset();
    await loop.start('BL-5');
    pauseGuessed({ 1: 10, 2: 30 });
    data.items[1].review = { ...(data.items[1].review as object), paused: { ...(data.items[1].review as { paused: object }).paused, until: new Date(Date.now() + 3600_000).toISOString() } };
    data.items[2].review = { ...(data.items[2].review as object), paused: { ...(data.items[2].review as { paused: object }).paused, until: new Date(Date.now() + 3600_000).toISOString() } };
    finish[0]({ code: 0 });
    await settle();
    expect(probe).not.toHaveBeenCalled();
    expect(spawn.mock.calls.slice(1).map((c) => (c[0] as { resume?: string }).resume)).toEqual(['session-p2', 'session-p1']);
    expect(notes.some((n) => /^BL-2: The limit lifted \(found by .+'s run\): resumed the chat for agent Ada-1/.test(n))).toBe(true);
    loop.dispose();
  });

  it('resumes a limit whose reset was said without asking first, and says so once', async () => {
    probe.mockReset();
    data.items[2].review = {
      round: 1,
      state: 'paused',
      reviewer: '',
      paused: { until: at, known: true, phase: 'work', session: 'session-9', agent: 'Ada-3', resume: 'revising' },
    };
    await loop.resumePaused();
    await settle();
    expect(probe).not.toHaveBeenCalled();
    expect(started()).toHaveLength(1);
    expect(notes).toEqual(['BL-3: The limit reset: resumed the chat for agent Ada-3 to go on.']);
    loop.dispose();
  });

  const pauseOn = (n: number, until: string) =>
    (data.items[n].review = {
      round: 1,
      state: 'paused',
      reviewer: '',
      paused: { until, known: true, phase: 'work', session: `session-p${n}`, agent: `Ada-${n}`, resume: 'revising' },
    });

  it('Try Now resumes the paused agents, top of the backlog first, within the limit (BL-132)', async () => {
    const later = new Date(Date.now() + 3 * 3600_000).toISOString();
    probe.mockReset();
    probe.mockResolvedValue(undefined);
    pauseOn(4, later);
    pauseOn(1, later);
    pauseOn(3, later);
    const result = await loop.tryPausedNow();
    await settle();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ resumed: 3 });
    expect(result?.limited).toBeUndefined();
    // Two slots: BL-2 and BL-4 go on, BL-5 waits for one.
    expect(spawn.mock.calls.map((c) => (c[0] as { resume?: string }).resume)).toEqual(['session-p1', 'session-p3']);
    expect(notes).toContain('BL-5: Queued: an agent takes this up when one is free (1st in line).');
    // The queued one waits for a slot, not for the limit: the autopilot doesn't wait for its reset.
    expect(await loop.pausedUntil()).toBeUndefined();
    finish[0]({ code: 0 });
    await settle();
    expect((spawn.mock.calls[2][0] as { resume?: string }).resume).toBe('session-p4');
    loop.dispose();
  });

  it('Try Now on a limit still there starts nobody and keeps the wait, following the reset Claude says now (BL-132)', async () => {
    const later = new Date(Date.now() + 3 * 3600_000).toISOString();
    const sooner = new Date(Date.now() + 3600_000);
    probe.mockReset();
    probe.mockResolvedValue({ until: sooner, known: true, kind: 'usage' });
    pauseOn(1, later);
    pauseOn(2, later);
    const result = await loop.tryPausedNow();
    await settle();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(started()).toHaveLength(0);
    expect(result).toMatchObject({ resumed: 0, limited: sooner });
    expect(data.items[1].review).toMatchObject({ state: 'paused', paused: { until: sooner.toISOString() } });
    expect(data.items[2].review).toMatchObject({ state: 'paused', paused: { until: later } });
    expect(notes).toEqual([]);
    loop.dispose();
  });

  it('a reset Claude says now holds for every agent waiting on a guessed-at limit, so they all go on then (BL-184)', async () => {
    const guess = new Date(Date.now() + 10 * 60_000).toISOString();
    const reset = new Date(Date.now() + 3 * 3600_000);
    probe.mockReset();
    probe.mockResolvedValue({ until: reset, known: true, kind: 'usage' });
    for (const n of [1, 2]) {
      pauseOn(n, guess);
      Object.assign((data.items[n].review as { paused: object }).paused, { known: false, kind: 'rate', tries: 3, since: guess });
    }
    const result = await loop.tryPausedNow();
    await settle();
    expect(result).toMatchObject({ resumed: 0, limited: reset });
    for (const n of [1, 2]) expect(data.items[n].review).toMatchObject({ state: 'paused', paused: { until: reset.toISOString(), known: true } });
    loop.dispose();
  });

  it('Try Now leaves agents the user paused alone, and says when no agent waits for a limit (BL-132)', async () => {
    probe.mockReset();
    data.items[1].review = {
      round: 1,
      state: 'paused',
      reviewer: '',
      paused: { phase: 'work', session: 'session-u', agent: 'Ada-1', resume: 'revising', byUser: at },
    };
    expect(await loop.tryPausedNow()).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
    expect(started()).toHaveLength(0);
    loop.dispose();
  });

  it('a start that waited is not run when the user stops its item while the queue reads the backlog', async () => {
    await loop.start('BL-1');
    await loop.start('BL-2');
    await loop.start('BL-3');
    expect(started()).toHaveLength(2);

    // A slot frees, and the queue reads the backlog; the read is still pending when the user stops BL-3.
    let release!: () => void;
    holdReads = new Promise<void>((resolve) => (release = resolve));
    finish[0]({ code: 0 });
    await tick();
    void loop.stop('BL-3');
    await tick();
    release();
    holdReads = Promise.resolve();
    await settle();
    expect(started().some((name) => name.includes('BL-3'))).toBe(false);
    loop.dispose();
  });

  it('starts reviews and revisions before new tickets, whatever came first', async () => {
    await loop.start('BL-1');
    await loop.start('BL-2');
    // The autopilot's start is for an item In Progress: the ticket says so too (a start on a stale copy is given up).
    data.items[4].status = 'doing';
    await loop.startWork({ id: 'BL-5', title: 'Item 5', status: 'doing', created: at, branch: 'feature/BL-5-review' }, worktrees[4]);
    await loop.start('BL-3');
    expect(started()).toHaveLength(2);

    finish[0]({ code: 0 });
    await settle();
    expect(started()).toHaveLength(3);
    expect(started()[2]).toContain('BL-3');
    expect(started().some((name) => name.includes('BL-5'))).toBe(false);
    expect(notes).toContain('BL-5: Queued: an agent takes this up when one is free (1st in line).');
    loop.dispose();
  });
  it('holds the slot of an admitted start while it awaits, so a start checked meanwhile waits for it', async () => {
    await loop.start('BL-1');
    // BL-2 is admitted (a slot free) and awaits its base: it holds its slot and its memory until its agent spawns.
    let open!: () => void;
    memory.gate = new Promise<void>((r) => (open = r));
    const second = loop.start('BL-2');
    await tick();
    expect(memory.live.size).toBe(2);
    await loop.start('BL-3');
    expect(started()).toHaveLength(1);
    expect(notes).toContain('BL-3: Queued: an agent takes this up when one is free (1st in line).');

    open();
    await second;
    await settle();
    expect(started()).toHaveLength(2);
    expect(started()[1]).toContain('BL-2');
    finish[0]({ code: 0 });
    await settle();
    expect(started()).toHaveLength(3);
    expect(started()[2]).toContain('BL-3');
    loop.dispose();
  });

  it('gives back the slot and memory of an admitted start that is given up, and the queue goes on', async () => {
    await loop.start('BL-1');
    let open!: () => void;
    memory.gate = new Promise<void>((r) => (open = r));
    const second = loop.start('BL-2');
    await tick();
    await loop.start('BL-3');
    expect(started()).toHaveLength(1);

    // BL-2 moves on while its start awaits: it's given up, its slot and memory go back, and BL-3 takes the slot.
    data.items[1].status = 'done';
    open();
    await second;
    await settle();
    expect(started().some((name) => name.includes('BL-2'))).toBe(false);
    expect(started()).toHaveLength(2);
    expect(started()[1]).toContain('BL-3');
    // The two agents that spawned hold theirs (until their processes exit); BL-2's is back.
    expect(memory.live.size).toBe(2);
    loop.dispose();
  });
});

describe('replies and Prioritize', () => {
  let data: { version: 1; next: number; items: Array<Record<string, unknown>> };
  let notes: string[];
  let finish: Array<(result: { code: number }) => void>;
  let loop: {
    start(id: string, manual?: boolean): Promise<void>;
    startWork(item: unknown, ws: unknown): Promise<void>;
    userReview(id: string, verdict: 'approved' | 'changes', text: string): Promise<void>;
    prioritize(id: string): Promise<void>;
    queuedFor(id: string): { kind: string; place: number } | undefined;
    dispose(): void;
  };
  let worktrees: Array<{ key: string; worktree: { isMain: boolean; path: string; branch: string; adminDir: string }; chats: unknown[] }>;

  /** Lets the queue and the runs' callbacks finish. */
  const settle = async () => {
    for (let i = 0; i < 30; i++) await tick();
  };
  const started = () => spawn.mock.calls.map((c) => (c[0] as { name: string }).name);

  beforeEach(async () => {
    vi.resetModules();
    spawn.mockReset();
    finish = [];
    let runs = 0;
    spawn.mockImplementation(() => {
      runs++;
      return { sessionId: `session-${runs}`, done: new Promise((resolve) => finish.push(resolve)), stop() {} };
    });
    quick.choose = undefined;
    memory.short = undefined;
    memory.free = undefined;
    memory.live = new Set();
    memory.gate = undefined;
    memory.fail = false;
    data = {
      version: 1,
      next: 8,
      items: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `BL-${n}`, title: `Item ${n}`, status: 'review', created: at, branch: `feature/BL-${n}-review` })),
    };
    notes = [];
    worktrees = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ key: `wt-${n}`, worktree: { isMain: false, path: `/wt/${n}`, branch: `feature/BL-${n}-review`, adminDir: `/wt/${n}/.git` }, chats: [] }));
    const { ReviewLoop } = await import('../../../src/ui/backlog/reviewLoop');
    const backlog = {
      dir: '/unused',
      watch: () => ({ dispose() {} }),
      read: async () => structuredClone(data),
      change: async (fn: (d: typeof data) => typeof data) => {
        data = fn(data);
      },
      readTicket: async () => ({ title: 'Item', description: '', activity: [] }),
      writeTicket: async () => undefined,
      ensureDocument: async () => '/unused/ticket.md',
      docPath: () => '/unused/ticket.md',
      appendActivity: async (item: { id: string }, entry: { body: string }) => void notes.push(`${item.id}: ${entry.body}`),
    };
    const repository = { onDidChange: () => ({ dispose() {} }), current: worktrees };
    loop = new ReviewLoop({ backlog, repository, mainRoot: '/main', output: { appendLine() {} }, openTicket() {} } as never) as never;
    await settle();
  });

  it('queues a reply past the limit, ahead of reviews and new work that waited before it', async () => {
    await loop.start('BL-1');
    await loop.start('BL-2');
    // The autopilot's start is for an item In Progress: the ticket says so too (a start on a stale copy is given up).
    data.items[4].status = 'doing';
    await loop.startWork({ id: 'BL-5', title: 'Item 5', status: 'doing', created: at, branch: 'feature/BL-5-review' }, worktrees[4]);
    await loop.start('BL-3');
    await loop.userReview('BL-4', 'changes', 'Use the other helper.');
    expect(started()).toHaveLength(2);
    expect(loop.queuedFor('BL-4')).toMatchObject({ kind: 'reply', place: 1 });
    expect(notes).toContain('BL-4: Queued: an agent takes this up when one is free (1st in line).');

    finish[0]({ code: 0 });
    await settle();
    expect(started()[2]).toContain('BL-4');
    expect(notes).toContain('BL-4: An agent is on it.');
    expect(started().some((name) => name.includes('BL-3') || name.includes('BL-5'))).toBe(false);
    loop.dispose();
  });

  it('starts a queued start at once when Prioritize finds a free slot', async () => {
    await loop.start('BL-1');
    await loop.start('BL-2');
    await loop.start('BL-3');
    expect(started()).toHaveLength(2);

    finish[0]({ code: 0 });
    await settle();
    expect(started()).toHaveLength(3);
    loop.dispose();
  });

  it('starts a queued start above the limit with Prioritize, up to flotilla.agents.maxPrioritized (2)', async () => {
    await loop.start('BL-1');
    await loop.start('BL-2');
    await loop.start('BL-3');
    await loop.start('BL-4');
    await loop.start('BL-5');
    expect(started()).toHaveLength(2);

    await loop.prioritize('BL-4');
    expect(started()).toHaveLength(3);
    expect(started()[2]).toContain('BL-4');
    expect(notes).toContain('BL-4: You prioritized it: an agent takes it up now.');

    await loop.prioritize('BL-5');
    expect(started()).toHaveLength(4);
    expect(started()[3]).toContain('BL-5');
    loop.dispose();
  });

  it('at the ceiling, pauses the agent picked to make room; it goes to the head of the queue and resumes from its chat', async () => {
    await loop.start('BL-1');
    await loop.start('BL-2');
    await loop.start('BL-3');
    await loop.start('BL-4');
    await loop.prioritize('BL-3');
    await loop.prioritize('BL-4');
    await loop.start('BL-5');
    expect(started()).toHaveLength(4);
    const shown: string[][] = [];
    quick.choose = (items) => {
      shown.push(items.map((i) => i.id));
      return items.find((i) => i.id === 'BL-1');
    };

    await loop.prioritize('BL-5');
    // Every running agent is offered, the one that has run the least first (see pauseOrder).
    expect(shown).toHaveLength(1);
    expect([...shown[0]].sort()).toEqual(['BL-1', 'BL-2', 'BL-3', 'BL-4']);
    // BL-1 is paused for BL-5; BL-5 starts in its slot, above the limit.
    expect(started()).toHaveLength(5);
    expect(started()[4]).toContain('BL-5');
    const paused = data.items.find((i) => i.id === 'BL-1')?.review as { state: string; paused?: { for?: string; session: string } };
    expect(paused.state).toBe('paused');
    expect(paused.paused?.for).toBe('BL-5');
    // Its place is at the head, ahead of a reply that queues after it.
    await loop.userReview('BL-6', 'changes', 'More context, please.');
    expect(loop.queuedFor('BL-1')).toMatchObject({ kind: 'resume', place: 1 });
    expect(loop.queuedFor('BL-6')).toMatchObject({ kind: 'reply', place: 2 });
    expect(notes.some((n) => n.startsWith('BL-1: ') && n.includes('is paused for BL-5'))).toBe(true);

    // Three agents end (the limit is 2): when only one runs, BL-1 goes on from its own chat, before anything else waits.
    for (const i of [1, 2]) {
      finish[i]({ code: 0 });
      await settle();
      expect(started()).toHaveLength(5);
    }
    finish[3]({ code: 0 });
    await settle();
    expect(started()).toHaveLength(6);
    expect(spawn.mock.calls[5][0]).toMatchObject({ resume: 'session-1' });
    expect(started()[5]).toContain('BL-1');
    loop.dispose();
  });

  it('refuses to prioritize while memory is short, and starts nothing above the limit', async () => {
    await loop.start('BL-1');
    await loop.start('BL-2');
    await loop.start('BL-3');
    memory.short = { freeMB: 512, minMB: 2048 };
    await loop.prioritize('BL-3');
    expect(started()).toHaveLength(2);
    expect(notes.some((n) => n.startsWith('BL-3: Not started: 512 MB of memory is free'))).toBe(true);
    expect(loop.queuedFor('BL-3')).toMatchObject({ place: 1 });
    loop.dispose();
  });

  it('does nothing when Prioritize is asked for an item that does not wait', async () => {
    await loop.start('BL-1');
    await loop.prioritize('BL-1');
    expect(started()).toHaveLength(1);
    expect(notes.filter((n) => n.startsWith('BL-1: You prioritized'))).toHaveLength(0);
    loop.dispose();
  });

  it('pauses nothing when the picked agent finishes while the pick is open, and starts above the limit only while the ceiling allows', async () => {
    await loop.start('BL-1');
    await loop.start('BL-2');
    await loop.start('BL-3');
    await loop.start('BL-4');
    await loop.prioritize('BL-3');
    await loop.prioritize('BL-4');
    await loop.start('BL-5');
    expect(started()).toHaveLength(4);
    quick.choose = async (items) => {
      // BL-1 ends while the pick is open: now one agent under the ceiling is free to spare, so BL-5 starts without a pause.
      finish[0]({ code: 0 });
      await settle();
      return items.find((i) => i.id === 'BL-1');
    };

    await loop.prioritize('BL-5');
    expect(started()).toHaveLength(5);
    expect(started()[4]).toContain('BL-5');
    expect(data.items.find((i) => i.id === 'BL-2')?.review).toMatchObject({ state: 'reviewing' });
    expect(notes).toContain('BL-5: You prioritized it: an agent takes it up now.');
    loop.dispose();
  });

  it('drops a prioritized start that changed while the pick was open, and pauses nothing for it', async () => {
    await loop.start('BL-1');
    await loop.start('BL-2');
    await loop.start('BL-3');
    await loop.start('BL-4');
    await loop.prioritize('BL-3');
    await loop.prioritize('BL-4');
    await loop.start('BL-5');
    quick.choose = async (items) => {
      // The ticket moves on while the user picks: the start for it is over.
      data.items[4].status = 'done';
      return items.find((i) => i.id === 'BL-1');
    };

    await loop.prioritize('BL-5');
    expect(started()).toHaveLength(4);
    expect(data.items.find((i) => i.id === 'BL-1')?.review).toMatchObject({ state: 'reviewing' });
    expect(notes).toContain('BL-5: The start that waited is dropped: the ticket changed meanwhile.');
    loop.dispose();
  });

  it('pauses nothing when the user picks no agent', async () => {
    await loop.start('BL-1');
    await loop.start('BL-2');
    await loop.start('BL-3');
    await loop.start('BL-4');
    await loop.prioritize('BL-3');
    await loop.prioritize('BL-4');
    await loop.start('BL-5');
    quick.choose = () => undefined;
    await loop.prioritize('BL-5');
    expect(started()).toHaveLength(4);
    expect(data.items.find((i) => i.id === 'BL-1')?.review).toMatchObject({ state: 'reviewing' });
    loop.dispose();
  });
});

describe('pausing, stopping and resuming agents (BL-81)', () => {
  let data: { version: 1; next: number; items: Array<Record<string, unknown>> };
  let notes: string[];
  type Loop = {
    start(id: string, manual?: boolean): Promise<void>;
    control(id: string, action: 'pause' | 'stop' | 'resume', session?: string): Promise<void>;
    fix(id: string, fix: string): Promise<void>;
    resumePaused(): Promise<void>;
    readonly running: number;
    dispose(): void;
  };
  let loop: Loop;
  let stops: number;

  beforeEach(async () => {
    vi.resetModules();
    spawn.mockReset();
    stops = 0;
    spawn.mockImplementation((o: { resume?: string }) => ({ sessionId: o.resume ?? 'a1b2c3d4-0000-4000-8000-000000000001', done: new Promise(() => undefined), stop: () => void stops++ }));
    memory.short = undefined;
    memory.free = undefined;
    memory.live = new Set();
    notes = [];
    data = { version: 1, next: 2, items: [{ id: 'BL-1', title: 'Review me', status: 'review', created: at }] };
    const { ReviewLoop } = await import('../../../src/ui/backlog/reviewLoop');
    const backlog = {
      dir: '/unused',
      watch: () => ({ dispose() {} }),
      read: async () => structuredClone(data),
      change: async (fn: (d: typeof data) => typeof data) => {
        data = fn(data);
      },
      readTicket: async () => ({ title: 'Review me', description: '', activity: [] }),
      writeTicket: async () => undefined,
      ensureDocument: async () => '/unused/BL-1.md',
      docPath: () => '/unused/BL-1.md',
      appendActivity: async (_i: unknown, e: { body: string }) => void notes.push(e.body),
    };
    const repository = {
      onDidChange: () => ({ dispose() {} }),
      current: [{ key: 'wt', worktree: { isMain: false, path: '/wt', branch: 'feature/BL-1-review', adminDir: '/wt/.git' }, chats: [] }],
    };
    loop = new ReviewLoop({ backlog, repository, mainRoot: '/main', output: { appendLine() {} }, openTicket() {} } as never) as unknown as Loop;
    await tick();
    await loop.start('BL-1', true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  const review = () => data.items[0].review as Record<string, unknown> & { paused?: Record<string, unknown>; stop?: Record<string, unknown> };

  it('pauses the running agent: it ends, frees its slot, keeps its chat, and only the user resumes it', async () => {
    expect(loop.running).toBe(1);
    await loop.control('BL-1', 'pause');
    expect(stops).toBe(1);
    expect(loop.running).toBe(0);
    expect(review().state).toBe('paused');
    expect(review().paused).toMatchObject({ phase: 'review', resume: 'reviewing', session: 'a1b2c3d4-0000-4000-8000-000000000001' });
    expect(review().paused?.byUser).toEqual(expect.any(String));
    expect(notes.at(-1)).toMatch(/^You paused .*Resume goes on in the same chat/);

    // The usage-limit timer leaves it alone.
    await loop.resumePaused();
    expect(spawn).toHaveBeenCalledTimes(1);

    await loop.control('BL-1', 'resume');
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1][0]).toMatchObject({ resume: 'a1b2c3d4-0000-4000-8000-000000000001', prompt: expect.stringContaining('The user paused you') });
    expect(review().state).toBe('reviewing');
    expect(review().paused).toBeUndefined();
    loop.dispose();
  });

  it('stops the running agent and offers to resume it in its chat', async () => {
    await loop.control('BL-1', 'stop');
    expect(stops).toBe(1);
    expect(review().state).toBe('stopped');
    expect(review().stop).toMatchObject({ kind: 'user', agent: { phase: 'review', session: 'a1b2c3d4-0000-4000-8000-000000000001' }, at: expect.any(String) });
    await loop.fix('BL-1', 'resume');
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1][0]).toMatchObject({ resume: 'a1b2c3d4-0000-4000-8000-000000000001' });
    expect(review().state).toBe('reviewing');
    loop.dispose();
  });

  it('stops a paused agent as it is', async () => {
    await loop.control('BL-1', 'pause');
    await loop.control('BL-1', 'stop');
    expect(review().state).toBe('stopped');
    expect(review().stop).toMatchObject({ kind: 'user', agent: { phase: 'review' } });
    expect(spawn).toHaveBeenCalledTimes(1);
    loop.dispose();
  });

  it('ends its own run when another window paused it (the review state says so)', async () => {
    const r = review();
    data.items[0].review = { ...r, state: 'paused', paused: { phase: 'review', session: r.reviewerSession, agent: r.reviewer, resume: 'reviewing', byUser: at } };
    await (loop as unknown as { scan(): Promise<void> }).scan();
    expect(stops).toBe(1);
    expect(loop.running).toBe(0);
    loop.dispose();
  });
});

describe('runaway agents (BL-76)', () => {
  let data: { version: 1; next: number; items: Array<Record<string, unknown>> };
  let loop: { fix(id: string, fix: string): Promise<void>; dispose(): void };
  let retry: () => Promise<void>;
  const stop = vi.fn();
  const usage = (failStreak: number, failRuns: number, reRead = 0) => ({ turns: 1, context: 0, reRead, written: 0, output: 0, failStreak, failRuns });
  const settle = async () => {
    for (let i = 0; i < 30; i++) await tick();
  };
  const review = () => data.items[0].review as { state: string; stop?: { kind: string; task?: { prompt: string } } };

  beforeEach(async () => {
    vi.resetModules();
    spawn.mockReset();
    stop.mockReset();
    spawn.mockImplementation(() => ({ sessionId: 's', done: new Promise(() => undefined), stop }));
    memory.short = undefined;
    memory.free = undefined;
    memory.live = new Set();
    memory.gate = undefined;
    memory.fail = false;
    transcript.usage = undefined;
    data = {
      version: 1,
      next: 2,
      items: [
        {
          id: 'BL-1',
          title: 'Fix me',
          status: 'doing',
          created: at,
          review: { round: 1, reviewer: 'Rex', implementer: 'Nova', state: 'stopped', stop: { kind: 'no-report', task: { prompt: 'Make the changes.', why: 'Rex requested changes' } } },
        },
      ],
    };
    const { ReviewLoop } = await import('../../../src/ui/backlog/reviewLoop');
    const backlog = {
      dir: '/unused',
      watch: () => ({ dispose() {} }),
      read: async () => structuredClone(data),
      change: async (fn: (d: typeof data) => typeof data) => {
        data = fn(data);
      },
      readTicket: async () => ({ title: 'Fix me', description: '', activity: [] }),
      writeTicket: async () => undefined,
      ensureDocument: async () => '/unused/BL-1.md',
      docPath: () => '/unused/BL-1.md',
      appendActivity: async () => undefined,
    };
    const repository = {
      onDidChange: () => ({ dispose() {} }),
      current: [{ key: 'wt', worktree: { isMain: false, path: '/wt', branch: 'feature/BL-1-fix', adminDir: '/wt/.git' }, chats: [] }],
    };
    const created = new ReviewLoop({ backlog, repository, mainRoot: '/main', output: { appendLine() {} }, openTicket() {} } as never);
    loop = created as never;
    retry = () => (created as unknown as { retry(): Promise<void> }).retry();
    await tick();
  });

  it('stops an agent repeating a failing command, and Resume It tells it to step back; a new run after the resume counts whole', async () => {
    await loop.fix('BL-1', 'retry');
    await settle();
    expect(spawn).toHaveBeenCalledTimes(1);

    // Its transcript when it started is the base (none: nothing yet); 4 failures in a row don't stop it, 5 do.
    transcript.usage = usage(4, 1);
    await retry();
    expect(stop).not.toHaveBeenCalled();
    transcript.usage = usage(5, 1);
    await retry();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(review()).toMatchObject({ state: 'stopped', stop: { kind: 'runaway' } });

    // Resume It: it goes on, told to step back; the 5 it was stopped for are its base now.
    await loop.fix('BL-1', 'retry');
    await settle();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect((spawn.mock.calls[1][0] as { prompt: string }).prompt).toMatch(/Flotilla stopped you: the same command failed 5 times in a row.*step back/);
    transcript.usage = usage(9, 1);
    await retry();
    expect(stop).toHaveBeenCalledTimes(1);
    // A success, then a new run of 5 failures: stopped at 5, not at 5 + 5.
    transcript.usage = usage(5, 2);
    await retry();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(review().stop?.kind).toBe('runaway');
    loop.dispose();
  });

  it('stops an agent past its budget of re-read tokens since it started', async () => {
    transcript.usage = usage(0, 0, 40_000_000);
    await loop.fix('BL-1', 'retry');
    await settle();
    transcript.usage = usage(0, 0, 60_000_000);
    await retry();
    expect(stop).not.toHaveBeenCalled();
    transcript.usage = usage(0, 0, 66_000_000);
    await retry();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(review().stop?.task?.prompt).toMatch(/re-read 26\.0M tokens since it started/);
    loop.dispose();
  });
});

describe('agents lost to a reload (BL-87)', () => {
  const session = 'a1b2c3d4-0000-4000-8000-0000000000aa';
  let data: { version: 1; next: number; items: Array<Record<string, unknown>> };
  let chats: Array<Record<string, unknown>>;
  let loop: { dispose(): void };
  let recover: (now?: number) => Promise<void>;
  const now = Date.parse('2026-10-18T12:00:00Z');
  const review = () => data.items[0].review as { state: string; reason?: string; worktree?: string; stop?: { kind: string; task?: { prompt: string } } };

  beforeEach(async () => {
    vi.resetModules();
    spawn.mockReset();
    memory.short = undefined;
    data = {
      version: 1,
      next: 2,
      items: [{ id: 'BL-1', title: 'Fix me', status: 'doing', created: at, review: { round: 0, reviewer: '', implementer: 'Nova', implementerSession: session, state: 'revising', worktree: 'wt' } }],
    };
    chats = [];
    const { ReviewLoop } = await import('../../../src/ui/backlog/reviewLoop');
    const backlog = {
      dir: '/unused',
      watch: () => ({ dispose() {} }),
      read: async () => structuredClone(data),
      change: async (fn: (d: typeof data) => typeof data) => {
        data = fn(data);
      },
      readTicket: async () => ({ title: 'Fix me', description: '', activity: [] }),
      writeTicket: async () => undefined,
      ensureDocument: async () => '/unused/BL-1.md',
      docPath: () => '/unused/BL-1.md',
      appendActivity: async () => undefined,
    };
    const repository = {
      onDidChange: () => ({ dispose() {} }),
      get current() {
        return [{ key: 'wt', worktree: { isMain: false, path: '/wt', branch: 'feature/BL-1-fix', adminDir: '/wt/.git' }, chats }];
      },
    };
    const created = new ReviewLoop({ backlog, repository, mainRoot: '/main', output: { appendLine() {} }, openTicket() {} } as never);
    loop = created as never;
    recover = (t) => (created as unknown as { recoverLost(now?: number): Promise<void> }).recoverLost(t);
    await tick();
  });

  it('stops a ticket whose agent runs nowhere, with Resume It going on in its chat', async () => {
    chats.push({ id: session, state: 'done', updatedAt: new Date(now - 10 * 60_000) });
    await recover(now);
    expect(review()).toMatchObject({ state: 'stopped', stop: { kind: 'no-report', task: { prompt: expect.stringMatching(/Go on where you left off/) } } });
    expect(review().reason).toMatch(/Nova stopped without finishing \(the window it ran in reloaded or closed\)/);
    loop.dispose();
  });

  it('leaves an agent at work, one that just went quiet, and one whose chat is not known yet', async () => {
    chats.push({ id: session, state: 'working', updatedAt: new Date(now - 10 * 60_000) });
    await recover(now);
    expect(review().state).toBe('revising');
    chats[0] = { id: session, state: 'done', updatedAt: new Date(now - 30_000) };
    await recover(now);
    expect(review().state).toBe('revising');
    chats.length = 0;
    await recover(now);
    expect(review().state).toBe('revising');
    loop.dispose();
  });
  it("a Check's Clean Up stops a lost agent's review with its way on, and no note of its own (BL-163)", async () => {
    const check = loop as unknown as { stopForCheck(id: string, what: 'lost' | 'paused-gone', reason: string): Promise<boolean> };
    expect(await check.stopForCheck('BL-1', 'paused-gone', 'gone')).toBe(false); // it isn't paused
    expect(await check.stopForCheck('BL-1', 'lost', "The ticket says Nova is making the changes asked for, but it isn't running")).toBe(true);
    expect(review()).toMatchObject({ state: 'stopped', stop: { kind: 'no-report', task: { prompt: expect.stringMatching(/Go on where you left off/) } } });
    expect(await check.stopForCheck('BL-1', 'lost', 'again')).toBe(false); // stopped already: nothing to do
    loop.dispose();
  });
  it("a Check's Clean Up clears the review's worktree only while it still names that one (BL-167)", async () => {
    const check = loop as unknown as { clearWorktreeForCheck(id: string, worktree: string): Promise<boolean> };
    expect(await check.clearWorktreeForCheck('BL-1', '/other')).toBe(false);
    expect(await check.clearWorktreeForCheck('BL-1', 'wt')).toBe(true);
    expect(review().worktree).toBeUndefined();
    expect(review().state).toBe('revising');
    loop.dispose();
  });
});

describe('Pause All and Resume All (BL-160)', () => {
  let data: { version: 1; next: number; items: Array<Record<string, unknown>> };
  type Loop = {
    start(id: string, manual?: boolean): Promise<void>;
    control(id: string, action: 'pause' | 'stop' | 'resume', session?: string): Promise<void>;
    readonly running: number;
    readonly waitingCount: number;
    canStartNew(): boolean;
    dispose(): void;
  };
  let loop: Loop;
  let store: import('../../../src/features/backlog/pausedAll').PausedAllStore;
  let all: import('../../../src/ui/backlog/pauseAll').PauseAll;
  let dir: string;
  let backlog: Record<string, unknown>;

  beforeEach(async () => {
    vi.resetModules();
    spawn.mockReset();
    let n = 0;
    spawn.mockImplementation((o: { resume?: string }) => ({ sessionId: o.resume ?? `a1b2c3d4-0000-4000-8000-00000000000${++n}`, done: new Promise(() => undefined), stop() {} }));
    memory.short = undefined;
    memory.free = undefined;
    memory.live = new Set();
    data = { version: 1, next: 6, items: [1, 2, 3, 4, 5].map((i) => ({ id: `BL-${i}`, title: `Review ${i}`, status: 'review', created: at })) };
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paused-all-'));
    const { PausedAllStore } = await import('../../../src/features/backlog/pausedAll');
    const { PauseAll } = await import('../../../src/ui/backlog/pauseAll');
    const { ReviewLoop } = await import('../../../src/ui/backlog/reviewLoop');
    store = new PausedAllStore(dir);
    backlog = {
      dir: '/unused',
      watch: () => ({ dispose() {} }),
      read: async () => structuredClone(data),
      change: async (fn: (d: typeof data) => typeof data) => {
        data = fn(data);
      },
      readTicket: async () => ({ title: 'Review me', description: '', activity: [] }),
      writeTicket: async () => undefined,
      ensureDocument: async () => '/unused/BL-1.md',
      docPath: () => '/unused/BL-1.md',
      appendActivity: async () => undefined,
    };
    const repository = {
      onDidChange: () => ({ dispose() {} }),
      current: [1, 2, 3, 4, 5].map((i) => ({ key: `wt${i}`, worktree: { isMain: false, path: `/wt${i}`, branch: `feature/BL-${i}-review`, adminDir: `/wt${i}/.git` }, chats: [] })),
    };
    const created = new ReviewLoop({ backlog, repository, mainRoot: '/main', output: { appendLine() {} }, openTicket() {}, pausedAll: () => store.held } as never);
    loop = created as unknown as Loop;
    all = new PauseAll({ backlog: backlog as never, reviews: created, store, lifted: () => created.dispatchQueued() });
    await tick();
    // Three agents at work (started by hand: above the limit of 2), and one the user paused before.
    for (const id of ['BL-3', 'BL-1', 'BL-2', 'BL-4']) await loop.start(id, true);
    await loop.control('BL-4', 'pause');
    expect(loop.running).toBe(3);
  });

  const state = (id: string) => (data.items.find((i) => i.id === id)!.review as { state: string }).state;

  it('pauses every working agent, saves the set, holds the starts, and resumes exactly that set within the limit', async () => {
    const { paused, inChats } = await all.pause();
    expect(paused.map((p) => p.id)).toEqual(['BL-1', 'BL-2', 'BL-3']);
    expect(inChats).toEqual([]);
    expect(loop.running).toBe(0);
    expect(['BL-1', 'BL-2', 'BL-3', 'BL-4'].map(state)).toEqual(['paused', 'paused', 'paused', 'paused']);
    expect(store.read()?.agents.map((a) => a.id)).toEqual(['BL-1', 'BL-2', 'BL-3']);
    expect(all.pausedCount).toBe(3);

    // Nothing starts on its own meanwhile: the start waits in the queue.
    expect(loop.canStartNew()).toBe(false);
    await loop.start('BL-5');
    await tick();
    expect(spawn).toHaveBeenCalledTimes(4);
    expect(loop.waitingCount).toBe(1);

    spawn.mockClear();
    const result = await all.resume();
    await tick();
    // Top of the backlog first, within the limit of 2; the third waits for a slot. BL-4, paused by hand, stays paused.
    expect(result).toEqual({ resumed: 2, waiting: 1 });
    expect(spawn.mock.calls.map((c) => (c[0] as { name: string }).name)).toEqual([expect.stringContaining('BL-1'), expect.stringContaining('BL-2')]);
    expect(state('BL-1')).toBe('reviewing');
    expect(state('BL-2')).toBe('reviewing');
    expect(state('BL-3')).toBe('paused');
    expect(state('BL-4')).toBe('paused');
    expect(store.read()).toBeUndefined();
    expect(loop.waitingCount).toBe(2);
    all.dispose();
    loop.dispose();
  });

  it('leaves an agent paused on a usage limit as it is', async () => {
    data.items[4].review = {
      round: 1,
      reviewer: '',
      implementer: 'Ada-5',
      state: 'paused',
      paused: { until: '2099-01-01T00:00:00Z', known: true, phase: 'work', session: 'session-5', agent: 'Ada-5', resume: 'revising' },
    };
    const { paused } = await all.pause();
    expect(paused.map((p) => p.id)).toEqual(['BL-1', 'BL-2', 'BL-3']);
    expect((data.items[4].review as { paused: { byUser?: string } }).paused.byUser).toBeUndefined();
    all.dispose();
    loop.dispose();
  });

  it('leaves an agent the user resumed or stopped since', async () => {
    await all.pause();
    await loop.control('BL-1', 'stop');
    spawn.mockClear();
    const result = await all.resume();
    expect(result).toEqual({ resumed: 2, waiting: 0 });
    expect(state('BL-1')).toBe('stopped');
    expect(spawn.mock.calls.map((c) => (c[0] as { name: string }).name)).toEqual([expect.stringContaining('BL-2'), expect.stringContaining('BL-3')]);
    all.dispose();
    loop.dispose();
  });

  it("pauses a merge's agent with the others, saved as kind merge, and resumes it in its chat (BL-164)", async () => {
    data.items[4].merging = { dir: '/tmp/m', branch: 'feature/BL-5', base: 'main', baseTip: 'abc', state: 'resolving', started: at };
    const calls: string[] = [];
    let checks = ['BL-5'];
    const merges = {
      pauseForAll: async (id: string) => (calls.push(`pause ${id}`), 'merge-session'),
      resumeForAll: async (id: string, session?: string) => (calls.push(`resume ${id} ${session}`), 'running' as const),
      checksRunning: () => checks,
      stopChecks: (id: string) => void (calls.push(`stop checks ${id}`), (checks = [])),
    };
    const { PauseAll } = await import('../../../src/ui/backlog/pauseAll');
    const withMerges = new PauseAll({ backlog: backlog as never, reviews: loop as never, store, merges });
    // Let Them Finish: the checks go on.
    const { paused } = await withMerges.pause();
    expect(paused).toContainEqual({ id: 'BL-5', kind: 'merge', session: 'merge-session' });
    expect(store.read()?.agents).toContainEqual({ id: 'BL-5', kind: 'merge', session: 'merge-session' });
    expect(calls).toEqual(['pause BL-5']);
    expect(await withMerges.resume()).toEqual({ resumed: 3, waiting: 1 }); // a merge's agent isn't held by the limit
    expect(calls).toEqual(['pause BL-5', 'resume BL-5 merge-session']);
    // Stop Them: the checks stop first.
    calls.length = 0;
    await withMerges.pause({ stopChecks: true });
    expect(calls).toEqual(['stop checks BL-5', 'pause BL-5']);
    withMerges.dispose();
    all.dispose();
    loop.dispose();
  });

  it('holds and resumes after a restart: the set is read from the repository', async () => {
    await all.pause();
    all.dispose();
    loop.dispose();
    const { PausedAllStore } = await import('../../../src/features/backlog/pausedAll');
    const { PauseAll } = await import('../../../src/ui/backlog/pauseAll');
    const { ReviewLoop } = await import('../../../src/ui/backlog/reviewLoop');
    const again = new PausedAllStore(dir);
    const repository = {
      onDidChange: () => ({ dispose() {} }),
      current: [1, 2, 3, 4, 5].map((i) => ({ key: `wt${i}`, worktree: { isMain: false, path: `/wt${i}`, branch: `feature/BL-${i}-review`, adminDir: `/wt${i}/.git` }, chats: [] })),
    };
    const fresh = new ReviewLoop({ backlog, repository, mainRoot: '/main', output: { appendLine() {} }, openTicket() {}, pausedAll: () => again.held } as never);
    const pauseAll = new PauseAll({ backlog: backlog as never, reviews: fresh, store: again });
    await tick();
    expect(pauseAll.pausedCount).toBe(3);
    expect(fresh.canStartNew()).toBe(false);
    spawn.mockClear();
    expect(await pauseAll.resume()).toEqual({ resumed: 2, waiting: 1 });
    expect(fresh.canStartNew()).toBe(false);
    pauseAll.dispose();
    fresh.dispose();
  });
});

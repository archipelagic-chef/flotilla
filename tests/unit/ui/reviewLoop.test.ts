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
  agentChoice: () => ({}),
  confirmMemory: async () => false,
  describeChoice: () => '',
  isRunningHeadless: () => false,
  modelLevels: () => levels.now,
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
    startWork(item: unknown, ws: unknown): Promise<void>;
    stop(id: string): Promise<void>;
    resumePaused(): Promise<void>;
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

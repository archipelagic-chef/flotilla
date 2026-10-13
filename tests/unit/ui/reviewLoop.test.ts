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

vi.mock('vscode', () => ({
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  window: { showWarningMessage: async () => undefined, showInformationMessage: async () => undefined },
  commands: { executeCommand: async () => undefined },
  env: { clipboard: { writeText: async () => undefined } },
}));
vi.mock('../../../src/ui/backlog/agentRunner', () => ({
  agentChoice: () => ({}),
  confirmMemory: async () => false,
  describeChoice: () => '',
  isRunningHeadless: () => false,
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

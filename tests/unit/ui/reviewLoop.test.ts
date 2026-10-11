import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({ short: undefined as { freeMB: number; minMB: number } | undefined }));
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
  memoryShortage: () => memory.short,
  runAgentHeadless: spawn,
  validSession: (s: string | undefined) => s,
}));
vi.mock('../../../src/ui/commands', () => ({ agentPrompt: () => 'prompt' }));
vi.mock('../../../src/ui/progress', () => ({ trackProgress: () => undefined }));
vi.mock('../../../src/ui/format', () => ({ workstreamLabel: () => 'feature/BL-1' }));
vi.mock('../../../src/features/workstreams/progress', () => ({ resolveBase: async () => 'main' }));

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
      appendActivity: async () => undefined,
    };
    const repository = {
      current: [{ key: 'wt', worktree: { isMain: false, path: '/wt', branch: 'feature/BL-1-review', adminDir: '/wt/.git' }, chats: [] }],
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
});

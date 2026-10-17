import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

describe('the autopilot', () => {
  it('takes the first accepted To Do ticket, an epic\'s parts rather than the epic', async () => {
    const { nextForAutopilot } = await import('../../../src/ui/backlog/autopilot');
    const at = '2026-10-11T00:00:00Z';
    const data = {
      version: 1 as const,
      next: 1,
      items: [
        { id: 'BL-1', title: 'Doing', status: 'doing' as const, created: at },
        { id: 'BL-2', title: 'Proposed', status: 'todo' as const, created: at, proposed: {} },
        { id: 'BL-3', title: 'Epic', status: 'todo' as const, created: at },
        { id: 'BL-4', title: 'Part', status: 'todo' as const, created: at, parent: 'BL-3' },
        { id: 'BL-5', title: 'Next', status: 'todo' as const, created: at },
      ],
    };
    expect(nextForAutopilot(data, new Set())?.id).toBe('BL-4');
    expect(nextForAutopilot(data, new Set(['BL-4']))?.id).toBe('BL-5');
    // Being discussed with an agent: the owner starts it.
    const discussed = { ...data, items: data.items.map((i) => (i.id === 'BL-4' ? { ...i, shaping: { agent: 'Nova-7', session: 's' } } : i)) };
    expect(nextForAutopilot(discussed, new Set())?.id).toBe('BL-5');
    // The agent saying it's ready doesn't start work: the owner accepts it or starts it by hand.
    const ready = { ...data, items: data.items.map((i) => (i.id === 'BL-4' ? { ...i, shaping: { agent: 'Nova-7', session: 's', ready: true } } : i)) };
    expect(nextForAutopilot(ready, new Set())?.id).toBe('BL-5');
  });
});

describe('the autopilot switch', () => {
  it('is on only when this machine signed it: an agent writing the file can\'t turn it on', async () => {
    vi.resetModules();
    vi.doMock('vscode', () => ({
      EventEmitter: class {
        private listeners: Array<() => void> = [];
        event = (l: () => void) => (this.listeners.push(l), { dispose() {} });
        fire() {
          this.listeners.forEach((l) => l());
        }
        dispose() {}
      },
      workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
    }));
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { Autopilot } = await import('../../../src/ui/backlog/autopilot');
    const { makeTempDir, removeDir } = await import('../../helpers/gitRepo');
    const dir = makeTempDir();
    try {
      const backlog = { dir, watch: () => ({ dispose() {} }), ensureDir: async () => undefined, read: async () => ({ version: 1, next: 1, items: [] }) };
      const pilot = new Autopilot({
        backlog,
        reviews: { running: 0, pausedUntil: async () => undefined },
        leader: { isLeader: false, check: () => false },
        output: { appendLine() {} },
        key: async () => 'machine-key',
        prepareWorktree: async () => undefined,
      } as never);
      await pilot.setEnabled(true);
      expect(pilot.enabled).toBe(true);
      // An agent writes its own switch.
      fs.writeFileSync(path.join(dir, 'autopilot.json'), JSON.stringify({ enabled: true }));
      await (pilot as unknown as { refresh(): Promise<void> }).refresh();
      expect(pilot.enabled).toBe(false);
      fs.writeFileSync(path.join(dir, 'autopilot.json'), JSON.stringify({ enabled: true, mac: 'f'.repeat(64) }));
      await (pilot as unknown as { refresh(): Promise<void> }).refresh();
      expect(pilot.enabled).toBe(false);
      pilot.dispose();
    } finally {
      removeDir(dir);
    }
  });
});

describe('what reaches the claude command line', () => {
  it('takes model names and session ids, never options', async () => {
    vi.resetModules();
    vi.doMock('vscode', () => ({}));
    const { choiceArgs, validModel, validSession } = await import('../../../src/ui/backlog/agentRunner');
    expect(validModel('opus')).toBe('opus');
    expect(validModel('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(validModel('--dangerously-skip-permissions')).toBeUndefined();
    expect(validModel('opus --permission-mode bypassPermissions')).toBeUndefined();
    expect(choiceArgs({ model: '-x', effort: 'high' })).toEqual(['--effort', 'high']);
    expect(choiceArgs({ effort: 'extreme' as never })).toEqual([]);
    expect(validSession('5b0c1d2e-0000-4000-8000-000000000001')).toBeTruthy();
    expect(validSession('--resume')).toBeUndefined();
  });
});

describe('the autopilot and memory', () => {
  it('starts no agent while the machine is short of memory, and tries again when there is room', async () => {
    vi.resetModules();
    let short: { freeMB: number; minMB: number } | undefined = { freeMB: 512, minMB: 2048 };
    vi.doMock('vscode', () => ({
      EventEmitter: class {
        event = () => ({ dispose() {} });
        fire() {}
        dispose() {}
      },
      workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
    }));
    vi.doMock('../../../src/ui/backlog/agentRunner', () => ({ memoryShortage: () => short }));
    const { Autopilot } = await import('../../../src/ui/backlog/autopilot');
    const at = '2026-10-11T00:00:00Z';
    const data = { version: 1 as const, next: 2, items: [{ id: 'BL-1', title: 'Next', status: 'todo' as const, created: at }] };
    const prepareWorktree = vi.fn(async () => undefined);
    const pilot = new Autopilot({
      backlog: { dir: '/unused', watch: () => ({ dispose() {} }), ensureDir: async () => undefined, read: async () => data, readTicketCached: async () => ({ description: '', activity: [] }), appendActivity: async () => undefined, change: async () => data },
      reviews: {
        running: 0,
        limit: 2,
        waitingCount: 0,
        canStartNew: () => true,
        admitNew: () => 1,
        giveBack: () => undefined,
        pausedUntil: async () => undefined,
        startWork: async () => undefined,
      },
      leader: { isLeader: true, check: () => true },
      output: { appendLine() {} },
      key: async () => 'key',
      prepareWorktree,
    } as never);
    // Switched on directly: the signed switch is tested above.
    (pilot as unknown as { on: boolean }).on = true;
    await pilot.tick();
    expect(prepareWorktree).not.toHaveBeenCalled();
    expect(pilot.view().waitingForMemory).toBe(true);

    short = undefined;
    await pilot.tick();
    expect(prepareWorktree).toHaveBeenCalledTimes(1);
    expect(pilot.view().waitingForMemory).toBeUndefined();
    pilot.dispose();
  });
});

describe('the autopilot gives up a start whose item moved on', () => {
  it('starts no agent, gives its memory back and says so in the ticket, when the item left To Do while its worktree was prepared', async () => {
    vi.resetModules();
    vi.doMock('vscode', () => ({
      EventEmitter: class {
        event = () => ({ dispose() {} });
        fire() {}
        dispose() {}
      },
      workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
    }));
    // The real ledger (so the memory given back is what's counted); only the free-memory check is passed.
    vi.doMock('../../../src/ui/backlog/agentRunner', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../../src/ui/backlog/agentRunner')>()),
      memoryShortage: () => undefined,
    }));
    const { Autopilot } = await import('../../../src/ui/backlog/autopilot');
    const { releaseStart, reserveStart, startingMemoryMB } = await import('../../../src/ui/backlog/agentRunner');
    const at = '2026-10-11T00:00:00Z';
    const data = { version: 1 as const, next: 2, items: [{ id: 'BL-1', title: 'Next', status: 'todo' as const, created: at }] };
    const startWork = vi.fn(async () => undefined);
    const appendActivity = vi.fn(async () => undefined);
    let reservedWhilePrepared = 0;
    const pilot = new Autopilot({
      backlog: { dir: '/unused', watch: () => ({ dispose() {} }), ensureDir: async () => undefined, read: async () => data, readTicketCached: async () => ({ description: '', activity: [] }), appendActivity },
      // The review loop admits the start (see ReviewLoop.admitNew): its memory is reserved on the real ledger.
      reviews: {
        running: 0,
        limit: 2,
        waitingCount: 0,
        canStartNew: () => true,
        admitNew: () => reserveStart(),
        giveBack: (slot: number) => releaseStart(slot),
        pausedUntil: async () => undefined,
        startWork,
      },
      leader: { isLeader: true, check: () => true },
      output: { appendLine() {} },
      key: async () => 'key',
      // Preparing the worktree (which moves the item to In Progress) is followed by the user moving it on to done.
      prepareWorktree: async () => {
        reservedWhilePrepared = startingMemoryMB();
        (data.items[0] as { status: string }).status = 'done';
        return { worktree: { path: '/wt', branch: 'feature/BL-1-next' } } as never;
      },
    } as never);
    // Switched on directly: the signed switch is tested above.
    (pilot as unknown as { on: boolean }).on = true;
    await pilot.tick();
    expect(startWork).not.toHaveBeenCalled();
    // Held while the worktree was prepared, given back after.
    expect(reservedWhilePrepared).toBe(300);
    expect(startingMemoryMB()).toBe(0);
    expect(appendActivity).toHaveBeenCalledWith(expect.objectContaining({ id: 'BL-1' }), expect.objectContaining({ body: expect.stringContaining('moved on') }));
    pilot.dispose();
  });
});


describe('the autopilot and tickets that depend on others', () => {
  it('passes over a To Do ticket that waits for another to be merged (BL-55)', async () => {
    vi.resetModules();
    vi.doMock('vscode', () => ({
      EventEmitter: class {
        event = () => ({ dispose() {} });
        fire() {}
        dispose() {}
      },
      workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
    }));
    vi.doMock('../../../src/ui/backlog/agentRunner', () => ({ memoryShortage: () => undefined, reserveStart: () => 1, releaseStart: () => undefined }));
    const { Autopilot } = await import('../../../src/ui/backlog/autopilot');
    const at = '2026-10-11T00:00:00Z';
    const data = {
      version: 1 as const,
      next: 4,
      items: [
        { id: 'BL-1', title: 'Waits', status: 'todo' as const, created: at },
        { id: 'BL-2', title: 'Needed', status: 'doing' as const, created: at },
        { id: 'BL-3', title: 'Free', status: 'todo' as const, created: at },
      ],
    };
    const descriptions: Record<string, string> = { 'BL-1': 'Do it.\n\nDepends on: BL-2' };
    const prepareWorktree = vi.fn(async () => undefined);
    const pilot = new Autopilot({
      backlog: {
        dir: '/unused',
        watch: () => ({ dispose() {} }),
        ensureDir: async () => undefined,
        read: async () => data,
        readTicketCached: async (i: { id: string }) => ({ description: descriptions[i.id] ?? '', activity: [] }),
        appendActivity: async () => undefined,
        change: async () => data,
      },
      reviews: {
        running: 0,
        limit: 2,
        waitingCount: 0,
        canStartNew: () => true,
        admitNew: () => 1,
        giveBack: () => undefined,
        pausedUntil: async () => undefined,
        startWork: async () => undefined,
      },
      leader: { isLeader: true, check: () => true },
      output: { appendLine() {} },
      key: async () => 'key',
      prepareWorktree,
    } as never);
    (pilot as unknown as { on: boolean }).on = true;
    await pilot.tick();
    expect(prepareWorktree.mock.calls.map((c) => (c as unknown as [{ id: string }])[0].id)).toEqual(['BL-3']);
    pilot.dispose();
  });
});

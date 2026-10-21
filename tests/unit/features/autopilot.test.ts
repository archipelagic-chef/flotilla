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
      window: { onDidChangeWindowState: () => ({ dispose() {} }), showInformationMessage: async () => undefined },
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
      window: { onDidChangeWindowState: () => ({ dispose() {} }), showInformationMessage: async () => undefined },
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
      window: { onDidChangeWindowState: () => ({ dispose() {} }), showInformationMessage: async () => undefined },
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
      window: { onDidChangeWindowState: () => ({ dispose() {} }), showInformationMessage: async () => undefined },
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

describe('the autopilot and tickets whose files clash with work in progress', () => {
  it('passes over a To Do ticket whose named file a ticket in progress changes, notes it once, and not when turned off (BL-71)', async () => {
    vi.resetModules();
    let avoidClashes = true;
    vi.doMock('vscode', () => ({
      EventEmitter: class {
        event = () => ({ dispose() {} });
        fire() {}
        dispose() {}
      },
      workspace: { getConfiguration: () => ({ get: (k: string, d: unknown) => (k === 'autopilot.avoidClashes' ? avoidClashes : d) }) },
      window: { onDidChangeWindowState: () => ({ dispose() {} }), showInformationMessage: async () => undefined },
    }));
    vi.doMock('../../../src/ui/backlog/agentRunner', () => ({ memoryShortage: () => undefined }));
    const path = await import('node:path');
    const { Autopilot } = await import('../../../src/ui/backlog/autopilot');
    const { git, initRepo, makeTempDir, removeDir, writeFile } = await import('../../helpers/gitRepo');
    // The repository: src/a.ts on main; BL-2's worktree (in progress) commits a change to it.
    const main = initRepo();
    const wt = path.join(makeTempDir(), 'bl-2');
    try {
      writeFile(main, 'src/a.ts', '1');
      writeFile(main, 'src/b.ts', '1');
      git(main, 'add', '.');
      git(main, 'commit', '-qm', 'files');
      git(main, 'worktree', 'add', '-q', '-b', 'feature/BL-2-busy', wt);
      writeFile(wt, 'src/a.ts', '2');
      git(wt, 'commit', '-qam', 'BL-2: change a');
      const at = '2026-10-11T00:00:00Z';
      const data = {
        version: 1 as const,
        next: 5,
        items: [
          { id: 'BL-1', title: 'Clashes', status: 'todo' as const, created: at },
          { id: 'BL-2', title: 'Busy', status: 'doing' as const, created: at },
          { id: 'BL-3', title: 'Free', status: 'todo' as const, created: at },
        ],
      };
      const descriptions: Record<string, string> = { 'BL-1': 'Change `src/a.ts`.', 'BL-3': 'Change `src/b.ts`.' };
      const activity: Record<string, Array<{ date: string; author: string; body: string }>> = {};
      const appendActivity = vi.fn(async (i: { id: string }, e: { date: string; author: string; body: string }) => void (activity[i.id] ??= []).push(e));
      const prepareWorktree = vi.fn(async () => undefined);
      const make = () =>
        new Autopilot({
          backlog: {
            dir: '/unused',
            watch: () => ({ dispose() {} }),
            ensureDir: async () => undefined,
            read: async () => data,
            readTicketCached: async (i: { id: string }) => ({ description: descriptions[i.id] ?? '', activity: activity[i.id] ?? [] }),
            appendActivity,
            change: async () => data,
          },
          repository: {
            current: [
              { worktree: { isMain: true, path: main, branch: 'main' } },
              { worktree: { isMain: false, path: wt, branch: 'feature/BL-2-busy' } },
            ],
          },
          reviews: { running: 0, limit: 2, waitingCount: 0, canStartNew: () => true, admitNew: () => 1, giveBack: () => undefined, pausedUntil: async () => undefined, startWork: async () => undefined },
          leader: { isLeader: true, check: () => true },
          output: { appendLine() {} },
          key: async () => 'key',
          prepareWorktree,
        } as never);
      // Switched on once the constructor's read of the (missing) switch is done, which would turn it off again.
      const switchOn = async (p: InstanceType<typeof Autopilot>) => {
        await (p as unknown as { refresh(): Promise<void> }).refresh();
        (p as unknown as { on: boolean }).on = true;
      };
      const started = () => prepareWorktree.mock.calls.map((c) => (c as unknown as [{ id: string }])[0].id);

      const pilot = make();
      await switchOn(pilot);
      await pilot.tick();
      expect(started()).toEqual(['BL-3']);
      expect(pilot.clashOf('BL-1')).toEqual({ with: 'BL-2', files: ['src/a.ts'] });
      expect(pilot.clashOf('BL-3')).toBeUndefined();
      expect(activity['BL-1']).toHaveLength(1);
      expect(activity['BL-1'][0].body).toMatch(/^The autopilot holds it back: it would change `src\/a\.ts`, which BL-2 \(in progress\) changes too\./);
      // Another pass, and another window after a reload (its own memory): the ticket already says so.
      await pilot.tick();
      pilot.dispose();
      const reloaded = make();
      await switchOn(reloaded);
      await reloaded.tick();
      expect(activity['BL-1']).toHaveLength(1);
      // BL-3's start failed (no worktree here), so the first window doesn't try it again; the reloaded one does. BL-1 never.
      expect(started()).toEqual(['BL-3', 'BL-3']);

      // Turned off: nothing is held.
      avoidClashes = false;
      await reloaded.tick();
      expect(reloaded.clashOf('BL-1')).toBeUndefined();
      expect(started().at(-1)).toBe('BL-1');
      reloaded.dispose();
    } finally {
      git(main, 'worktree', 'remove', '--force', wt);
      removeDir(path.dirname(wt));
      removeDir(main);
    }
  });
});

describe('the autopilot starts tickets at once, and sequences them only by "Depends on" (BL-142)', () => {
  const setup = async () => {
    vi.resetModules();
    const notices: string[] = [];
    vi.doMock('vscode', () => ({
      EventEmitter: class {
        event = () => ({ dispose() {} });
        fire() {}
        dispose() {}
      },
      workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
      window: { onDidChangeWindowState: () => ({ dispose() {} }), showInformationMessage: async (m: string) => void notices.push(m) },
    }));
    vi.doMock('../../../src/ui/backlog/agentRunner', () => ({ memoryShortage: () => undefined }));
    const { Autopilot } = await import('../../../src/ui/backlog/autopilot');
    return { Autopilot, notices };
  };
  const at = '2026-10-21T00:00:00Z';
  type Item = { id: string; title: string; status: 'todo' | 'doing' | 'review' | 'done'; created: string };

  it('starts two tickets changing a file a ticket in progress changes, by default', async () => {
    const { Autopilot } = await setup();
    const path = await import('node:path');
    const { git, initRepo, makeTempDir, removeDir, writeFile } = await import('../../helpers/gitRepo');
    const main = initRepo();
    const wt = path.join(makeTempDir(), 'bl-2');
    try {
      writeFile(main, 'src/a.ts', '1');
      git(main, 'add', '.');
      git(main, 'commit', '-qm', 'files');
      git(main, 'worktree', 'add', '-q', '-b', 'feature/BL-2-busy', wt);
      writeFile(wt, 'src/a.ts', '2');
      git(wt, 'commit', '-qam', 'BL-2: change a');
      const data = {
        version: 1 as const,
        next: 5,
        items: [
          { id: 'BL-1', title: 'One', status: 'todo', created: at },
          { id: 'BL-2', title: 'Busy', status: 'doing', created: at },
          { id: 'BL-3', title: 'Two', status: 'todo', created: at },
        ] as Item[],
      };
      const prepareWorktree = vi.fn(async (i: Item) => void (i.status = 'doing') as undefined);
      const pilot = new Autopilot({
        backlog: {
          dir: '/unused',
          watch: () => ({ dispose() {} }),
          ensureDir: async () => undefined,
          read: async () => data,
          readTicketCached: async () => ({ description: 'Change `src/a.ts`.', activity: [] }),
          appendActivity: async () => undefined,
          change: async () => data,
        },
        repository: { current: [{ worktree: { isMain: true, path: main, branch: 'main' } }, { worktree: { isMain: false, path: wt, branch: 'feature/BL-2-busy' } }] },
        reviews: { running: 0, limit: 3, waitingCount: 0, canStartNew: () => true, admitNew: () => 1, giveBack: () => undefined, pausedUntil: async () => undefined, startWork: async () => undefined },
        leader: { isLeader: true, check: () => true },
        output: { appendLine() {} },
        key: async () => 'key',
        prepareWorktree,
      } as never);
      await (pilot as unknown as { refresh(): Promise<void> }).refresh();
      (pilot as unknown as { on: boolean }).on = true;
      await pilot.tick();
      expect(prepareWorktree.mock.calls.map((c) => (c as unknown as [Item])[0].id)).toEqual(['BL-1', 'BL-3']);
      expect(pilot.clashOf('BL-1')).toBeUndefined();
      pilot.dispose();
    } finally {
      git(main, 'worktree', 'remove', '--force', wt);
      removeDir(path.dirname(wt));
      removeDir(main);
    }
  });

  it('holds a ticket that depends on an unmerged one, says why when idle, notifies once after 30 minutes, and starts it once that one has landed', async () => {
    const { Autopilot, notices } = await setup();
    const data = {
      version: 1 as const,
      next: 5,
      items: [
        { id: 'BL-130', title: 'Waits', status: 'todo', created: at },
        { id: 'BL-126', title: 'First', status: 'review', created: at },
      ] as Item[],
    };
    const started: string[] = [];
    const pilot = new Autopilot({
      backlog: {
        dir: '/unused',
        watch: () => ({ dispose() {} }),
        ensureDir: async () => undefined,
        read: async () => data,
        readTicketCached: async (i: Item) => ({ description: i.id === 'BL-130' ? 'Depends on: BL-126' : '', activity: [] }),
        appendActivity: async () => undefined,
        change: async () => data,
      },
      repository: { current: [] },
      reviews: { running: 0, limit: 2, waitingCount: 0, canStartNew: () => true, admitNew: () => 1, giveBack: () => undefined, pausedUntil: async () => undefined, startWork: async () => undefined },
      leader: { isLeader: true, check: () => true },
      output: { appendLine() {} },
      key: async () => 'key',
      prepareWorktree: async (i: Item) => {
        started.push(i.id);
        i.status = 'doing';
        return undefined;
      },
    } as never);
    await (pilot as unknown as { refresh(): Promise<void> }).refresh();
    (pilot as unknown as { on: boolean }).on = true;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-21T01:00:00Z'));
      await pilot.tick();
      expect(started).toEqual([]);
      expect(pilot.view().idle).toBe('BL-130 waits for BL-126 (in review)');
      vi.setSystemTime(new Date('2026-10-21T01:20:00Z'));
      await pilot.tick();
      expect(notices).toEqual([]);
      vi.setSystemTime(new Date('2026-10-21T01:31:00Z'));
      await pilot.tick();
      await pilot.tick();
      expect(notices).toEqual(['The autopilot has been idle for 31 minutes: BL-130 waits for BL-126 (in review).']);
      // BL-126 lands: BL-130 starts.
      data.items[1].status = 'done';
      await pilot.tick();
      expect(started).toEqual(['BL-130']);
      expect(pilot.view().idle).toBe('nothing left in To Do');
    } finally {
      vi.useRealTimers();
      pilot.dispose();
    }
  });

  it('says on the return what it got done while the user was away', async () => {
    const { Autopilot } = await setup();
    const data = { version: 1 as const, next: 5, items: [{ id: 'BL-1', title: 'A', status: 'doing', created: at }] as Item[] };
    const pilot = new Autopilot({
      backlog: { dir: '/unused', watch: () => ({ dispose() {} }), ensureDir: async () => undefined, read: async () => data, readTicketCached: async () => ({ description: '', activity: [] }) },
      repository: { current: [] },
      reviews: { running: 0, limit: 2, waitingCount: 0, canStartNew: () => false, pausedUntil: async () => undefined },
      leader: { isLeader: true, check: () => true },
      output: { appendLine() {} },
      key: async () => 'key',
      prepareWorktree: async () => undefined,
    } as never);
    await (pilot as unknown as { refresh(): Promise<void> }).refresh();
    (pilot as unknown as { on: boolean }).on = true;
    await pilot.focused(false, new Date(2026, 9, 20, 22, 0));
    Object.assign(data.items[0], { status: 'review', review: { state: 'yours' } });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 9, 21, 7, 0));
      await pilot.focused(true, new Date(2026, 9, 21, 7, 0));
      expect(pilot.view().away).toBe('Overnight: 1 ticket done, 1 waiting for you');
    } finally {
      vi.useRealTimers();
      pilot.dispose();
    }
  });
});

describe('the autopilot and Try Now (BL-132)', () => {
  it('waits on, saying when it tried, while the limit is still there; takes To Do tickets again once it lifted', async () => {
    vi.resetModules();
    vi.doMock('vscode', () => ({
      EventEmitter: class {
        event = () => ({ dispose() {} });
        fire() {}
        dispose() {}
      },
      workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
      window: { onDidChangeWindowState: () => ({ dispose() {} }), showInformationMessage: async () => undefined },
    }));
    vi.doMock('../../../src/ui/backlog/agentRunner', () => ({ memoryShortage: () => undefined }));
    const { Autopilot } = await import('../../../src/ui/backlog/autopilot');
    const at = '2026-10-11T00:00:00Z';
    const data = { version: 1 as const, next: 2, items: [{ id: 'BL-1', title: 'Next', status: 'todo' as const, created: at }] };
    const reset = new Date(Date.now() + 3600_000);
    let until: Date | undefined = reset;
    const tried = new Date();
    const tryPausedNow = vi.fn(async () => ({ tried, resumed: 0, limited: reset }) as { tried: Date; resumed: number; limited?: Date });
    const prepareWorktree = vi.fn(async () => undefined);
    const pilot = new Autopilot({
      backlog: { dir: '/unused', watch: () => ({ dispose() {} }), ensureDir: async () => undefined, read: async () => data, readTicketCached: async () => ({ description: '', activity: [] }), appendActivity: async () => undefined, change: async () => data },
      reviews: { running: 0, limit: 2, waitingCount: 0, canStartNew: () => true, admitNew: () => 1, giveBack: () => undefined, pausedUntil: async () => until, startWork: async () => undefined, tryPausedNow },
      leader: { isLeader: true, check: () => true },
      output: { appendLine() {} },
      key: async () => 'key',
      prepareWorktree,
    } as never);
    (pilot as unknown as { on: boolean }).on = true;
    await pilot.tick();
    expect(pilot.view()).toMatchObject({ waitingUntil: reset.toISOString() });
    expect(pilot.view().triedAt).toBeUndefined();

    await pilot.tryNow();
    expect(pilot.enabled).toBe(true);
    expect(pilot.view()).toMatchObject({ waitingUntil: reset.toISOString(), triedAt: tried.toISOString() });
    expect(prepareWorktree).not.toHaveBeenCalled();

    tryPausedNow.mockResolvedValue({ tried: new Date(), resumed: 1 });
    until = undefined;
    await pilot.tryNow();
    expect(pilot.view().waitingUntil).toBeUndefined();
    expect(pilot.view().triedAt).toBeUndefined();
    expect(prepareWorktree).toHaveBeenCalledTimes(1);
    pilot.dispose();
  });
});

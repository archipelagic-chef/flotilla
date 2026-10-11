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

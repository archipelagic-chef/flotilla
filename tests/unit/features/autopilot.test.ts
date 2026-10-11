import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

describe('the autopilot', () => {
  it('takes the first accepted To Do ticket, an epic\'s parts rather than the epic', async () => {
    const { nextForAutopilot } = await import('../../../src/ui/backlog/autopilot');
    const at = '2026-10-11T00:00:00Z';
    const data = {
      version: 1,
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

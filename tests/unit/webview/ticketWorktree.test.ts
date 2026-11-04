import {
  describe,
  expect,
  it,
} from 'vitest';
import { worktreeAt } from '../../../src/webview/ui/ticketWorktree';
import type { WorkstreamView } from '../../../src/webview/protocol';

describe("Where a ticket's change is read (BL-275)", () => {
  const ws = (key: string, path: string, isMain = false) => ({ key, path, isMain }) as WorkstreamView;
  const main = ws('main', '/repo', true);
  const a = ws('a', '/repo/.worktrees/bl-3-a');
  const b = ws('b', '/repo/.worktrees/bl-3-b');

  it('reads each group of a ticket with two branches in its own worktree', () => {
    expect(worktreeAt([main, a, b], '/repo/.worktrees/bl-3-a')).toBe(a);
    expect(worktreeAt([main, a, b], '/repo/.worktrees/bl-3-b')).toBe(b);
  });

  it("reads a merged ticket's change in the main worktree, its own being gone", () => {
    expect(worktreeAt([main, b], '/repo/.worktrees/bl-3-a')).toBe(main);
  });
});

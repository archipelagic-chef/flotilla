import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  backlogIdOf,
  linkedWorktrees,
} from '../../../src/ui/backlog/cardMenu';

describe('backlogIdOf', () => {
  it('reads an id, or the card of a context menu', () => {
    expect(backlogIdOf('BL-21')).toBe('BL-21');
    expect(backlogIdOf({ backlogId: 'BL-21', webviewSection: 'backlogItem' })).toBe('BL-21');
    expect(backlogIdOf({ key: 'main' })).toBeUndefined();
    expect(backlogIdOf(undefined)).toBeUndefined();
  });
});

describe('linkedWorktrees', () => {
  const ws = (key: string, branch: string | undefined, isMain = false) => ({ key, worktree: { isMain, path: `/w/${key}`, branch } });
  const item = { id: 'BL-21', branches: ['feature/BL-21-x'] };

  it('takes the worktrees whose branch carries the item, but not the main one', () => {
    const list = [ws('main', 'main', true), ws('a', 'feature/BL-21-x'), ws('b', 'feature/BL-21-part-2'), ws('c', 'feature/BL-3-y')];
    expect(linkedWorktrees(item, list).map((w) => w.key)).toEqual(['a', 'b']);
  });

  it('leaves out worktrees without a path or a branch', () => {
    const detached = { key: 'd', worktree: { isMain: false, path: '/w/d', branch: undefined } };
    const pathless = { key: 'p', worktree: { isMain: false, path: undefined, branch: 'feature/BL-21-x' } };
    expect(linkedWorktrees(item, [detached, pathless])).toEqual([]);
  });
});

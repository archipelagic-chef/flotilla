import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (l: (e: T) => void) => {
      this.listeners.push(l);
      return { dispose() {} };
    };
    fire(e: T) {
      this.listeners.forEach((l) => l(e));
    }
    dispose() {}
  }
  return { EventEmitter, commands: { executeCommand: () => Promise.resolve() } };
});
const { ActiveWorktree, ALL } = await import('../../../src/ui/activeWorktree');

function memento(initial: Record<string, unknown> = {}) {
  const data = { ...initial };
  return { get: (k: string) => data[k], update: (k: string, v: unknown) => ((data[k] = v), Promise.resolve()), keys: () => Object.keys(data), data };
}

describe('ActiveWorktree tabs', () => {
  const order = ['a', 'b', 'c', 'd'];

  it('closing the active tab activates the next open one, then the previous, then All', () => {
    const active = new ActiveWorktree(memento() as never);
    active.set('b');
    active.close(['b'], order);
    expect(active.key).toBe('c');
    active.close(['d'], order);
    active.close(['c'], order);
    expect(active.key).toBe('a');
    active.close(['a'], order);
    expect(active.key).toBe(ALL);
    expect([...active.closedTabs].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('reopens a tab when its worktree is selected, and remembers closed tabs per window', () => {
    const state = memento();
    const active = new ActiveWorktree(state as never);
    const seen: string[][] = [];
    active.onDidChangeTabs((closed) => seen.push([...closed]));
    active.close(['a', 'c'], order);
    expect(active.isOpen('a')).toBe(false);
    active.set('a');
    expect(active.isOpen('a')).toBe(true);
    expect(seen.at(-1)).toEqual(['c']);
    const again = new ActiveWorktree(state as never);
    expect(again.closedTabs).toEqual(['c']);
    expect(again.key).toBe('a');
  });

  it('starts on All if the remembered worktree tab is closed', () => {
    const active = new ActiveWorktree(memento({ 'flotilla.activeWorktree': 'b', 'flotilla.closedTabs': ['b'] }) as never);
    expect(active.key).toBe(ALL);
  });
});

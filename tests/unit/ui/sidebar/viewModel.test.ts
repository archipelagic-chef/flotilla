import { describe, expect, it } from 'vitest';
import type { FileChange } from '../../../../src/core/git/porcelain';
import type { Workstream } from '../../../../src/features/workstreams/workstream';
import { capChanges, changedViews, toWorkstreamView } from '../../../../src/ui/sidebar/viewModel';
import type { WorkstreamView } from '../../../../src/webview/protocol';

const change = (n: number): FileChange => ({ path: `f${n}.txt`, kind: 'modified' });

describe('the changes the sidebar gets', () => {
  it('sends the first changes and says how many there are', () => {
    const list = [change(1), change(2), change(3)];
    expect(capChanges(list, 2)).toEqual({ items: [change(1), change(2)], total: 3 });
    expect(capChanges(list, 5000)).toEqual({ items: list, total: 3 });
    expect(capChanges([], 5000)).toEqual({ items: [], total: 0 });
  });

  it('sends none at a limit of zero', () => {
    expect(capChanges([change(1), change(2)], 0)).toEqual({ items: [], total: 2 });
  });
});

describe('the worktrees a refresh sends', () => {
  const view = (key: string, label = key) => ({ key, branch: label }) as unknown as WorkstreamView;

  it('sends everything when nothing was sent yet', () => {
    const sent = new Map<string, string>();
    expect(changedViews([view('a'), view('b')], sent)).toEqual({ changed: [view('a'), view('b')], keys: ['a', 'b'] });
  });

  it('sends only the worktrees that changed, and every key in order', () => {
    const sent = new Map<string, string>();
    changedViews([view('a'), view('b'), view('c')], sent);
    expect(changedViews([view('a'), view('b', 'renamed'), view('c')], sent)).toEqual({ changed: [view('b', 'renamed')], keys: ['a', 'b', 'c'] });
    expect(changedViews([view('a'), view('c')], sent)).toEqual({ changed: [], keys: ['a', 'c'] });
  });
});

describe('a worktree in the sidebar', () => {
  const ws = (staged: number, unstaged: number) =>
    ({
      key: 'k',
      worktree: { path: '/repo/wt', isMain: false, branch: 'feature/x' },
      changes: [],
      staged: Array.from({ length: staged }, (_, i) => change(i)),
      unstaged: Array.from({ length: unstaged }, (_, i) => change(100 + i)),
      sync: { upstream: undefined, ahead: 0, behind: 0, hasRemote: false, head: 'abc' },
      chats: [],
      hasHooks: true,
      agent: undefined,
      agentStale: false,
      heartbeat: undefined,
      windowOpen: false,
      lastActivity: undefined,
      activity: 'idle',
      progress: undefined,
      attention: 'idle',
      isCurrent: false,
    }) as unknown as Workstream;

  it('gets at most the limit across its staged and unstaged changes, and the totals', () => {
    const w = ws(3, 10);
    const view = toWorkstreamView(w, [w], new Date(0), false, undefined, 5);
    expect(view.staged).toHaveLength(3);
    expect(view.unstaged).toHaveLength(2);
    expect(view.totals).toEqual({ staged: 3, unstaged: 10 });
  });
});

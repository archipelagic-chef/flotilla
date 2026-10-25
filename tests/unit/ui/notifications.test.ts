import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { BacklogItem } from '../../../src/features/backlog/backlog';
import type { ReviewState } from '../../../src/features/backlog/review';
import type { Workstream } from '../../../src/features/workstreams/workstream';
import { NeedsYouNotifier } from '../../../src/ui/notifications';

const vs = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  info: vi.fn(async (..._args: unknown[]) => undefined as string | undefined),
  warn: vi.fn(async (..._args: unknown[]) => undefined as string | undefined),
}));

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
  return {
    EventEmitter,
    window: { showInformationMessage: vs.info, showWarningMessage: vs.warn, showQuickPick: () => Promise.resolve(undefined) },
    workspace: { getConfiguration: () => ({ get: (key: string, fallback: unknown) => (key in vs.settings ? vs.settings[key] : fallback) }) },
  };
});

const BATCH_MS = 60_000;

function item(id: string, review?: ReviewState['state']): BacklogItem {
  const base = { id, title: `Title of ${id}`, status: 'review', priority: 'medium', created: '2026-10-12T09:00:00Z' };
  return (review ? { ...base, review: { round: 1, state: review, reviewer: 'Nova-7' } } : base) as BacklogItem;
}

function worktree(key: string, attention: string, isCurrent = false): Workstream {
  return { key, attention, isCurrent, worktree: { branch: `feature/${key}`, path: `/wt/${key}` } } as unknown as Workstream;
}

/** The notifier with fakes for the backlog, the worktrees and the leader; the test changes `state` and refreshes. */
function harness(state: { items?: BacklogItem[]; worktrees?: Workstream[]; leader?: boolean } = {}) {
  const s = { items: state.items ?? [], worktrees: state.worktrees ?? [], leader: state.leader ?? true };
  const openTicket = vi.fn();
  const openWorktree = vi.fn(async () => undefined);
  const notifier = new NeedsYouNotifier({
    backlog: { read: async () => ({ items: s.items }), watch: () => ({ dispose() {} }) } as never,
    repository: {
      get current() {
        return s.worktrees;
      },
      onDidChange: () => ({ dispose() {} }),
    } as never,
    reviews: { onDidChange: () => ({ dispose() {} }) } as never,
    leader: {
      get isLeader() {
        return s.leader;
      },
    },
    openTicket,
    openWorktree,
  });
  harnesses.push(notifier);
  return { s, notifier, openTicket, openWorktree };
}
const harnesses: NeedsYouNotifier[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vs.info.mockClear();
  vs.warn.mockClear();
  vs.settings = { notify: 'needsYou' };
});

afterEach(() => {
  harnesses.splice(0).forEach((n) => n.dispose());
  vi.useRealTimers();
});

describe('NeedsYouNotifier', () => {
  it('shows nothing for what was already there when the window opened', async () => {
    const { notifier } = harness({ items: [item('BL-1', 'yours')] });
    await notifier.refresh();
    vi.advanceTimersByTime(BATCH_MS);
    expect(notifier.current.map((n) => n.key)).toEqual(['review:BL-1']);
    expect(vs.info).not.toHaveBeenCalled();
    expect(vs.warn).not.toHaveBeenCalled();
  });

  it('holds new needs for a minute, then shows them as one grouped notification', async () => {
    const { s, notifier } = harness();
    await notifier.refresh();
    s.items = [item('BL-1', 'yours'), item('BL-2', 'asking')];
    await notifier.refresh();
    vi.advanceTimersByTime(BATCH_MS - 1);
    expect(vs.info).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(vs.info).toHaveBeenCalledTimes(1);
    expect(vs.info).toHaveBeenCalledWith('2 tickets need you: BL-2 asks a question, BL-1 is ready for your review.', 'Show');
  });

  it('leaves out a need that was resolved before the batch is shown', async () => {
    const { s, notifier } = harness({ items: [] });
    await notifier.refresh();
    s.items = [item('BL-1', 'yours'), item('BL-2', 'asking')];
    await notifier.refresh();
    s.items = [item('BL-2', 'asking')];
    await notifier.refresh();
    vi.advanceTimersByTime(BATCH_MS);
    expect(vs.info).toHaveBeenCalledWith('BL-2 asks a question.', 'Show');
  });

  it('shows each new need at once in `all`, and starts no batch', async () => {
    vs.settings.notify = 'all';
    const { s, notifier } = harness();
    await notifier.refresh();
    s.items = [item('BL-1', 'yours')];
    await notifier.refresh();
    expect(vs.info).toHaveBeenCalledWith('BL-1 is ready for your review.', 'Open');
    expect(vs.info).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows errors and stopped reviews as warnings', async () => {
    const { s, notifier } = harness();
    await notifier.refresh();
    s.worktrees = [worktree('a', 'error')];
    await notifier.refresh();
    vi.advanceTimersByTime(BATCH_MS);
    expect(vs.warn).toHaveBeenCalledWith('feature/a reported an error.', 'Show');
    expect(vs.info).not.toHaveBeenCalled();
  });

  it('shows nothing in `off`, but the list still counts what needs the user', async () => {
    vs.settings.notify = 'off';
    const { s, notifier } = harness();
    await notifier.refresh();
    s.items = [item('BL-1', 'yours')];
    await notifier.refresh();
    vi.advanceTimersByTime(BATCH_MS);
    expect(vs.info).not.toHaveBeenCalled();
    expect(notifier.current.map((n) => n.key)).toEqual(['review:BL-1']);
  });

  it('shows nothing from a window that is not the leader', async () => {
    const { s, notifier } = harness({ leader: false });
    await notifier.refresh();
    s.items = [item('BL-1', 'yours')];
    await notifier.refresh();
    vi.advanceTimersByTime(BATCH_MS);
    expect(vs.info).not.toHaveBeenCalled();
    expect(notifier.current).toHaveLength(1);
  });

  it("doesn't announce a need in the window's own worktree", async () => {
    const { s, notifier } = harness();
    await notifier.refresh();
    s.worktrees = [worktree('a', 'waiting-for-input', true), worktree('b', 'waiting-for-input')];
    await notifier.refresh();
    vi.advanceTimersByTime(BATCH_MS);
    expect(vs.info).toHaveBeenCalledTimes(1);
    expect(vs.info).toHaveBeenCalledWith('feature/b is waiting for input.', 'Show');
    expect(notifier.current).toHaveLength(2);
  });
});

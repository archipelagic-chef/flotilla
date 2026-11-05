import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  MAIN,
  pickedTicket,
  pickFor,
  samePick,
  selectTicket,
  shown,
  stripFor,
} from '../../../src/webview/ui/picked';
import type {
  BacklogItemView,
  WorkstreamView,
} from '../../../src/webview/protocol';

const ws = (key: string, branch: string, isMain = false) => ({ key, branch, isMain, label: branch }) as unknown as WorkstreamView;
const item = (id: string, extra: Partial<BacklogItemView> = {}) => ({ id, title: id, status: 'doing', ...extra }) as unknown as BacklogItemView;

const main = ws('main', 'main', true);
const a = ws('a', 'feature/BL-3-keep-chats');
const b = ws('b', 'feature/BL-3-keep-chats-2');
const loose = ws('c', 'investigate-leak');
const workstreams = [main, a, b, loose];
const backlog = [item('BL-3'), item('BL-4')];

describe('The selected item (BL-290)', () => {
  it('is main when nothing is selected: the sub-views show the main worktree', () => {
    expect(shown(undefined, workstreams, backlog)).toEqual({ picked: MAIN, ws: main, worktrees: [] });
    expect(shown(MAIN, workstreams, backlog).ws).toBe(main);
  });

  it('is main again when the selected ticket or worktree is gone', () => {
    expect(shown({ kind: 'ticket', id: 'BL-99' }, workstreams, backlog).picked).toEqual(MAIN);
    expect(shown({ kind: 'worktree', key: 'gone' }, workstreams, backlog).picked).toEqual(MAIN);
  });

  it("shows a ticket's first worktree when it has two, and the other once it's picked", () => {
    const first = shown({ kind: 'ticket', id: 'BL-3' }, workstreams, backlog);
    expect(first.worktrees).toEqual([a, b]);
    expect(first.ws).toBe(a);
    expect(shown({ kind: 'ticket', id: 'BL-3', worktree: 'b' }, workstreams, backlog).ws).toBe(b);
  });

  it('shows no worktree for a ticket with none, and keeps it selected while the backlog loads', () => {
    const none = shown({ kind: 'ticket', id: 'BL-4' }, workstreams, backlog);
    expect(none.ticket?.id).toBe('BL-4');
    expect(none.ws).toBeUndefined();
    expect(shown({ kind: 'ticket', id: 'BL-3' }, workstreams, undefined)).toEqual({ picked: { kind: 'ticket', id: 'BL-3' }, worktrees: [] });
  });

  it("doesn't select a proposed or another backlog's ticket", () => {
    const items = [item('BL-3', { proposed: {} })];
    expect(shown({ kind: 'ticket', id: 'BL-3' }, workstreams, items).picked).toEqual(MAIN);
  });

  it('opening a worktree selects its item: its ticket, a worktree of its own, or main', () => {
    expect(pickFor('b', workstreams, backlog)).toEqual({ kind: 'ticket', id: 'BL-3', worktree: 'b' });
    expect(pickFor('c', workstreams, backlog)).toEqual({ kind: 'worktree', key: 'c' });
    expect(pickFor('main', workstreams, backlog)).toEqual(MAIN);
    expect(shown(pickFor('c', workstreams, backlog), workstreams, backlog).ws).toBe(loose);
  });

  it('keeps the worktree picked of a ticket selected again', () => {
    const picked = { kind: 'ticket', id: 'BL-3', worktree: 'b' } as const;
    expect(pickedTicket(picked, 'BL-3')).toBe(picked);
    expect(pickedTicket(picked, 'BL-4')).toEqual({ kind: 'ticket', id: 'BL-4' });
    expect(samePick(undefined, MAIN)).toBe(true);
  });

  it('a click on a card selects its ticket, even when its tab is already the active editor (main selected since)', () => {
    const atMain = { tool: 'backlog' as const, picked: MAIN, backlogPart: 'list' as const };
    expect(selectTicket(atMain, 'BL-3')).toEqual({ tool: 'backlog', picked: { kind: 'ticket', id: 'BL-3' }, backlogPart: 'list' });
    const onIt = { picked: { kind: 'ticket', id: 'BL-3', worktree: 'b' } as const, backlogPart: 'changes' as const };
    expect(selectTicket(onIt, 'BL-3')).toBe(onIt);
  });

  it('opens a window saved on the old Files, Search or Version Control tool on that sub-view of the Backlog', () => {
    for (const tool of ['files', 'search', 'vc'] as const) expect(stripFor(tool, false)).toEqual({ top: 'backlog', sub: tool });
    expect(stripFor('backlog', false)).toEqual({ top: 'backlog', sub: 'backlog' });
    // A ticket's Changes, Commits or CI under its card are its Version Control.
    expect(stripFor('backlog', true)).toEqual({ top: 'backlog', sub: 'vc' });
    expect(stripFor('chats', false)).toEqual({ top: 'chats' });
  });
});

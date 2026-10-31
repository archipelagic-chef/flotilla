import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  type OpenTicket,
  ticketsForBacklogChange,
  ticketsForRepositoryChange,
} from '../../../src/features/backlog/refresh';

const items = [{ id: 'BL-1' }, { id: 'BL-2', parent: 'BL-1' }, { id: 'BL-3', parent: 'BL-1' }, { id: 'BL-4' }];

const none = new Set<string>();
const files = (...names: string[]) => new Set(names);

describe('ticketsForBacklogChange', () => {
  it('refreshes a ticket whose file changed, and only it', () => {
    expect(ticketsForBacklogChange({ items, changed: none, files: files('BL-4.md') })).toEqual(new Set(['BL-4']));
  });

  it('refreshes an item whose record changed, with its parent and its parts, and no other', () => {
    expect(ticketsForBacklogChange({ items, changed: new Set(['BL-2']), files: files('backlog.json') })).toEqual(new Set(['BL-2', 'BL-1']));
    // A parent's change reaches its parts (they show its title and status).
    expect(ticketsForBacklogChange({ items, changed: new Set(['BL-1']), files: files('backlog.json') })).toEqual(new Set(['BL-1', 'BL-2', 'BL-3']));
  });

  it('refreshes every ticket for a change without a name, and for posted.json', () => {
    expect(ticketsForBacklogChange({ items, changed: none, files: files('*') })).toBe('all');
    expect(ticketsForBacklogChange({ items, changed: none, files: files('posted.json') })).toBe('all');
  });

  it('names the id of a Markdown file, and nothing for any other file', () => {
    expect(ticketsForBacklogChange({ items, changed: none, files: files('AGENTS.md') })).toEqual(new Set(['AGENTS']));
    expect(ticketsForBacklogChange({ items, changed: none, files: files('notes.txt') })).toEqual(new Set());
  });
});

/** A ticket open in a panel, with the given worktree keys, branches and ids. */
function open(id: string, over: Partial<OpenTicket> = {}): OpenTicket {
  return { id, ids: [id], keys: new Set(), branches: () => false, ...over };
}

describe('ticketsForRepositoryChange', () => {
  it('refreshes a ticket whose worktree changed, and not one with an unrelated worktree', () => {
    const tickets = [open('BL-1', { keys: new Set(['/w/one']) }), open('BL-2', { keys: new Set(['/w/two']) })];
    expect(ticketsForRepositoryChange({ open: tickets, changedKeys: new Set(['/w/one']), chatStarts: [] })).toEqual(new Set(['BL-1']));
    expect(ticketsForRepositoryChange({ open: tickets, changedKeys: new Set(['/w/three']), chatStarts: [] })).toEqual(new Set());
  });

  it('refreshes a ticket whose shown agent changed (its key is shown in the view)', () => {
    const tickets = [open('BL-1', { keys: new Set(['chat-7']) })];
    expect(ticketsForRepositoryChange({ open: tickets, changedKeys: new Set(['chat-7']), chatStarts: [] })).toEqual(new Set(['BL-1']));
  });

  it('refreshes the ticket a changed chat was started for', () => {
    const tickets = [open('BL-1'), open('BL-2')];
    expect(ticketsForRepositoryChange({ open: tickets, changedKeys: new Set(['/w/x']), chatStarts: ['BL-2'] })).toEqual(new Set(['BL-2']));
  });

  it('refreshes, when a ref moved, the ticket whose branch moved, and not the others', () => {
    const tickets = [open('BL-1', { branches: (b) => b === 'feature/BL-1-sso' }), open('BL-2', { branches: () => false })];
    const moves = { branches: ['feature/BL-1-sso'], commits: [] };
    expect(ticketsForRepositoryChange({ open: tickets, changedKeys: new Set(), chatStarts: [], moves })).toEqual(new Set(['BL-1']));
  });

  it('refreshes, when a ref moved, the tickets a new commit mentions (whole ids, linked issues too)', () => {
    const tickets = [open('BL-1'), open('BL-12'), open('BL-4', { ids: ['BL-4', 'ABC-7'] })];
    const moves = {
      branches: [],
      commits: [
        { subject: 'Fix BL-1 in the lock', body: '' },
        { subject: 'Linked ABC-7', body: '' },
      ],
    };
    expect(ticketsForRepositoryChange({ open: tickets, changedKeys: new Set(), chatStarts: [], moves })).toEqual(new Set(['BL-1', 'BL-4']));
  });

  it('refreshes nothing when nothing relevant moved', () => {
    const tickets = [open('BL-1', { keys: new Set(['/w/one']), branches: () => false })];
    const moves = { branches: ['main'], commits: [{ subject: 'Unrelated', body: 'no ids here' }] };
    expect(ticketsForRepositoryChange({ open: tickets, changedKeys: new Set(['/w/other']), chatStarts: [], moves })).toEqual(new Set());
  });
});

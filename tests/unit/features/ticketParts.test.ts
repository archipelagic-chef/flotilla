import { describe, expect, it } from 'vitest';
import { applyTicketParts, ticketUpdate } from '../../../src/webview/ticketParts';
import type { TicketPartsMessage, TicketView } from '../../../src/webview/ticketProtocol';

/** A view with what the tests change; the rest is as a ticket without remote, worktrees or commits has it. */
function view(over: Partial<TicketView> = {}): TicketView {
  return {
    item: { id: 'BL-1', title: 'A ticket', status: 'doing', created: '2026-10-12T10:00:00Z' },
    description: 'Text',
    descriptionHtml: '<p>Text</p>',
    activity: [],
    postTargets: [],
    canCreateIssue: false,
    links: [],
    worktrees: [],
    canReview: false,
    children: [],
    branches: [],
    commits: [],
    history: [],
    canCleanUp: false,
    agentDefaults: {},
    agents: [],
    showActivity: false,
    canDiscuss: false,
    ...over,
  } as TicketView;
}

const entry = (body: string, author = 'Nova-7') => ({ date: '2026-10-12 10:00', author, body, html: `<p>${body}</p>` });

/** Sends the change from `before` as the host would, and applies it as the webview would. */
function sent(before: TicketView, after: TicketView): { message: ReturnType<typeof ticketUpdate>; shown: TicketView } {
  const message = ticketUpdate(before, after);
  return { message, shown: message?.type === 'ticketParts' ? applyTicketParts(before, message) : after };
}

describe('ticketUpdate', () => {
  it('sends the whole view when nothing was sent before', () => {
    const after = view();
    expect(ticketUpdate(undefined, after)).toEqual({ type: 'ticket', ticket: after });
  });

  it('sends nothing when the view is the same', () => {
    expect(ticketUpdate(view({ activity: [entry('a')] }), view({ activity: [entry('a')] }))).toBeUndefined();
  });

  it('sends only the parts that differ: a status change is the item alone', () => {
    const before = view({ activity: [entry('a')] });
    const after = view({ item: { ...before.item, status: 'review' }, activity: [entry('a')] });
    const message = ticketUpdate(before, after) as TicketPartsMessage;
    expect(message).toEqual({ type: 'ticketParts', parts: { item: after.item }, removed: [] });
  });

  it('appends a new entry: the entries kept are the ones before it, and only the new one is sent', () => {
    const before = view({ activity: [entry('a'), entry('b')] });
    const after = view({ activity: [entry('a'), entry('b'), entry('c')] });
    expect(ticketUpdate(before, after)).toEqual({ type: 'ticketParts', parts: {}, removed: [], activity: { keep: 2, entries: [entry('c')] } });
  });

  it('sends from the first entry that changed (a posted entry, a chat that moved on)', () => {
    const before = view({ activity: [entry('a'), entry('b'), entry('c')] });
    const after = view({ activity: [entry('a'), { ...entry('b'), posted: 'BL-1' }, entry('c')] });
    expect(ticketUpdate(before, after)).toEqual({
      type: 'ticketParts',
      parts: {},
      removed: [],
      activity: { keep: 1, entries: [{ ...entry('b'), posted: 'BL-1' }, entry('c')] },
    });
  });

  it('sends the parts that went away as removed (the loading flag, once the tracker answered)', () => {
    const before = view({ loading: true });
    const after = view();
    expect(ticketUpdate(before, after)).toEqual({ type: 'ticketParts', parts: {}, removed: ['loading'] });
  });

  it('sends the activity going shorter (entries removed) from where it differs', () => {
    const before = view({ activity: [entry('a'), entry('b')] });
    const after = view({ activity: [entry('a')] });
    expect(ticketUpdate(before, after)).toEqual({ type: 'ticketParts', parts: {}, removed: [], activity: { keep: 1, entries: [] } });
  });
});

describe('applyTicketParts', () => {
  const cases: Array<[string, TicketView, TicketView]> = [
    ['a status and a title', view(), view({ item: { id: 'BL-1', title: 'Renamed', status: 'done', created: '' } })],
    ['a comment appended', view({ activity: [entry('a')] }), view({ activity: [entry('a'), entry('You says', 'You')] })],
    ['the worktrees and commits', view(), view({ worktrees: [{ key: 'k', branch: 'b', attention: 'idle', status: 'Idle', changes: 2, ahead: 0, behind: 0 }], commits: [] })],
    ['a part gone', view({ loading: true, error: 'x' }), view({ error: 'x' })],
    ['an entry changed in the middle', view({ activity: [entry('a'), entry('b'), entry('c')] }), view({ activity: [entry('a'), entry('B'), entry('c'), entry('d')] })],
    ['nothing at all', view({ activity: [entry('a')] }), view({ activity: [entry('a')] })],
  ];

  it.each(cases)('brings the view to the new one: %s', (_name, before, after) => {
    const { message, shown } = sent(before, after);
    expect(shown).toEqual(after);
    if (message) expect((message as TicketPartsMessage).type).toBe('ticketParts');
  });

  it('sends fewer bytes than the whole view for a change to one part (the messages are measured in JSON)', () => {
    const busy = view({ activity: Array.from({ length: 200 }, (_, i) => entry(`entry ${i}`)) });
    const after = view({ activity: busy.activity, item: { ...busy.item, status: 'review' } });
    const part = JSON.stringify(ticketUpdate(busy, after));
    expect(part.length).toBeLessThan(JSON.stringify({ type: 'ticket', ticket: after }).length / 50);
  });
});

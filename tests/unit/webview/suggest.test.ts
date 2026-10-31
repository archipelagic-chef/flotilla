import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  matchEntries,
  matchTickets,
  pickSuggestion,
  suggestQuery,
} from '../../../src/webview/ticket/suggest';

const at = (text: string) => suggestQuery(text, text.length, 'BL-');

describe('what the comment box suggests (BL-130)', () => {
  it('suggests tickets after "#" or the ids’ prefix', () => {
    expect(at('See #')).toEqual({ kind: 'ticket', start: 4, query: '' });
    expect(at('See #log')).toEqual({ kind: 'ticket', start: 4, query: 'log' });
    expect(at('BL-1')).toEqual({ kind: 'ticket', start: 0, query: 'BL-1' });
    expect(at('(BL-')).toEqual({ kind: 'ticket', start: 1, query: 'BL-' });
  });

  it('suggests a ticket’s comments after its id and "#"', () => {
    expect(at('As BL-102#')).toEqual({ kind: 'entry', start: 3, id: 'BL-102', query: '' });
    expect(at('As BL-102#2026')).toEqual({ kind: 'entry', start: 3, id: 'BL-102', query: '2026' });
  });

  it('suggests nothing in words, headings and code', () => {
    expect(at('UTF-')).toBeUndefined();
    expect(at('a#b')).toBeUndefined();
    expect(at('# ')).toBeUndefined();
    expect(at('`#')).toBeUndefined();
    expect(at('```\n#')).toBeUndefined();
    expect(at('XBL-')).toBeUndefined();
  });

  it('matches tickets by id, then by title, newest first, without the ticket itself', () => {
    const tickets = [
      { id: 'BL-1', title: 'Login', status: 'done' as const },
      { id: 'BL-12', title: 'Logout', status: 'todo' as const },
      { id: 'BL-2', title: 'Blog', status: 'todo' as const },
    ];
    expect(matchTickets(tickets, 'BL-1').map((t) => t.id)).toEqual(['BL-12', 'BL-1']);
    expect(matchTickets(tickets, '2').map((t) => t.id)).toEqual(['BL-2']);
    expect(matchTickets(tickets, 'log', 'BL-12').map((t) => t.id)).toEqual(['BL-2', 'BL-1']);
  });

  it('matches entries by author and first line', () => {
    const entries = [
      { anchor: '2026-10-20-1604-you', author: 'You', date: '2026-10-20 16:04', text: 'Why?' },
      { anchor: '2026-10-20-1610-agent-nova-7', author: 'Agent Nova-7', date: '2026-10-20 16:10', text: 'Plan' },
    ];
    expect(matchEntries(entries, 'nova').map((e) => e.author)).toEqual(['Agent Nova-7']);
    expect(matchEntries(entries, 'why').map((e) => e.author)).toEqual(['You']);
    expect(matchEntries(entries, '')).toHaveLength(2);
  });

  it('puts the reference in place of what was typed, with a space', () => {
    expect(pickSuggestion('See #log now', 8, 4, 'BL-2')).toEqual({ from: 4, to: 8, insert: 'BL-2', selStart: 8, selEnd: 8 });
    expect(pickSuggestion('See BL-1', 8, 4, 'BL-12')).toEqual({ from: 4, to: 8, insert: 'BL-12 ', selStart: 10, selEnd: 10 });
  });
});

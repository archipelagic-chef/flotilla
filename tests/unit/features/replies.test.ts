import { describe, expect, it } from 'vitest';
import {
  entryAnchors,
  entryThreads,
  formatTicket,
  parseReply,
  parseTicket,
  replyLine,
  type TicketEntry,
} from '../../../src/features/backlog/ticket';

const entry = (date: string, author: string, body = 'Text.'): TicketEntry => ({ date, author, body });

describe('entry anchors (BL-126)', () => {
  it('are the date and author', () => {
    expect(entryAnchors([entry('2026-10-20 16:04', 'You'), entry('2026-10-20 16:10', 'Agent Nova-7')])).toEqual([
      '2026-10-20-1604-you',
      '2026-10-20-1610-agent-nova-7',
    ]);
  });

  it('tell entries of the same minute and author apart', () => {
    expect(entryAnchors([entry('2026-10-20 16:04', 'You'), entry('2026-10-20 16:04', 'Flotilla'), entry('2026-10-20 16:04', 'You')])).toEqual([
      '2026-10-20-1604-you',
      '2026-10-20-1604-flotilla',
      '2026-10-20-1604-you-2',
    ]);
  });

  it('stay when other entries and the description change', () => {
    const text = '# T\n\nOld.\n\n## Activity\n\n### 2026-10-20 16:04 · You\nA.\n\n### 2026-10-20 16:05 · You\nB.\n';
    const before = entryAnchors(parseTicket(text).activity);
    const after = entryAnchors(parseTicket(text.replace('Old.', 'New, longer.').replace('A.', 'A, edited.')).activity);
    expect(after).toEqual(before);
  });

  it('give an entry without date or author one', () => {
    expect(entryAnchors([entry('', '')])).toEqual(['entry']);
  });
});

describe('replies (BL-126)', () => {
  const comment = entry('2026-10-20 16:04', 'You', 'Why?');
  const line = replyLine(comment, '2026-10-20-1604-you');

  it('start with a line that names and links their parent', () => {
    expect(line).toBe('↩ [Reply to You, 2026-10-20 16:04](#2026-10-20-1604-you)');
    expect(parseReply(`${line}\nBecause.`)).toEqual({ to: '2026-10-20-1604-you', label: 'Reply to You, 2026-10-20 16:04', text: 'Because.' });
    expect(parseReply('Because.')).toBeUndefined();
    expect(parseReply('See ↩ [x](#y) later.')).toBeUndefined();
  });

  it('survive a round trip through the ticket file', () => {
    const t = { title: 'T', description: '', activity: [comment, entry('2026-10-20 16:10', 'Agent Nova-7', `${line}\nBecause.`)] };
    expect(parseTicket(formatTicket(t)).activity).toEqual(t.activity);
  });

  it('group one level deep, under the top-level entry', () => {
    const activity = [
      comment,
      entry('2026-10-20 16:10', 'Agent Nova-7', `${line}\nBecause.`),
      entry('2026-10-20 16:12', 'You', `${replyLine({ date: '2026-10-20 16:10', author: 'Agent Nova-7' }, '2026-10-20-1610-agent-nova-7')}\nI see.`),
      entry('2026-10-20 16:13', 'You', 'Another.'),
    ];
    const threads = entryThreads(activity);
    expect(threads.map((t) => t.root)).toEqual([undefined, 0, 0, undefined]);
    expect(threads[2].reply).toMatchObject({ to: '2026-10-20-1610-agent-nova-7', author: 'Agent Nova-7', date: '2026-10-20 16:10' });
  });

  it('to a duplicate minute go to the right entry', () => {
    const activity = [
      entry('2026-10-20 16:04', 'You', 'A.'),
      entry('2026-10-20 16:04', 'You', 'B.'),
      entry('2026-10-20 16:05', 'You', `${replyLine(comment, '2026-10-20-1604-you-2')}\nOn B.`),
    ];
    expect(entryThreads(activity)[2]).toMatchObject({ root: 1, reply: { to: '2026-10-20-1604-you-2' } });
  });

  it('to an entry that is gone stay top-level, and still say whom they answered', () => {
    const t = entryThreads([entry('2026-10-20 16:05', 'You', `${replyLine(comment, '2026-10-20-1604-you')}\nOn it.`)]);
    expect(t[0].root).toBeUndefined();
    expect(t[0].reply).toMatchObject({ to: '2026-10-20-1604-you', label: 'Reply to You, 2026-10-20 16:04', author: '' });
  });

  it('only answer earlier entries', () => {
    const t = entryThreads([
      entry('2026-10-20 16:04', 'You', `${replyLine(comment, '2026-10-20-1605-you')}\nLoop.`),
      entry('2026-10-20 16:05', 'You', 'Later.'),
    ]);
    expect(t[0].root).toBeUndefined();
  });
});

describe('the reply rule for agents (BL-126)', () => {
  it('is in the report format, with an anchor that matches', async () => {
    const { REPORT_FORMAT } = await import('../../../src/features/backlog/report');
    expect(REPORT_FORMAT).toContain('write your entry as a reply to it');
    expect(entryAnchors([entry('2026-10-20 16:04', 'You')])[0]).toBe('2026-10-20-1604-you');
  });
});

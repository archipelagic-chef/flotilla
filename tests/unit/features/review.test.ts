import { describe, expect, it } from 'vitest';
import { parseVerdict, readyReport, reviewerPrompt, saysReadyForReview, verdictReport, type ReviewState } from '../../../src/features/backlog/review';
import type { TicketEntry } from '../../../src/features/backlog/ticket';

const key = (e: TicketEntry) => `${e.date}|${e.author}`;
const entry = (date: string, author: string, body: string): TicketEntry => ({ date, author, body });

describe('review loop', () => {
  it('reads verdicts', () => {
    expect(parseVerdict('Looks fine.\n\nVerdict: approved')).toBe('approved');
    expect(parseVerdict('- [ ] fix it\n\n**Verdict:** changes requested')).toBe('changes');
    expect(parseVerdict('Verdict: approved\n…\nVerdict: Changes requested')).toBe('changes');
    expect(parseVerdict('No verdict here')).toBeUndefined();
  });

  it('notices "Ready for review" at the end of a report', () => {
    expect(saysReadyForReview('Did X.\n\nReady for review.')).toBe(true);
    expect(saysReadyForReview('Did X.\n\n**Ready for review**\n')).toBe(true);
    expect(saysReadyForReview('Ready for review once tests pass, but they fail.')).toBe(false);
  });

  it('finds the report to act on, once', () => {
    const review: ReviewState = { round: 1, state: 'revising', reviewer: 'Vega-2', handled: [] };
    const entries = [
      entry('2026-10-11 09:00', 'Agent Nova-7', 'Done.\n\nReady for review.'),
      entry('2026-10-11 09:30', 'Agent Vega-2', 'Fix the tests.\n\nVerdict: changes requested'),
      entry('2026-10-11 10:00', 'You', 'ok'),
    ];
    expect(readyReport(entries, undefined, key)).toMatchObject({ agent: 'Nova-7' });
    expect(readyReport(entries, { ...review, handled: [key(entries[0])] }, key)).toBeUndefined();
    expect(verdictReport(entries, review, key)).toMatchObject({ verdict: 'changes' });
    expect(verdictReport(entries, { ...review, handled: [key(entries[1])] }, key)).toBeUndefined();
    // The reviewer saying "Ready for review" doesn't make it ready.
    expect(readyReport([entry('2026-10-11 11:00', 'Agent Vega-2', 'Ready for review.')], review, key)).toBeUndefined();
  });

  it("names the reviewer and the item first in the reviewer's prompt", () => {
    const prompt = reviewerPrompt({ item: { id: 'BL-1', title: 'SSO' }, reviewer: 'Vega-2', implementer: 'Nova-7', ticket: '/t/BL-1.md', branch: 'feature/BL-1', base: 'main', round: 2 });
    expect(prompt.startsWith('You are agent Vega-2, working on backlog item BL-1:')).toBe(true);
    expect(prompt).toMatch(/Round 2/);
    expect(prompt).toMatch(/Verdict: changes requested/);
  });
});

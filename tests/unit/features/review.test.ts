import { describe, expect, it } from 'vitest';
import {
  answerPrompt,
  parseVerdict,
  readyReport,
  reviewerPrompt,
  type ReviewState,
  saysReadyForReview,
  saysWaitingForUser,
  userAnswer,
  userReviewBody,
  userRevisionPrompt,
  verdictReport,
} from '../../../src/features/backlog/review';
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
    expect(verdictReport([entry('2026-10-11 09:30', 'Agent Vega-2', 'Verdict: approved\n- Good.')], review, key)).toMatchObject({ verdict: 'approved' });
    // The reviewer saying "Ready for review" doesn't make it ready.
    expect(readyReport([entry('2026-10-11 11:00', 'Agent Vega-2', 'Ready for review.')], review, key)).toBeUndefined();
  });

  it("names the reviewer and the item first in the reviewer's prompt", () => {
    const prompt = reviewerPrompt({
      item: { id: 'BL-1', title: 'SSO' },
      reviewer: 'Vega-2',
      implementer: 'Nova-7',
      ticket: '/t/BL-1.md',
      branch: 'feature/BL-1',
      base: 'main',
      round: 2,
    });
    expect(prompt.startsWith('You are agent Vega-2, working on backlog item BL-1:')).toBe(true);
    expect(prompt).toMatch(/Round 2/);
    expect(prompt).toMatch(/Verdict: changes requested/);
    expect(prompt).toMatch(/Start the entry with your verdict/);
  });

  it("has the reviewer run the ticket's run block when it can headless, and say what it gave", () => {
    const args = { item: { id: 'BL-1', title: 'SSO' }, reviewer: 'Vega-2', ticket: '/t/BL-1.md', branch: 'feature/BL-1', base: 'main' };
    for (const round of [1, 2]) {
      const prompt = reviewerPrompt({ ...args, round });
      expect(prompt).toMatch(/run block is the last fenced block whose info string is `run`/);
      expect(prompt).toMatch(/a block whose kind is `launch`, `task`, `open` or `demo` is skipped/);
      expect(prompt).toMatch(/run the window-free lines and skip the rest/);
      expect(prompt).toMatch(/shell lines that need no window/);
      expect(prompt).toMatch(/`launch`, `task`, `open` or `demo`/);
      expect(prompt).toMatch(/what you ran and what it gave/);
      expect(prompt).toMatch(/git status/);
    }
    // Round 2 drops only the first paragraph, so the run instruction stays in it.
    const later = reviewerPrompt({ ...args, round: 2 })
      .split('\n\n')
      .slice(1)
      .join('\n\n');
    expect(later).toMatch(/run block/);
  });

  it('has the reviewer check a UI ticket\'s demo against its "When it\'s done" lines, in every round', () => {
    const args = { item: { id: 'BL-1', title: 'Compact cards' }, reviewer: 'Vega-2', ticket: '/t/BL-1.md', branch: 'feature/BL-1', base: 'main' };
    for (const round of [1, 2]) {
      const prompt = reviewerPrompt({ ...args, round });
      expect(prompt).toMatch(/Check what the demo shows, not only that there is one/);
      expect(prompt).toMatch(/its script .*demos\/<name>\.json/);
      expect(prompt).toMatch(/open the screenshots and frames the report shows/);
      expect(prompt).toMatch(/`npm run demo -- check <name>`/);
      expect(prompt).toMatch(/where it can't .*say so and judge from the script and the images/);
      expect(prompt).toMatch(
        /for each "When it's done" line and each acceptance criterion about what the user sees, say in your report whether the demo shows it/,
      );
      expect(prompt).toMatch(/A line the demo doesn't show .* is a change you request, naming that line/);
      expect(prompt).toMatch(/matter of taste: mention it, don't request it/);
    }
  });

  it("writes the user's review with a verdict the loop reads", () => {
    expect(userReviewBody('changes', 'Use the config file.\n')).toBe('Use the config file.\n\nVerdict: changes requested');
    expect(parseVerdict(userReviewBody('changes', 'Use the config file.'))).toBe('changes');
    expect(userReviewBody('approved', '')).toBe('Verdict: approved');
  });

  it('notices an agent waiting for the user at the end of a report', () => {
    expect(saysWaitingForUser('Should the limit be per key or per IP?\n\nWaiting for you.')).toBe(true);
    expect(saysWaitingForUser('**Waiting for your answer**')).toBe(true);
    expect(saysWaitingForUser('Waiting for you to decide, but I went ahead.\n\nReady for review.')).toBe(false);
  });

  it('notices an agent waiting for the user in its Needs line', () => {
    expect(saysWaitingForUser('Two options.\n\nNeeds from you: which store?\n\n```question\nWhich store?\n- Redis\n- Memory\n```')).toBe(true);
    expect(saysWaitingForUser('Done.\n\nNeeds from you: nothing\n\nReady for review.')).toBe(false);
  });

  it("takes the user's comments since the agent asked, once", () => {
    const entries = [
      entry('2026-10-11 09:00', 'Agent Nova-7', 'Per key or per IP?\n\nWaiting for you.'),
      entry('2026-10-11 09:05', 'You', 'Per key.'),
      entry('2026-10-11 09:06', 'Flotilla', 'Something happened.'),
      entry('2026-10-11 09:07', 'You', 'And 100 a minute.'),
    ];
    const review: ReviewState = { round: 1, state: 'asking', reviewer: '', byUser: true, handled: [key(entries[0])] };
    expect(userAnswer(entries, review, key).map((e) => e.body)).toEqual(['Per key.', 'And 100 a minute.']);
    expect(userAnswer(entries, { ...review, handled: [key(entries[0]), key(entries[1]), key(entries[3])] }, key)).toEqual([]);
    expect(userAnswer(entries.slice(0, 1), review, key)).toEqual([]);
  });

  it("gives the implementer the user's review, lets it ask first, and has it update the description", () => {
    const prompt = userRevisionPrompt({ item: { id: 'BL-1' }, ticket: '/t/BL-1.md', feedback: 'Use the config file.\nAnd test it.' });
    expect(prompt).toMatch(/> Use the config file\.\n> And test it\./);
    expect(prompt).toMatch(/"Needs from you:"/);
    expect(prompt).toMatch(/Ready for review\./);
    expect(prompt).toMatch(/description in \/t\/BL-1\.md/);
    expect(userRevisionPrompt({ item: { id: 'BL-1' }, ticket: '/t/BL-1.md', feedback: '' })).toMatch(/without saying more/);
    expect(answerPrompt({ item: { id: 'BL-1' }, ticket: '/t/BL-1.md', answer: 'Per key.' })).toMatch(/> Per key\./);
  });
});

describe('fixing a stopped review', () => {
  it('offers the fixes that fit why it stopped', async () => {
    const { fixesFor, fixLabel } = await import('../../../src/features/backlog/review');
    expect(fixesFor('busy', true)).toEqual(['inChat', 'newAgent', 'retry']);
    expect(fixesFor('no-report', true).map((f) => fixLabel(f, 'no-report'))).toEqual(['Resume It', 'New Agent']);
    expect(fixesFor('no-verdict', false).map((f) => fixLabel(f, 'no-verdict'))).toEqual(['Review Again']);
    expect(fixesFor('rounds', true)).toEqual(['anotherRound']);
    expect(fixesFor('no-worktree', false)).toEqual(['worktree']);
  });
});
describe('pausing and stopping agents', () => {
  it('offers Resume first for an agent the user stopped', async () => {
    const { fixesFor, fixLabel } = await import('../../../src/features/backlog/review');
    const worker = { phase: 'work' as const, session: 's', agent: 'Nova-7', resume: 'working' as const };
    expect(fixesFor('user', true, worker).map((f) => fixLabel(f, 'user'))).toEqual(['Resume', 'New Agent']);
    expect(fixesFor('user', false, { ...worker, phase: 'review', resume: 'reviewing' }).map((f) => fixLabel(f, 'user'))).toEqual(['Resume', 'Review Again']);
    // Stopped before agents could be resumed: as before.
    expect(fixesFor('user', false)).toEqual(['retry']);
  });

  it('knows which agent the user paused or stopped', async () => {
    const { heldBy } = await import('../../../src/features/backlog/review');
    const held = { phase: 'work' as const, session: 's', agent: 'Nova-7', resume: 'revising' as const };
    expect(heldBy({ round: 1, reviewer: 'Kai-2', state: 'paused', paused: { ...held, byUser: '2026-10-18T10:00:00Z' } })?.agent).toBe('Nova-7');
    // Paused on a usage limit: it goes on by itself, not held by the user.
    expect(heldBy({ round: 1, reviewer: 'Kai-2', state: 'paused', paused: { ...held, until: '2026-10-18T10:00:00Z', known: true } })).toBeUndefined();
    expect(heldBy({ round: 1, reviewer: 'Kai-2', state: 'stopped', stop: { kind: 'user', agent: held } })?.session).toBe('s');
    expect(heldBy({ round: 1, reviewer: 'Kai-2', state: 'stopped', stop: { kind: 'no-report' } })).toBeUndefined();
    expect(heldBy(undefined)).toBeUndefined();
  });

  it("reads from Flotilla's notes whether an agent runs in a terminal", async () => {
    const { startedInTerminal } = await import('../../../src/features/backlog/review');
    const notes = [
      entry('2026-10-18 10:00', 'Flotilla', 'Opened a chat for agent Nova-7 (opus) in worktree `feature/x`, in a terminal. It reports here.'),
      entry('2026-10-18 10:01', 'Flotilla', 'Opened a chat for agent Kai-2 in worktree `feature/x`. It reports here.'),
      entry('2026-10-18 10:02', 'Agent Kai-2', 'Plan, in a terminal.'),
    ];
    expect(startedInTerminal(notes, 'Nova-7')).toBe(true);
    expect(startedInTerminal(notes, 'Kai-2')).toBe(false);
    expect(startedInTerminal(notes, 'Nova-70')).toBe(false);
    // The latest note says where it runs now: resumed without a window.
    expect(startedInTerminal([...notes, entry('2026-10-18 11:00', 'Flotilla', 'You resumed the chat for agent Nova-7 to go on.')], 'Nova-7')).toBe(false);
  });

  it('tells a resumed agent to check its uncommitted work first', async () => {
    const { resumeAfterUserPausePrompt, takeOverPrompt } = await import('../../../src/features/backlog/review');
    expect(resumeAfterUserPausePrompt('work')).toContain('git status');
    expect(resumeAfterUserPausePrompt('review')).toContain('verdict');
    expect(takeOverPrompt({ stopped: 'Nova-7', ticket: '/b/BL-1.md' })).toMatch(/Nova-7.*\/b\/BL-1\.md.*git status/s);
  });
});

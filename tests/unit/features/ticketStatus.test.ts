import { describe, expect, it } from 'vitest';
import { askOf, pendingReport, ticketStatus, type StatusInput } from '../../../src/webview/ticketStatus';

const NOW = Date.parse('2026-10-12T22:45:00');
const base: StatusInput = { status: 'doing', agents: [], activity: [], hasWork: true, now: NOW };

describe('askOf', () => {
  it('takes the numbered options at the end as the answers, and the lines before them as the question', () => {
    const body = 'Which way should the cache go?\n\n1. In memory\n2. On disk\n\nWaiting for you.';
    expect(askOf(body)).toEqual({ question: 'Which way should the cache go?', options: ['In memory', 'On disk'] });
  });

  it('takes the question from around the options, when it comes after them', () => {
    expect(askOf('Two ways:\n\n1. Derive it\n2. Keep it\n\nWhich should I take?\n\nWaiting for you.')).toEqual({
      question: 'Two ways:\n\nWhich should I take?',
      options: ['Derive it', 'Keep it'],
    });
  });

  it('has no options when the report ends without a numbered list', () => {
    expect(askOf('Should I keep the old API?\n\nWaiting for you.')).toEqual({ question: 'Should I keep the old API?', options: [] });
  });

  it('needs two numbered lines to offer buttons', () => {
    expect(askOf('Pick one:\n1. Only one\n\nWaiting for you.')).toEqual({ question: 'Pick one:\n1. Only one', options: [] });
  });

  it('accepts ")" after the number', () => {
    expect(askOf('Choose\n1) A\n2) B').options).toEqual(['A', 'B']);
  });
});

describe('pendingReport', () => {
  it('is the last agent report when it ends with "Waiting for you."', () => {
    const report = { date: '2026-10-12 22:00', author: 'Agent Nova-5', body: 'Question?\n\nWaiting for you.' };
    expect(pendingReport([report])).toBe(report);
  });

  it('is gone once the user wrote after it', () => {
    const activity = [
      { date: '2026-10-12 22:00', author: 'Agent Nova-5', body: 'Question?\n\nWaiting for you.' },
      { date: '2026-10-12 22:10', author: 'You', body: 'Keep it.' },
    ];
    expect(pendingReport(activity)).toBeUndefined();
  });

  it('ignores Flotilla notes written after it', () => {
    const activity = [
      { date: '2026-10-12 22:00', author: 'Agent Nova-5', body: 'Question?\n\nWaiting for you.' },
      { date: '2026-10-12 22:01', author: 'Flotilla', body: 'Autopilot: opened a chat.' },
    ];
    expect(pendingReport(activity)?.author).toBe('Agent Nova-5');
  });
});

describe('ticketStatus', () => {
  it('says what an agent asks, with its options', () => {
    const status = ticketStatus({
      ...base,
      activity: [{ date: '2026-10-12 22:00', author: 'Agent Nova-5', body: 'Which?\n1. A\n2. B\n\nWaiting for you.' }],
    });
    expect(status).toMatchObject({
      tone: 'waiting',
      title: 'Waiting for your answer: Nova-5',
      ask: { question: 'Which?', options: ['A', 'B'] },
    });
  });

  it('shows the prompt of an agent waiting in its chat', () => {
    const status = ticketStatus({ ...base, agents: [{ agent: 'Zinc-2', state: 'waiting-for-input', started: new Date(NOW).toISOString(), message: 'Claude needs permission to run tests' }] });
    expect(status).toEqual({ tone: 'waiting', title: 'Waiting for your answer: Zinc-2', detail: 'Claude needs permission to run tests' });
  });

  it('says that the review is waiting for the user', () => {
    expect(ticketStatus({ ...base, review: { state: 'yours', running: false } }).title).toBe('Ready for your review');
  });

  it('says how long an agent has been working', () => {
    const started = new Date(NOW - 12 * 60_000).toISOString();
    expect(ticketStatus({ ...base, agents: [{ agent: 'Zinc-2', state: 'working', started }] }).title).toBe('An agent is working: Zinc-2, 12 min');
  });

  it('says what is done, not started, or idle', () => {
    expect(ticketStatus({ ...base, status: 'done' }).title).toBe('Done');
    expect(ticketStatus({ ...base, status: 'todo', hasWork: false }).title).toBe('Not started');
    expect(ticketStatus({ ...base, status: 'doing' }).title).toBe('Nothing is running');
  });

  it('is not waiting once the user answered', () => {
    const status = ticketStatus({
      ...base,
      activity: [
        { date: '2026-10-12 22:00', author: 'Agent Nova-5', body: 'Which?\n1. A\n2. B\n\nWaiting for you.' },
        { date: '2026-10-12 22:05', author: 'You', body: 'A' },
      ],
    });
    expect(status.tone).not.toBe('waiting');
  });
});

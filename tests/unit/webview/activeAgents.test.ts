import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  activeAgents,
  lastReport,
  runningFor,
} from '../../../src/webview/activeAgents';
import type { TicketView } from '../../../src/webview/ticketProtocol';

type Agent = TicketView['agents'][number];
type Entry = TicketView['activity'][number];

function agent(over: Partial<Agent>): Agent {
  return {
    key: '/wt/a',
    id: 'chat-1',
    agent: 'Vega-8',
    title: 'Work on BL-1',
    state: 'working',
    branch: 'feature/BL-1',
    started: '2026-10-19T06:00:00Z',
    updated: '2026-10-19T06:10:00Z',
    reports: 0,
    ...over,
  };
}

const chat = agent({});

function entry(over: Partial<Entry>): Entry {
  return { date: '2026-10-19 06:05', author: 'Agent Vega-8', body: '', html: '', ...over };
}

describe('activeAgents', () => {
  it('keeps the busy agents and those the user paused, not the ended or stopped ones', () => {
    const list = [
      agent({ id: 'busy', runs: 'headless' }),
      agent({ id: 'waiting', state: 'waiting-for-input', runs: 'panel' }),
      agent({ id: 'paused', state: 'ended', held: 'paused' }),
      agent({ id: 'stopped', state: 'ended', held: 'stopped' }),
      agent({ id: 'ended', state: 'ended' }),
    ];
    expect(activeAgents(list).map((a) => a.id)).toEqual(['busy', 'waiting', 'paused']);
  });

  it('is empty with no agent on the ticket', () => {
    expect(activeAgents([agent({ state: 'done' })])).toEqual([]);
  });
});

describe('lastReport', () => {
  it("finds the agent's latest report and shows its summary", () => {
    const report = { summary: '<p>Second</p>', details: '', asks: false, questions: [] };
    const activity = [
      entry({ chat, html: '<p>First</p>' }),
      entry({ author: 'Flotilla', chat, html: '<p>Opened a chat</p>', date: '2026-10-19 06:06' }),
      entry({ chat, report, date: '2026-10-19 06:07' }),
      entry({ author: 'Agent Nova-7', chat: agent({ id: 'other' }), html: '<p>Not this one</p>', date: '2026-10-19 06:08' }),
    ];
    expect(lastReport(activity, 'chat-1')).toEqual({ html: '<p>Second</p>', date: '2026-10-19 06:07' });
  });

  it('is undefined before the agent reports', () => {
    expect(lastReport([entry({ author: 'Flotilla', chat })], 'chat-1')).toBeUndefined();
  });
});

describe('runningFor', () => {
  const start = '2026-10-19T06:00:00Z';
  const at = (minutes: number) => new Date(start).getTime() + minutes * 60_000;
  it('says how long, in minutes, hours and days', () => {
    expect(runningFor(start, at(0))).toBe('under a minute');
    expect(runningFor(start, at(12))).toBe('12 min');
    expect(runningFor(start, at(60))).toBe('1 h');
    expect(runningFor(start, at(65))).toBe('1 h 5 min');
    expect(runningFor(start, at(2 * 1440 + 180))).toBe('2 d 3 h');
  });
});

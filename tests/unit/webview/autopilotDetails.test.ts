import { describe, expect, it } from 'vitest';
import { autopilotDetails } from '../../../src/webview/autopilotDetails';
import type { AutopilotState } from '../../../src/webview/protocol';

const now = new Date('2026-10-21T20:00:00');
const base: AutopilotState = { enabled: true, running: 0, max: 2, waiting: 0, elsewhere: false };
const titles = new Map([
  ['BL-1', 'Sort the backlog'],
  ['BL-2', 'Fix the login'],
  ['BL-3', 'Split the files'],
]);
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();

describe('the autopilot details', () => {
  it('lists the agents working, with their tickets, what they do and for how long', () => {
    const d = autopilotDetails(
      {
        ...base,
        running: 3,
        agents: [
          { id: 'BL-1', agent: 'Nova-7', doing: 'work', since: minutesAgo(14) },
          { id: 'BL-2', agent: 'Vega-2', doing: 'review', since: minutesAgo(75) },
          { id: 'BL-3', doing: 'starting' },
        ],
      },
      titles,
      now,
    );
    expect(d.agents).toEqual([
      { id: 'BL-1', title: 'Sort the backlog', text: 'Agent Nova-7 · working · 14 min' },
      { id: 'BL-2', title: 'Fix the login', text: 'Agent Vega-2 · reviewing · 1 h 15 min' },
      { id: 'BL-3', title: 'Split the files', text: 'starting' },
    ]);
    expect(d).toMatchObject({ running: 3, max: 2, tryNow: false, waiting: [] });
    expect(d.idle).toBeUndefined();
  });

  it('lists the starts waiting in order, and why: the limit, or memory', () => {
    const d = autopilotDetails(
      {
        ...base,
        running: 2,
        waiting: 2,
        queue: [
          { id: 'BL-2', reason: 'slot', kind: 'review', since: minutesAgo(3) },
          { id: 'BL-9', reason: 'memory', kind: 'new' },
        ],
      },
      titles,
      now,
    );
    expect(d.waiting).toEqual([
      { id: 'BL-2', title: 'Fix the login', text: 'a review · waits for a free agent (the limit, 2) · 3 min' },
      { id: 'BL-9', text: 'a new ticket · waits for free memory' },
    ]);
  });

  it("says when they wait for Claude's usage limit, and offers Try Now", () => {
    const until = '2026-10-21T20:22:00';
    const d = autopilotDetails(
      { ...base, waitingUntil: until, idle: 'nothing left in To Do', queue: [{ id: 'BL-1', reason: 'slot', kind: 'resume' }] },
      titles,
      now,
    );
    expect(d.waiting[0].text).toMatch(/^resuming · waits for Claude's usage limit \(until .*22.*\)$/);
    expect(d.tryNow).toBe(true);
    // The limit says why, not the idle reason.
    expect(d.idle).toBeUndefined();
    // Try Now is the leading window's.
    expect(autopilotDetails({ ...base, waitingUntil: until, elsewhere: true }, titles, now).tryNow).toBe(false);
  });

  it("says why it's idle", () => {
    const d = autopilotDetails({ ...base, idle: 'BL-130 waits for BL-126 (in review)' }, titles, now);
    expect(d).toMatchObject({ agents: [], waiting: [], idle: 'BL-130 waits for BL-126 (in review)', tryNow: false });
  });

  it('adds what each agent is doing (BL-175), or why it looks stuck', () => {
    const tool = { id: 't', name: 'Bash', detail: 'npm test', since: new Date(now.getTime() - 130_000).toISOString() };
    const todos = [
      { text: 'a', status: 'completed' as const },
      { text: 'b', status: 'in_progress' as const },
    ];
    const live = new Map([
      ['BL-1', [{ name: 'Nova-7', state: 'working' as const, activity: { tool, todos } }]],
      ['BL-2', [{ name: 'Vega-2', state: 'working' as const, activity: { tool }, stuck: 'No activity for 14 min' }]],
    ]);
    const d = autopilotDetails(
      {
        ...base,
        running: 2,
        agents: [
          { id: 'BL-1', agent: 'Nova-7', doing: 'work' },
          { id: 'BL-2', agent: 'Vega-2', doing: 'review' },
        ],
      },
      titles,
      now,
      live,
    );
    expect(d.agents.map((a) => [a.status, a.stuck])).toEqual([
      ['Running `npm test` · 2:10 · 1 of 2', undefined],
      ['Looks stuck: No activity for 14 min', true],
    ]);
  });
});

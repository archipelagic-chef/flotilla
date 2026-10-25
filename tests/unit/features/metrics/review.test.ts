import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  extensions: { getExtension: () => undefined },
}));

import type { EventData, EventKind, FlotillaEvent } from '../../../../src/features/metrics/events';
import {
  checkFix,
  fixesMarkdown,
  landedAt,
  readImproves,
} from '../../../../src/features/metrics/improves';
import {
  reviewBlocked,
  reviewDue,
  reviewPrompt,
  reviewTools,
} from '../../../../src/features/metrics/review';
import { metricsSummary, summaryMarkdown, trend } from '../../../../src/features/metrics/summary';
import { headlessArgs } from '../../../../src/ui/backlog/agentRunner';

function ev<K extends EventKind>(at: string, kind: K, data: EventData[K], ticket?: string): FlotillaEvent<K> {
  return { at: new Date(at).toISOString(), kind, ...(ticket ? { ticket } : {}), data };
}

const region = (additions: boolean) => ({ start: 1, lines: 3, additions }) as never;

const EVENTS: FlotillaEvent[] = [
  // The week before: 2 merges, both conflicted (3 regions, 1 additions-only).
  ev('2026-10-03T10:00Z', 'ticket-moved', { from: 'todo', to: 'doing', by: 'Autopilot' }, 'BL-1'),
  ev('2026-10-04T10:00Z', 'merge-conflicted', { files: [{ file: 'a.ts', regions: [region(true), region(false)] } as never] }, 'BL-1'),
  ev('2026-10-04T11:00Z', 'merge-landed', { into: 'main', commit: 'c1' }, 'BL-1'),
  ev('2026-10-04T11:00Z', 'ticket-moved', { from: 'review', to: 'done', by: 'Flotilla' }, 'BL-1'),
  ev('2026-10-05T10:00Z', 'merge-conflicted', { files: [{ file: 'b.ts', regions: [region(false)] } as never] }, 'BL-2'),
  ev('2026-10-05T11:00Z', 'merge-landed', { into: 'main', commit: 'c2' }, 'BL-2'),
  // BL-9, the fix, lands on the 7th.
  ev('2026-10-07T12:00Z', 'merge-landed', { into: 'main', commit: 'c9' }, 'BL-9'),
  // This week: 4 merges, one conflicted; an agent's run; a verdict each way.
  ev('2026-10-09T09:00Z', 'ticket-moved', { from: 'todo', to: 'doing', by: 'Autopilot' }, 'BL-3'),
  ev('2026-10-09T10:00Z', 'merge-landed', { into: 'main', commit: 'c3' }, 'BL-3'),
  ev('2026-10-09T15:00Z', 'ticket-moved', { from: 'review', to: 'done', by: 'Flotilla' }, 'BL-3'),
  ev('2026-10-10T10:00Z', 'merge-conflicted', { files: [{ file: 'c.ts', regions: [region(true)] } as never] }, 'BL-4'),
  ev('2026-10-10T11:00Z', 'merge-landed', { into: 'main', commit: 'c4' }, 'BL-4'),
  ev('2026-10-11T10:00Z', 'merge-landed', { into: 'main', commit: 'c5' }, 'BL-5'),
  ev('2026-10-12T10:00Z', 'merge-landed', { into: 'main', commit: 'c6' }, 'BL-6'),
  ev('2026-10-12T12:00Z', 'agent-ended', { role: 'work', session: 's', code: 0, ok: true, minutes: 90, costUsd: 3 }, 'BL-3'),
  ev('2026-10-12T13:00Z', 'review-verdict', { verdict: 'changes', round: 1, by: 'X' }, 'BL-3'),
  ev('2026-10-12T14:00Z', 'review-verdict', { verdict: 'approved', round: 2, by: 'X' }, 'BL-3'),
];

const NOW = new Date('2026-10-15T00:00Z');

describe('metricsSummary (BL-159)', () => {
  const s = metricsSummary(EVENTS, { to: NOW, days: 7 });
  const m = (id: string) => s.metrics.find((x) => x.id === id)!;

  it('counts each metric this period and the one before', () => {
    expect(s.from).toBe('2026-10-08T00:00:00.000Z');
    expect(s.events).toBe(10);
    expect(m('merges')).toMatchObject({ value: 4, previous: 3 });
    expect(m('conflicts-per-merge')).toMatchObject({ value: 0.25, previous: 2 / 3 });
    expect(m('additions-only-share')).toMatchObject({ value: 1, previous: 1 / 3 });
    expect(m('tickets-done')).toMatchObject({ value: 1, previous: 1 });
    expect(m('lead-time-hours')).toMatchObject({ value: 6, previous: 25 });
    expect(m('changes-per-verdict').value).toBe(0.5);
    expect(m('agent-hours').value).toBe(1.5);
    expect(m('cost-per-ticket').value).toBe(3);
  });

  it("counts in the cost per ticket only the tickets whose agents' runs were recorded (BL-178)", () => {
    const readIn = { ...ev('2026-10-10T12:00Z', 'ticket-moved', { from: 'review', to: 'done', by: 'Flotilla' }, 'BL-4'), imported: true as const };
    const t = metricsSummary([...EVENTS, readIn], { to: NOW, days: 7 });
    expect(t.metrics.find((x) => x.id === 'tickets-done')!.value).toBe(2);
    expect(t.metrics.find((x) => x.id === 'cost-per-ticket')!.value).toBe(3);
  });

  it('leaves out what it has no numbers for, rather than a zero', () => {
    expect(m('cost-usd').previous).toBeUndefined();
    expect(m('test-wait-median-s').value).toBeUndefined();
  });

  it('says which way each went, by which way is better', () => {
    expect(trend(m('conflicts-per-merge'))).toBe('better');
    expect(trend(m('additions-only-share'))).toBe('worse');
    expect(trend(m('tickets-done'))).toBe('same');
    expect(trend(m('cost-usd'))).toBeUndefined();
  });

  it('is a table with the ids a proposal names', () => {
    const md = summaryMarkdown(s);
    expect(md).toContain('Period 2026-10-08 to 2026-10-15 (10 events)');
    expect(md).toMatch(/\| Merges that conflicted, per merge landed \(`conflicts-per-merge`, lower is better\) \| 0.25 \| 0.67 \| ↑ better \|/);
    expect(md).toContain('| $3.00 |');
  });
});

describe('Improves: lines (BL-159)', () => {
  it('reads the metric and the target, however the line is written', () => {
    const d = [
      "**When it's done:** fewer conflicts.",
      '',
      'Improves: conflicts-per-merge from 0.67 to 0.3',
      '- **Improves:** `lead-time-hours` 25 → 12',
      'Improves: agent-runs',
      'It improves nothing else: not a line.',
    ].join('\n');
    expect(readImproves(d)).toEqual([
      { metric: 'conflicts-per-merge', target: 0.3, text: 'conflicts-per-merge from 0.67 to 0.3' },
      { metric: 'lead-time-hours', target: 12, text: '`lead-time-hours` 25 → 12' },
      { metric: 'agent-runs', text: 'agent-runs' },
    ]);
  });

  it('finds when a ticket landed', () => {
    expect(landedAt(EVENTS, 'BL-9')?.toISOString()).toBe('2026-10-07T12:00:00.000Z');
    expect(landedAt(EVENTS, 'BL-404')).toBeUndefined();
  });

  it('checks a merged fix before and after', () => {
    const improves = readImproves('Improves: conflicts-per-merge from 0.67 to 0.3')[0];
    const c = checkFix(EVENTS, { ticket: 'BL-9', title: 'Fewer conflicts', improves, now: NOW, days: 7 });
    // Before: 2 conflicted of 2 landed (BL-9's own landing is after). After: 1 of 5 (BL-9's own included).
    expect(c).toMatchObject({ verdict: 'helped', before: 1, after: 0.2, reached: true });
    expect(fixesMarkdown([c])).toContain('| BL-9: Fewer conflicts | conflicts-per-merge from 0.67 to 0.3 | 2026-10-07 | 1 | 0.2 | helped, target reached |');
  });

  it('is too early to tell right after landing, and unknown for a metric that is no metric', () => {
    const improves = { metric: 'conflicts-per-merge', text: '' };
    expect(checkFix(EVENTS, { ticket: 'BL-9', title: '', improves, now: new Date('2026-10-08T00:00Z') }).verdict).toBe('early');
    expect(checkFix(EVENTS, { ticket: 'BL-9', title: '', improves: { metric: 'happiness', text: '' }, now: NOW }).verdict).toBe('unknown');
    expect(fixesMarkdown([])).toMatch(/No merged ticket/);
  });
});

describe('the review itself (BL-159)', () => {
  it('is due a week after the last one, and never with 0', () => {
    expect(reviewDue({ every: 7, now: NOW })).toBe(true);
    expect(reviewDue({ last: '2026-10-10', every: 7, now: new Date('2026-10-16T09:00') })).toBe(false);
    expect(reviewDue({ last: '2026-10-08', every: 7, now: new Date('2026-10-15T09:00') })).toBe(true);
    expect(reviewDue({ every: 0, now: NOW })).toBe(false);
  });

  it('waits while the autopilot is busy, on a limit, or paused', () => {
    const idle = { running: 0, waiting: 0, enabled: true, idle: 'nothing left in To Do', elsewhere: false };
    expect(reviewBlocked(idle)).toBeUndefined();
    expect(reviewBlocked({ ...idle, enabled: false, idle: undefined })).toBeUndefined();
    expect(reviewBlocked({ ...idle, running: 2 })).toMatch(/2 agents are working/);
    expect(reviewBlocked({ ...idle, waiting: 1 })).toMatch(/waiting/);
    expect(reviewBlocked({ ...idle, waitingUntil: '2026-10-15T03:00Z' })).toMatch(/usage limit/);
    expect(reviewBlocked({ ...idle, pausedAll: 3 })).toMatch(/paused/);
    expect(reviewBlocked({ ...idle, idle: undefined })).toMatch(/tickets to start/);
  });

  it('may only read, and write its page and its proposals', () => {
    const t = reviewTools({ reviewFile: '/b/reviews/2026-10-15.md', inboxDir: '/b/inbox' });
    expect(t).toEqual({ tools: ['Read', 'Grep', 'Glob', 'Edit(//b/reviews/2026-10-15.md)', 'Edit(//b/inbox/review-*.md)'], offer: ['Write'] });
    // Write is offered, but allowed only by the Edit rules: not by its name.
    const args = headlessArgs({ prompt: 'p', name: 'n', sessionId: 's', mode: 'dontAsk', ...t });
    expect(args.slice(args.indexOf('--tools'))).toEqual(['--tools', 'Read,Grep,Glob,Edit,Write', '--allowedTools', ...t.tools]);
  });

  it('gives the summary, the fixes and the open tickets, and the shape of a proposal', () => {
    const p = reviewPrompt({
      agent: 'Nova-7',
      day: '2026-10-15',
      summary: 'SUMMARY',
      fixes: 'FIXES',
      openTickets: ['BL-3 (todo): Something'],
      reviewFile: '/b/reviews/2026-10-15.md',
      inboxDir: '/b/inbox',
      eventsDir: '/g/flotilla/metrics',
      mainRoot: '/r',
      backlogDir: '/b',
    });
    // Not "working on backlog item": Flotilla mustn't take its chat for a ticket's.
    expect(p).toMatch(/^You are agent Nova-7, writing Flotilla's improvement review of 2026-10-15\./);
    for (const s of [
      'SUMMARY',
      'FIXES',
      'BL-3 (todo): Something',
      '/b/reviews/2026-10-15.md',
      '/b/inbox/review-2026-10-15-<n>.md',
      '/g/flotilla/metrics',
      "**When it's done:**",
      'Improves: <metric id>',
    ])
      expect(p).toContain(s);
  });
});

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

import type {
  EventData,
  EventKind,
  FlotillaEvent,
} from '../../../../src/features/metrics/events';
import {
  checkFix,
  fixesMarkdown,
  landedAt,
  readImproves,
} from '../../../../src/features/metrics/improves';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  moveReviews,
  reviewContext,
  reviewTaskFile,
  reviewTitle,
  writeReviewTask,
} from '../../../../src/features/metrics/review';
import {
  listTaskReports,
  parseTask,
  taskPrompt,
} from '../../../../src/features/schedules/schedule';
import {
  metricsSummary,
  summaryMarkdown,
  trend,
} from '../../../../src/features/metrics/summary';

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
  ev(
    '2026-10-12T12:00Z',
    'agent-spend',
    {
      session: 's',
      purpose: 'first',
      to: '2026-10-12T12:00Z',
      tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
      costUsd: 3,
      contextK: [40],
      tools: {},
    },
    'BL-3',
  ),
  ev('2026-10-12T13:00Z', 'review-verdict', { verdict: 'changes', round: 1, by: 'X' }, 'BL-3'),
  ev('2026-10-12T14:00Z', 'review-verdict', { verdict: 'approved', round: 2, by: 'X' }, 'BL-3'),
];

const NOW = new Date('2026-10-15T00:00Z');

describe('metricsSummary (BL-159)', () => {
  const s = metricsSummary(EVENTS, { to: NOW, days: 7 });
  const m = (id: string) => s.metrics.find((x) => x.id === id)!;

  it('counts each metric this period and the one before', () => {
    expect(s.from).toBe('2026-10-08T00:00:00.000Z');
    expect(s.events).toBe(11);
    expect(m('merges')).toMatchObject({ value: 4, previous: 3 });
    expect(m('conflicts-per-merge')).toMatchObject({ value: 0.25, previous: 2 / 3 });
    expect(m('additions-only-share')).toMatchObject({ value: 1, previous: 0 });
    // The tickets that landed, merged or moved to Done, as the Metrics view counts them (BL-265).
    expect(m('tickets-done')).toMatchObject({ value: 4, previous: 3 });
    expect(m('lead-time-hours')).toMatchObject({ value: 6, previous: 25 });
    expect(m('changes-per-verdict').value).toBe(0.5);
    expect(m('agent-hours').value).toBe(1.5);
    expect(m('cost-per-ticket').value).toBe(3);
  });

  it("counts in the cost per ticket only the tickets whose agents' spend was recorded (BL-178)", () => {
    const readIn = { ...ev('2026-10-10T12:00Z', 'ticket-moved', { from: 'review', to: 'done', by: 'Flotilla' }, 'BL-7'), imported: true as const };
    const t = metricsSummary([...EVENTS, readIn], { to: NOW, days: 7 });
    expect(t.metrics.find((x) => x.id === 'tickets-done')!.value).toBe(5);
    expect(t.metrics.find((x) => x.id === 'cost-per-ticket')!.value).toBe(3);
  });

  it('leaves out what it has no numbers for, rather than a zero', () => {
    expect(m('cost-usd').previous).toBeUndefined();
    expect(m('test-wait-median-s').value).toBeUndefined();
  });

  it('says which way each went, by which way is better', () => {
    expect(trend(m('conflicts-per-merge'))).toBe('better');
    expect(trend(m('additions-only-share'))).toBe('worse');
    expect(trend(m('tickets-done'))).toBe('better');
    expect(trend(m('cost-usd'))).toBeUndefined();
  });

  it('is a table with the ids a proposal names', () => {
    const md = summaryMarkdown(s);
    expect(md).toContain('Period 2026-10-08 to 2026-10-15 (11 events)');
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

describe('the review itself (BL-159), a scheduled task (BL-263)', () => {
  it('is titled by its first heading (BL-177)', () => {
    expect(reviewTitle('intro\n# Improvement review 2026-10-24: merges\n## One', '2026-10-24')).toBe('Improvement review 2026-10-24: merges');
    expect(reviewTitle('no heading', '2026-10-24')).toBe('Improvement review 2026-10-24');
  });

  it("its file runs it every reviewEvery days when idle, with the metrics' context; paused when that's 0", () => {
    const week = parseTask('improvement-review', reviewTaskFile(7));
    expect(week).toMatchObject({ title: 'Improvement review', schedule: { kind: 'days', days: 7 }, when: 'idle', context: 'metrics' });
    expect(week).not.toHaveProperty('paused');
    expect(parseTask('improvement-review', reviewTaskFile(1))).toMatchObject({ schedule: { kind: 'days', days: 1 } });
    expect(parseTask('improvement-review', reviewTaskFile(0))).toMatchObject({ schedule: { kind: 'days', days: 1 }, paused: true });
  });

  it('gives the summary, the fixes, the open tickets and the events, and asks for its sections and Improves: lines', () => {
    const task = parseTask('improvement-review', reviewTaskFile(7));
    if ('error' in task) throw new Error(task.error);
    const p = taskPrompt({
      agent: 'Nova-7',
      task,
      day: '2026-10-15',
      reportFile: '/b/schedules/improvement-review/2026-10-15.md',
      earlier: ['/b/schedules/improvement-review/2026-10-08.md'],
      inboxDir: '/b/inbox',
      mainRoot: '/r',
      backlogDir: '/b',
      context: reviewContext({ summary: 'SUMMARY', fixes: 'FIXES', openTickets: ['BL-3 (todo): Something'], eventsDir: '/g/flotilla/metrics' }),
    });
    // Not "working on backlog item": Flotilla mustn't take its chat for a ticket's.
    expect(p).toMatch(/^You are agent Nova-7, running Flotilla's scheduled task "improvement-review"/);
    for (const s of [
      'SUMMARY',
      'FIXES',
      'BL-3 (todo): Something',
      '/b/schedules/improvement-review/2026-10-15.md',
      '/b/schedules/improvement-review/2026-10-08.md',
      '/b/inbox/improvement-review-2026-10-15-<n>.md',
      '/g/flotilla/metrics',
      '# Improvement review 2026-10-15',
      '## Fixes checked',
      '## Problems',
      "**When it's done:**",
      'Improves: <metric id>',
    ])
      expect(p).toContain(s);
    expect(p.indexOf('## Your instructions')).toBeLessThan(p.indexOf('SUMMARY'));
  });

  it("moves the reviews of reviews/ into the task's folder, keeping one whose day is there already", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
    fs.mkdirSync(path.join(dir, 'reviews'));
    fs.writeFileSync(path.join(dir, 'reviews', '2026-10-24.md'), '# A\n');
    fs.writeFileSync(path.join(dir, 'reviews', '2026-10-30.md'), '# B\n');
    fs.mkdirSync(path.join(dir, 'schedules', 'improvement-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'schedules', 'improvement-review', '2026-10-30.md'), '# B, already\n');
    expect(await moveReviews(dir)).toEqual(['2026-10-24']);
    expect(await listTaskReports(dir, 'improvement-review')).toEqual(['2026-10-30', '2026-10-24']);
    expect(fs.readFileSync(path.join(dir, 'reviews', '2026-10-30.md'), 'utf8')).toBe('# B\n');
    fs.rmSync(path.join(dir, 'schedules', 'improvement-review', '2026-10-30.md'));
    expect(await moveReviews(dir)).toEqual(['2026-10-30']);
    expect(fs.existsSync(path.join(dir, 'reviews'))).toBe(false);
    expect(await moveReviews(dir)).toEqual([]);
  });

  it("writes the task's file once: an edited one is kept", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
    expect(await writeReviewTask(dir, 14)).toBe(true);
    const file = path.join(dir, 'schedules', 'improvement-review.md');
    expect(fs.readFileSync(file, 'utf8')).toContain('every: 14 days');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('14 days', 'Mondays at 06:00'));
    expect(await writeReviewTask(dir, 7)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toContain('every: Mondays at 06:00');
  });
});

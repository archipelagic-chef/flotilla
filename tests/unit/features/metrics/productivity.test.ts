import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { computeMetrics, EventIndex } from '../../../../src/features/metrics/compute';
import {
  type EventData,
  type EventKind,
  type FlotillaEvent,
  readEvents,
} from '../../../../src/features/metrics/events';
import { criteriaCount, laneTimes } from '../../../../src/features/metrics/productivity';
import { IDLE_MS, projectDirs, scanSpend } from '../../../../src/features/metrics/spendScan';
import { metricsSummary } from '../../../../src/features/metrics/summary';
import { line } from './transcriptSpend.test';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const H = 3_600_000;
const D = 24 * H;

function ev<K extends EventKind>(t: number, kind: K, data: EventData[K], ticket?: string): FlotillaEvent<K> {
  return { at: new Date(t).toISOString(), kind, ...(ticket ? { ticket } : {}), data };
}

const tokens = (k: number) => ({ input: 0, output: 0, cacheRead: k * 1000, cacheCreation: 0 });
const spend = (t: number, purpose: EventData['agent-spend']['purpose'], usd: number, ticket?: string, contextK = [50]): FlotillaEvent<'agent-spend'> =>
  ev(
    t,
    'agent-spend',
    {
      session: `s-${ticket ?? 'own'}`,
      purpose,
      to: new Date(t + H).toISOString(),
      tokens: tokens(sum(contextK)),
      costUsd: usd,
      contextK,
      tools: { code: 4000, git: 400 },
    },
    ticket,
  );
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** This week: BL-1 (4 criteria, recorded) and BL-2 (2, from its description) are done; a chat of the user's isn't a ticket's. */
const LOG: FlotillaEvent[] = [
  ev(NOW - 3 * D, 'ticket-moved', { from: 'todo', to: 'doing', by: 'Autopilot' }, 'BL-1'),
  spend(NOW - 3 * D, 'first', 3, 'BL-1', [40, 60]),
  ev(NOW - 3 * D + 2 * H, 'ticket-moved', { from: 'doing', to: 'review', by: 'Flotilla' }, 'BL-1'),
  spend(NOW - 3 * D + 2 * H, 'review', 1, 'BL-1', [80]),
  ev(NOW - 2 * D, 'ticket-moved', { from: 'review', to: 'done', by: 'Flotilla', criteria: 4 }, 'BL-1'),
  ev(NOW - 2 * D, 'ticket-moved', { from: 'todo', to: 'doing', by: 'Autopilot' }, 'BL-2'),
  spend(NOW - 2 * D, 'first', 1.5, 'BL-2'),
  spend(NOW - 2 * D + H, 'main', 0.5, 'BL-2'),
  ev(NOW - D, 'ticket-moved', { from: 'doing', to: 'done', by: 'You' }, 'BL-2'),
  spend(NOW - D, 'orchestration', 2, undefined, [200]),
  // The week before: one criterion for $2.
  spend(NOW - 10 * D, 'first', 2, 'BL-0'),
  ev(NOW - 9 * D, 'ticket-moved', { from: 'doing', to: 'done', by: 'You', criteria: 1 }, 'BL-0'),
];

describe('criteriaCount', () => {
  it("counts a description's checklist lines, done or not", () => {
    expect(criteriaCount('**When it is done:** x\n\nAcceptance criteria:\n- [ ] one\n- [x] two\n  - [X] nested\n* [ ] star\n- not one\n')).toBe(4);
  });
});

describe('laneTimes', () => {
  it('adds up the time in each lane from the moves', () => {
    const index = new EventIndex();
    index.add(LOG);
    expect(laneTimes(index.ticketEvents('BL-1'), NOW - 2 * D)).toEqual({ doing: 2 * H, review: D - 2 * H });
  });
});

describe('the Productivity section', () => {
  const index = new EventIndex();
  index.add(LOG);
  const view = computeMetrics(index, 'week', NOW, { criteria: new Map([['BL-2', 2]]) });
  const section = view.sections[0];
  const n = (id: string) => section.numbers.find((x) => x.id === id)!;

  it('leads the view, with criteria per $ and per million tokens, against the week before', () => {
    expect(section.id).toBe('productivity');
    // 6 criteria for $8 of spend (and 480k tokens); the week before, 1 for $2.
    expect(n('criteriaPerUsd')).toMatchObject({ value: 0.75, previous: 0.5 });
    expect(n('criteriaPerMTok').value).toBe(12.5);
    expect(n('costPerTicket').value).toBe(3);
    expect(n('outsideTickets').value).toBe(25);
    expect(n('turnsPerTicket').value).toBe(3); // (3 + 2) / 2, rounded
    expect(n('contextP50').value).toBe(60_000); // of 40, 50, 50, 60, 80 and 200k: the upper median
    expect(n('contextP90').value).toBe(200_000);
  });

  it('shows where the spend went, the tickets with their cost per criterion and lanes, and the tool output', () => {
    const chart = (id: string) => section.charts.find((c) => c.id === id)!;
    const purposes = Object.fromEntries(chart('spendByPurpose').bars.map((b) => [b.label, b.values[0]]));
    expect(purposes).toMatchObject({ 'First pass': 4.5, Review: 1, 'Main and conflicts': 0.5, 'Chats not tied to a ticket': 2 });
    const bl1 = chart('ticketsDone').bars.find((b) => b.label === 'BL-1')!;
    expect(bl1.values).toEqual([4]);
    expect(bl1.rows[0].detail).toBe('4 criteria · $1.00 per criterion · 3 turns · In Progress 2h · In Review 22h');
    expect(chart('toolOutput').bars.map((b) => b.values[0])).toEqual([5000, 500, 0, 0, 0]);
    expect(chart('criteriaPerUsdPerWeek').bars.at(-1)!.values).toEqual([0.75]);
  });

  it("is in the improvement review's summary first", () => {
    const s = metricsSummary(LOG, { to: new Date(NOW), days: 7, criteria: new Map([['BL-2', 2]]) });
    expect(s.metrics[0]).toMatchObject({ id: 'criteria-per-usd', value: 0.75, previous: 0.5 });
    expect(s.metrics.find((m) => m.id === 'spend-outside-tickets')?.value).toBe(0.25);
  });
});

describe('scanSpend', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bl189-'));
    dirs.push(root);
    const home = path.join(root, 'claude');
    const commonDir = path.join(root, 'git');
    const project = (name: string) => {
      const d = path.join(home, 'projects', name);
      fs.mkdirSync(d, { recursive: true });
      return d;
    };
    return { home, commonDir, project, tmp: '/tmp' };
  }

  it("reads the repository's chats (its own, its worktrees', its merges'), not other folders", async () => {
    const s = setup();
    for (const n of ['-w-repo', '-w-repo--worktrees-feature-BL-7-x', '-tmp-flotilla-merge-repo-BL-8-ab12', '-w-repo--playground', '-w-other']) s.project(n);
    const found = await projectDirs(s.home, '/w/repo', '/tmp');
    expect(found.map((f) => [path.basename(f.dir), f.ticket])).toEqual([
      ['-tmp-flotilla-merge-repo-BL-8-ab12', 'BL-8'],
      ['-w-repo', undefined],
      ['-w-repo--worktrees-feature-BL-7-x', 'BL-7'],
    ]);
  });

  it('records each part once: the history marked imported, then what came since', async () => {
    const s = setup();
    const file = path.join(s.project('-w-repo--worktrees-feature-BL-7-x'), 's1.jsonl');
    const first = [line.prompt(0, 'You are agent Pixel-6, working on backlog item BL-7: "x".'), line.reply(1, 'm1'), line.cost(1)];
    fs.writeFileSync(file, `${first.join('\n')}\n`);
    const scan = (now = Date.now()) => scanSpend({ commonDir: s.commonDir, mainRoot: '/w/repo', home: s.home, tmp: s.tmp, now });
    expect(await scan()).toBe(1);
    expect(await scan()).toBe(0);
    // The run goes on: its reply waits for its cost record, then it's counted.
    fs.appendFileSync(file, `${line.prompt(5, "Claude's usage limit stopped you before you finished; it has reset.")}\n${line.reply(6, 'm2')}\n`);
    expect(await scan()).toBe(0);
    fs.appendFileSync(file, `${line.cost(1.5)}\n`);
    expect(await scan()).toBe(1);
    const events = (await readEvents(s.commonDir)) as FlotillaEvent<'agent-spend'>[];
    expect(events.map((e) => [e.kind, e.ticket, e.agent, e.data.purpose, e.data.costUsd, e.imported])).toEqual([
      ['agent-spend', 'BL-7', 'Pixel-6', 'first', 1, true],
      ['agent-spend', 'BL-7', 'Pixel-6', 'resume', 0.5, undefined],
    ]);
    // A chat that ended without a record is counted once it's idle.
    fs.appendFileSync(file, `${line.reply(8, 'm3')}\n`);
    expect(await scan()).toBe(0);
    expect(await scan(Date.now() + IDLE_MS + 60_000)).toBe(1);
    expect(await scan(Date.now() + IDLE_MS + 60_000)).toBe(0);
  });
});

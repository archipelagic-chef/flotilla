import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendEvents,
  eventsFile,
  eventsWritten,
  readEvents,
  recordEvent,
  setEventLog,
  type EventData,
  type EventKind,
  type FlotillaEvent,
} from '../../../../src/features/metrics/events';
import { failedTests, recordClickWait } from '../../../../src/features/metrics/record';
import { addTotals, firstKeptMonth, monthTotals, rollUpOldEvents } from '../../../../src/features/metrics/rollup';
import { makeTempDir } from '../../../helpers/gitRepo';

const run = promisify(execFile);

/** A sample of each kind: a kind added to EventData without one here doesn't compile. */
const SAMPLES: { [K in EventKind]: EventData[K] } = {
  'ticket-moved': { from: 'todo', to: 'doing', by: 'Autopilot' },
  'agent-started': { role: 'work', model: 'opus', session: 's1' },
  'agent-resumed': { role: 'review', session: 's1' },
  'agent-paused': { role: 'work', session: 's1', reason: 'limit', until: '2026-10-21T23:00:00.000Z' },
  'agent-spend': { session: 's1', purpose: 'review', to: '2026-10-21T22:10:00.000Z', tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 }, costUsd: 0.5, contextK: [60, 62], tools: { code: 1200 } },
  'agent-ended': { role: 'merge', session: 's1', code: 0, ok: true, minutes: 3.5, tokens: { input: 10, output: 20, cacheRead: 30, cacheCreation: 40 }, costUsd: 0.12 },
  'review-verdict': { verdict: 'changes', round: 2, by: 'Ember-6' },
  'merge-started': { into: 'main', branch: 'feature/x' },
  'merge-conflicted': { files: [{ file: 'a.ts', regions: [{ lines: 4, additions: true }] }] },
  'merge-checks-failed': { failure: 'timeout', tests: ['tests/unit/a.test.ts'] },
  'merge-resolved': { minutes: 7, by: 'Wren-2' },
  'merge-approved': { by: 'You' },
  'merge-landed': { into: 'main', commit: 'abc1234' },
  'merge-cancelled': { reason: 'by you' },
  'merge-ci-stopped': { reason: 'failed', branch: 'feature/BL-1-x', jobs: ['test'] },
  'branch-conflicts': { branch: 'feature/x', files: ['a.ts'] },
  'limit-hit': { limit: 'usage', until: '2026-10-21T23:00:00.000Z', known: true },
  'limit-lifted': { minutes: 60, tries: 2 },
  'autopilot-idle': { reason: 'nothing left in To Do' },
  'click-waited': { button: 'merge', ms: 2400 },
  'review-state': { from: 'working', to: 'asking' },
  'test-run': { ms: 90_000, waitMs: 30_000, full: true, ok: true, slots: 1 },
  'demo-recorded': { name: 'open-agent-chat', frames: 120, ms: 8000, medianGapMs: 40, p90GapMs: 80 },
};

afterEach(() => setEventLog(undefined));

describe('recording events', () => {
  it('writes each kind as one JSON line, with its time, ticket, agent and data', async () => {
    const dir = makeTempDir();
    setEventLog(dir);
    for (const [kind, data] of Object.entries(SAMPLES)) recordEvent(kind as EventKind, { ticket: 'BL-1', agent: 'Nova-7', data: data as never });
    await eventsWritten();
    const events = await readEvents(dir);
    expect(events.map((e) => e.kind)).toEqual(Object.keys(SAMPLES));
    for (const e of events) {
      expect(e).toMatchObject({ ticket: 'BL-1', agent: 'Nova-7', data: SAMPLES[e.kind] });
      expect(Date.parse(e.at)).not.toBeNaN();
    }
    const file = eventsFile(dir, new Date());
    expect(file).toMatch(/flotilla[/\\]metrics[/\\]events-\d{4}-\d{2}\.jsonl$/);
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(Object.keys(SAMPLES).length);
  });

  it('records nothing before it knows where', async () => {
    expect(() => recordEvent('autopilot-idle', { data: { reason: 'x' } })).not.toThrow();
    await eventsWritten();
  });

  it("never throws: a write that fails is logged once and dropped", async () => {
    const dir = makeTempDir();
    // A file where the folder should be: every write fails.
    fs.writeFileSync(path.join(dir, 'flotilla'), '');
    const logged: string[] = [];
    setEventLog(dir, (l) => logged.push(l));
    expect(() => {
      recordEvent('autopilot-idle', { data: { reason: 'a' } });
      recordEvent('autopilot-idle', { data: { reason: 'b' } });
    }).not.toThrow();
    await eventsWritten();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/couldn't record an event/);
  });

  it('puts each event in the file of its month', async () => {
    const dir = makeTempDir();
    await appendEvents(dir, [
      { at: '2026-09-30T23:59:00.000Z', kind: 'merge-approved', data: { by: 'You' } },
      { at: '2026-10-01T00:00:00.000Z', kind: 'merge-approved', data: { by: 'You' } },
    ]);
    expect(fs.readdirSync(path.join(dir, 'flotilla', 'metrics')).sort()).toEqual(['events-2026-09.jsonl', 'events-2026-10.jsonl']);
  });

  it('skips a line cut short (a crash mid-write) and reads the rest', async () => {
    const dir = makeTempDir();
    await appendEvents(dir, [{ at: '2026-10-01T00:00:00.000Z', kind: 'merge-approved', data: { by: 'You' } }]);
    fs.appendFileSync(eventsFile(dir, new Date('2026-10-01')), '{"at":"2026-10-01T00:01');
    await appendEvents(dir, [{ at: '2026-10-01T00:02:00.000Z', kind: 'merge-approved', data: { by: 'You' } }]);
    expect((await readEvents(dir)).map((e) => e.at)).toEqual(['2026-10-01T00:00:00.000Z', '2026-10-01T00:02:00.000Z']);
  });

  it("loses no events when windows and scripts append at once", async () => {
    const dir = makeTempDir();
    setEventLog(dir);
    const script = path.resolve('scripts/record-event.mjs');
    const child = (n: number) =>
      run(process.execPath, [
        '--input-type=module',
        '-e',
        `const { recordEvent } = await import(${JSON.stringify(`file://${script.replace(/\\/g, '/')}`)}); for (let i = 0; i < 200; i++) recordEvent(${JSON.stringify(dir)}, 'click-waited', { data: { button: 'p${n}', ms: i } });`,
      ]);
    const children = [child(1), child(2)];
    for (let i = 0; i < 200; i++) recordEvent('click-waited', { data: { button: 'window', ms: i } });
    await Promise.all([...children, eventsWritten()]);
    const events = await readEvents(dir);
    expect(events).toHaveLength(600);
    for (const who of ['window', 'p1', 'p2']) {
      expect(events.filter((e) => (e as FlotillaEvent<'click-waited'>).data.button === who).map((e) => (e as FlotillaEvent<'click-waited'>).data.ms).sort((a, b) => a - b)).toEqual(
        [...Array(200).keys()],
      );
    }
  });
});

describe('what the events are made of', () => {
  it('records a click only when its button waited', async () => {
    const dir = makeTempDir();
    setEventLog(dir);
    recordClickWait('approve', 1000, 'BL-1', 1500);
    recordClickWait('merge', 1000, 'BL-1', 3400);
    await eventsWritten();
    expect((await readEvents(dir)).map((e) => e.data)).toEqual([{ button: 'merge', ms: 2400 }]);
  });

  it("names the tests vitest says failed", () => {
    const output = ['\x1b[31m FAIL \x1b[39m tests/unit/a.test.ts > merges > keeps both', ' FAIL  tests/unit/b.test.ts', ' ✓ tests/unit/c.test.ts'].join('\n');
    expect(failedTests(output)).toEqual(['tests/unit/a.test.ts > merges > keeps both', 'tests/unit/b.test.ts']);
  });
});

describe('keeping 12 months', () => {
  it('keeps the last 12 months whole', () => {
    expect(firstKeptMonth(new Date('2026-10-21T12:00:00Z'))).toBe('2025-11');
    expect(firstKeptMonth(new Date('2026-01-05T12:00:00Z'))).toBe('2025-02');
  });

  it('rolls older months up into their totals and removes their events', async () => {
    const dir = makeTempDir();
    const ended = (at: string, minutes: number): FlotillaEvent => ({ at, kind: 'agent-ended', data: { ...SAMPLES['agent-ended'], minutes } });
    await appendEvents(dir, [
      ended('2025-09-10T00:00:00.000Z', 2),
      ended('2025-09-11T00:00:00.000Z', 3),
      { at: '2025-09-12T00:00:00.000Z', kind: 'merge-conflicted', data: { files: [{ file: 'a', regions: [{ lines: 3, additions: true }, { lines: 5, additions: false }] }] } },
      ended('2026-10-01T00:00:00.000Z', 1),
    ]);
    expect(await rollUpOldEvents(dir, new Date('2026-10-21T00:00:00Z'))).toEqual(['2025-09']);
    const metrics = path.join(dir, 'flotilla', 'metrics');
    expect(fs.readdirSync(metrics).sort()).toEqual(['events-2026-10.jsonl', 'totals-2025-09.json']);
    const totals = JSON.parse(fs.readFileSync(path.join(metrics, 'totals-2025-09.json'), 'utf8'));
    expect(totals).toEqual({
      month: '2025-09',
      counts: { 'agent-ended': 2, 'merge-conflicted': 1 },
      agents: { merge: { runs: 2, minutes: 5, costUsd: 0.24, tokens: 200 } },
      conflicts: { merges: 1, regions: 2, additions: 1 },
    });
    // Events written later to a month rolled up are added to its totals.
    await appendEvents(dir, [ended('2025-09-20T00:00:00.000Z', 4)]);
    await rollUpOldEvents(dir, new Date('2026-10-21T00:00:00Z'));
    const again = JSON.parse(fs.readFileSync(path.join(metrics, 'totals-2025-09.json'), 'utf8'));
    expect(again.counts['agent-ended']).toBe(3);
    expect(again.agents.merge.minutes).toBe(9);
  });

  it('adds totals kind by kind', () => {
    const a = monthTotals('2025-01', [{ at: '2025-01-01T00:00:00Z', kind: 'merge-approved', data: { by: 'You' } }]);
    expect(addTotals(a, a).counts).toEqual({ 'merge-approved': 2 });
    expect(addTotals(a, undefined)).toBe(a);
  });
});

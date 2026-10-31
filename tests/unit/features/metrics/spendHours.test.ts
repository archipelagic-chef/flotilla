import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  eventsDir,
  readEvents,
} from '../../../../src/features/metrics/events';
import {
  readLiveSpend,
  scanSpend,
  STATE_FILE,
} from '../../../../src/features/metrics/spendScan';
import { spendTimeline } from '../../../../src/features/metrics/spendTimeline';
import type { FlotillaEvent } from '../../../../src/features/metrics/events';
import {
  hourOf,
  transcriptSpend,
} from '../../../../src/features/metrics/transcriptSpend';
import {
  buckets,
  MOST_CHATS,
  topChats,
} from '../../../../src/webview/metrics/spendBuckets';
import type { SpendTimeline } from '../../../../src/webview/metricsProtocol';
import { line } from './transcriptSpend.test';

// The transcripts' times: minutes after 2026-10-24 10:00Z.
const FIRST = 'You are agent Tango-1, working on backlog item BL-201: "Something".\n\nIts ticket is …';
const REVIEW = 'You are agent Ziggy-8, working on backlog item BL-201: "Something". You are its reviewer.';
const zone = process.env.TZ;
const inZone = (tz: string) => {
  process.env.TZ = tz;
};

describe('a chat spend by the hour (BL-202)', () => {
  beforeEach(() => inZone('UTC'));
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it('puts each turn of a part that spans hours in its own hour, with its share of the cost', () => {
    const spend = transcriptSpend(
      [line.prompt(0, FIRST), line.reply(20, 'm1'), line.reply(50, 'm2', { read: 100_000 }), line.reply(70, 'm3'), line.reply(185, 'm4'), line.cost(4)].join(
        '\n',
      ),
    );
    expect(spend.parts).toHaveLength(1);
    const [part] = spend.parts;
    expect(part.hours.map((h) => [h.at, h.turns])).toEqual([
      ['2026-10-24T10:00:00.000Z', 2],
      ['2026-10-24T11:00:00.000Z', 1],
      ['2026-10-24T13:00:00.000Z', 1],
    ]);
    expect(part.hours[0].tokens.cacheRead).toBe(150_000);
    // The cost record is shared by price: the hours add up to the part.
    expect(part.hours.reduce((n, h) => n + h.costUsd, 0)).toBeCloseTo(4, 9);
    expect(part.hours[0].costUsd).toBeGreaterThan(part.hours[1].costUsd);
    for (const k of ['input', 'output', 'cacheRead', 'cacheCreation'] as const) expect(part.hours.reduce((n, h) => n + h.tokens[k], 0)).toBe(part.tokens[k]);
  });

  it('splits the hours at the local hour, in a zone half an hour off UTC', () => {
    inZone('Asia/Kolkata');
    // 10:20Z is 15:50 there, 10:40Z is 16:10.
    expect(hourOf('2026-10-24T10:20:00Z')).toBe('2026-10-24T09:30:00.000Z');
    const spend = transcriptSpend([line.prompt(0, FIRST), line.reply(20, 'm1'), line.reply(40, 'm2'), line.cost(1)].join('\n'));
    expect(spend.parts[0].hours.map((h) => h.at)).toEqual(['2026-10-24T09:30:00.000Z', '2026-10-24T10:30:00.000Z']);
  });

  it("keeps a running chat's turns after its last cost record as live, priced from the table", () => {
    const spend = transcriptSpend([line.prompt(0, FIRST), line.reply(5, 'm1'), line.cost(1), line.reply(65, 'm2')].join('\n'));
    expect(spend.parts).toHaveLength(1);
    expect(spend.open).toBe(true);
    expect(spend.live?.[0].hours).toEqual([expect.objectContaining({ at: '2026-10-24T11:00:00.000Z', turns: 1 })]);
    expect(spend.live?.[0].hours[0].costUsd).toBeGreaterThan(0);
  });

  it('reads the hours only up to `until`: what the scans had counted before the hours were kept', () => {
    const text = [line.prompt(0, FIRST), line.reply(5, 'm1'), line.cost(1), line.reply(65, 'm2'), line.cost(2)].join('\n');
    const spend = transcriptSpend(text, { until: '2026-10-24T10:05:00.000Z', settled: true });
    expect(spend.parts.flatMap((p) => p.hours.map((h) => [h.at, h.turns, h.costUsd]))).toEqual([['2026-10-24T10:00:00.000Z', 1, 1]]);
  });

  it('names the chat by its title, and its folder', () => {
    const title = JSON.stringify({ type: 'ai-title', sessionId: 's1', aiTitle: 'Which process used my tokens' });
    const cwd = JSON.stringify({ type: 'user', cwd: '/w/repo', sessionId: 's1', timestamp: '2026-10-24T10:00:00Z', message: { content: 'hi' } });
    const spend = transcriptSpend([cwd, title, line.reply(1, 'm1'), line.cost(1)].join('\n'));
    expect(spend).toMatchObject({ title: 'Which process used my tokens', cwd: '/w/repo' });
  });
});

const hour = (at: string, input: number, costUsd = 1, turns = 1) => ({ at, tokens: { input, output: 0, cacheRead: 0, cacheCreation: 0 }, costUsd, turns });
const spendEvent = (
  session: string,
  o: { agent?: string; ticket?: string; purpose?: string; title?: string; hours: ReturnType<typeof hour>[] },
): FlotillaEvent =>
  ({
    at: o.hours[0].at,
    kind: 'agent-spend',
    ...(o.agent ? { agent: o.agent } : {}),
    ...(o.ticket ? { ticket: o.ticket } : {}),
    data: {
      session,
      purpose: o.purpose ?? 'first',
      to: o.hours[0].at,
      tokens: o.hours[0].tokens,
      costUsd: 1,
      contextK: [],
      tools: {},
      hours: o.hours,
      ...(o.title ? { title: o.title } : {}),
    },
  }) as FlotillaEvent;

describe('the spend timeline (BL-202)', () => {
  const now = Date.parse('2026-10-25T21:30:00Z');

  it('stacks the hours by chat: agents by name and ticket, reviewers so named, the user by title, and running chats live', () => {
    const t = spendTimeline(
      [
        spendEvent('a', { agent: 'Tango-1', ticket: 'BL-201', hours: [hour('2026-10-25T20:00:00.000Z', 10), hour('2026-10-25T21:00:00.000Z', 5)] }),
        spendEvent('r', { agent: 'Ziggy-8', ticket: 'BL-201', purpose: 'review', hours: [hour('2026-10-25T21:00:00.000Z', 3)] }),
        spendEvent('u', { title: 'Which process used my tokens', purpose: 'orchestration', hours: [hour('2026-10-25T21:00:00.000Z', 2)] }),
        // Older than the 7 days: not in it.
        spendEvent('old', { agent: 'Old-1', ticket: 'BL-1', hours: [hour('2026-10-10T21:00:00.000Z', 2)] }),
        { ...spendEvent('h', { agent: 'Tango-1', ticket: 'BL-201', hours: [hour('2026-10-25T19:00:00.000Z', 7)] }), kind: 'spend-hours' } as FlotillaEvent,
      ],
      now,
      [{ session: 'a', agent: 'Tango-1', ticket: 'BL-201', parts: [{ purpose: 'first', hours: [hour('2026-10-25T21:00:00.000Z', 1)] }] }],
    );
    expect(t.chats.map((c) => c.label)).toEqual(['Tango-1 · BL-201', 'reviewer Ziggy-8 · BL-201', 'Which process used my tokens', 'Tango-1 · BL-201']);
    expect(t.chats[0]).toMatchObject({ agent: true, running: true, ticket: 'BL-201' });
    expect(t.chats[2].agent).toBeUndefined();
    expect(t.hours.map((h) => h.at)).toEqual(['2026-10-25T19:00:00.000Z', '2026-10-25T20:00:00.000Z', '2026-10-25T21:00:00.000Z']);
    const last = t.hours[2].cells;
    expect(last.find((c) => c.chat === 0)).toMatchObject({ input: 6, turns: 2, costUsd: 2, purposes: ['First pass'] });
  });
});

describe("the Spend over time chart's columns (BL-202)", () => {
  const cell = (chat: number, input: number) => ({
    chat,
    input,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: input / 10,
    turns: 1,
    purposes: ['First pass'],
  });
  beforeEach(() => inZone('UTC'));
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it('puts the hours in the window, by hour or by day, in local time', () => {
    const timeline: SpendTimeline = {
      chats: [{ id: 'a', label: 'A' }],
      hours: [
        { at: '2026-10-25T15:00:00.000Z', cells: [cell(0, 4)] },
        { at: '2026-10-25T21:00:00.000Z', cells: [cell(0, 1)] },
        { at: '2026-10-21T08:00:00.000Z', cells: [cell(0, 2)] },
      ],
    };
    const now = Date.parse('2026-10-25T21:30:00Z');
    const six = buckets(timeline, '6h', now);
    expect(six.map((b) => b.label)).toEqual(['16:00', '17:00', '18:00', '19:00', '20:00', '21:00']);
    expect(six[5].cells.get(0)?.input).toBe(1);
    expect(buckets(timeline, '24h', now).reduce((n, b) => n + (b.cells.get(0)?.input ?? 0), 0)).toBe(5);
    const week = buckets(timeline, '7d', now);
    expect(week).toHaveLength(7);
    expect(week[6].cells.get(0)?.input).toBe(5);
    expect(week[2].cells.get(0)?.input).toBe(2);
  });

  it('groups the smallest chats as Others when there are more than 8', () => {
    const many = Array.from({ length: 12 }, (_, i) => cell(i, 100 - i));
    const [b] = buckets(
      { chats: many.map((_, i) => ({ id: `c${i}`, label: `C${i}` })), hours: [{ at: '2026-10-25T21:00:00.000Z', cells: many }] },
      '6h',
      Date.parse('2026-10-25T21:30:00Z'),
    ).slice(-1);
    const { shown, others } = topChats([b], (c) => c.input);
    expect(shown).toEqual(Array.from({ length: MOST_CHATS }, (_, i) => i));
    expect([...others]).toEqual([8, 9, 10, 11]);
    expect(topChats([b], (c) => (c.chat < 9 ? c.input : 0)).others.size).toBe(0);
  });
});

describe('scanSpend keeps the hours (BL-202)', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("reads in once the hours of what was scanned before, records the new parts' hours, and keeps a running chat's live", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bl202-'));
    roots.push(root);
    const home = path.join(root, 'claude');
    const commonDir = path.join(root, 'git');
    const dir = path.join(home, 'projects', '-w-repo--worktrees-feature-BL-201-x');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 's1.jsonl');
    fs.writeFileSync(file, `${[line.prompt(0, FIRST), line.reply(5, 'm1'), line.reply(70, 'm2'), line.cost(2)].join('\n')}\n`);
    const scan = () => scanSpend({ commonDir, mainRoot: '/w/repo', home, tmp: '/tmp' });
    await scan();
    // As a scan before BL-202 left it: its parts without hours.
    const stateFile = path.join(eventsDir(commonDir), STATE_FILE);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    delete state.hours;
    fs.writeFileSync(stateFile, JSON.stringify(state));
    for (const f of fs.readdirSync(eventsDir(commonDir)).filter((n) => n.startsWith('events-'))) fs.rmSync(path.join(eventsDir(commonDir), f));
    fs.appendFileSync(file, `${[line.reply(130, 'm3'), line.cost(3), line.reply(190, 'm4')].join('\n')}\n`);
    await scan();
    await scan();
    const events = await readEvents(commonDir);
    expect(events.map((e) => [e.kind, (e.data as { hours?: unknown[] }).hours?.length, e.imported])).toEqual([
      ['spend-hours', 2, true],
      ['agent-spend', 1, undefined],
    ]);
    const live = await readLiveSpend(commonDir);
    expect(live).toEqual([
      expect.objectContaining({
        session: 's1',
        agent: 'Tango-1',
        ticket: 'BL-201',
        parts: [{ purpose: 'first', hours: [expect.objectContaining({ turns: 1 })] }],
      }),
    ]);
  });
});

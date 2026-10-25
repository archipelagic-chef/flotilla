import { describe, expect, it } from 'vitest';
import { priceOf, promptPurpose, toolKind, transcriptSpend } from '../../../../src/features/metrics/transcriptSpend';

const T = Date.parse('2026-10-24T10:00:00Z');
const at = (min: number) => new Date(T + min * 60_000).toISOString();

/** A transcript's lines: prompts, replies (with usage and maybe a tool call), tool results and cost records. */
export const line = {
  prompt: (min: number, text: string) => JSON.stringify({ type: 'user', sessionId: 's1', timestamp: at(min), message: { role: 'user', content: text } }),
  reply: (min: number, id: string, o: { read?: number; output?: number; tool?: { id: string; name: string; command?: string }; model?: string } = {}) =>
    JSON.stringify({
      type: 'assistant',
      sessionId: 's1',
      timestamp: at(min),
      message: {
        id,
        model: o.model ?? 'claude-opus-5-5',
        content: o.tool ? [{ type: 'tool_use', id: o.tool.id, name: o.tool.name, input: o.tool.command ? { command: o.tool.command } : { file_path: 'a.ts' } }] : [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: o.output ?? 1000, cache_read_input_tokens: o.read ?? 50_000, cache_creation_input_tokens: 0 },
      },
    }),
  result: (min: number, toolId: string, size: number) =>
    JSON.stringify({ type: 'user', sessionId: 's1', timestamp: at(min), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'x'.repeat(size) }] } }),
  cost: (total: number, startMin = 0) => JSON.stringify({ type: 'cost-state', sessionId: 's1', totalCostUSD: total, startTime: T + startMin * 60_000 }),
};

const FIRST = 'You are agent Pixel-6, working on backlog item BL-9: "Something".\n\nIts ticket is …';
const REVIEW_CHANGES = 'Orbit-1, an agent reviewing BL-9, requested changes (review round 1). Read its review at the end of the ticket …';
const LIMIT = "Claude's usage limit stopped you before you finished; it has reset. Go on where you left off.";
const MAIN = 'main moved on, and merging it into your branch feature/BL-9-x conflicts in src/a.ts. The user asked …';

/** An agent's chat: its first pass (two turns), the user typing to it, a limit's resume, rework and main. */
const AGENT_CHAT = [
  line.prompt(0, FIRST),
  line.reply(1, 'm1', { tool: { id: 't1', name: 'Read' } }),
  line.result(1, 't1', 4000),
  line.reply(2, 'm1'), // The same reply's second line: counted once.
  line.reply(3, 'm2', { tool: { id: 't2', name: 'Bash', command: 'cd /w && npx vitest run tests/a.test.ts' } }),
  line.result(3, 't2', 800),
  line.cost(3),
  line.prompt(10, 'Why did you do it that way?'),
  line.reply(11, 'm3'),
  line.prompt(20, LIMIT),
  line.reply(21, 'm4', { tool: { id: 't3', name: 'Bash', command: 'git status' } }),
  line.result(21, 't3', 200),
  line.prompt(30, REVIEW_CHANGES),
  line.reply(31, 'm5'),
  line.prompt(40, MAIN),
  line.reply(41, 'm6'),
  line.cost(6),
].join('\n');

describe('promptPurpose', () => {
  it("tells Flotilla's prompts apart, with their ticket and agent", () => {
    expect(promptPurpose(FIRST)).toEqual({ purpose: 'first', ticket: 'BL-9', agent: 'Pixel-6' });
    expect(promptPurpose('You are agent Orbit-1, working on backlog item BL-9: "Something". You are its reviewer.')?.purpose).toBe('review');
    expect(promptPurpose(REVIEW_CHANGES)?.purpose).toBe('rework');
    expect(promptPurpose('The user reviewed your work on BL-9 and requested changes:')?.purpose).toBe('rework');
    expect(promptPurpose('The user answered you in the ticket /x/BL-9.md:')?.purpose).toBe('answer');
    expect(promptPurpose(MAIN)?.purpose).toBe('main');
    expect(promptPurpose("Your task: resolve the conflicts of merging BL-9's branch feature/x into main.")).toMatchObject({ purpose: 'main', ticket: 'BL-9' });
    expect(promptPurpose(LIMIT)?.purpose).toBe('resume');
    expect(promptPurpose('Flotilla paused you to make room for another ticket; a slot is free now.')?.purpose).toBe('resume');
    expect(promptPurpose('You are agent Iris-2, working on backlog item BL-9, discussing it with its owner: "x".')?.purpose).toBe('shaping');
    expect(promptPurpose("You are agent Gauge-3, writing Flotilla's improvement review of 2026-10-24.")?.purpose).toBe('orchestration');
    expect(promptPurpose('Please look at the backlog and add tickets')).toBeUndefined();
  });
});

describe('toolKind', () => {
  it('reads what a tool did from its name and command', () => {
    expect(toolKind('Grep', {})).toBe('code');
    expect(toolKind('Bash', { command: 'cd /w && sed -n 1,20p src/a.ts' })).toBe('code');
    expect(toolKind('Bash', { command: 'git diff --stat' })).toBe('git');
    expect(toolKind('Bash', { command: 'npm test 2>&1 | tail' })).toBe('tests');
    expect(toolKind('Bash', { command: 'npm run demo -- record x' })).toBe('demos');
    expect(toolKind('Edit', {})).toBe('other');
  });
});

describe('transcriptSpend', () => {
  it("splits an agent's chat by the prompts that started each part, and shares the cost records among them", () => {
    const s = transcriptSpend(AGENT_CHAT);
    expect(s).toMatchObject({ session: 's1', ticket: 'BL-9', agent: 'Pixel-6', last: at(41) });
    expect(s.open).toBeUndefined();
    expect(s.parts.map((p) => p.purpose)).toEqual(['first', 'answer', 'resume', 'rework', 'main']);
    const first = s.parts[0];
    expect(first.contextK).toEqual([50, 50]);
    expect(first.tokens).toEqual({ input: 20, output: 2000, cacheRead: 100_000, cacheCreation: 0 });
    expect(first.costUsd).toBeCloseTo(3);
    expect(first.tools).toEqual({ code: 4000, tests: 800 });
    // The second record's $3 is shared by the four replies after the first, all the same price.
    for (const p of s.parts.slice(1)) expect(p.costUsd).toBeCloseTo(0.75);
    expect(s.parts[2].tools).toEqual({ git: 200 });
  });

  it('counts only what comes after the last read, and what waits for a cost record only once it is settled', () => {
    const lines = AGENT_CHAT.split('\n');
    const running = lines.slice(0, -1).join('\n');
    const now = transcriptSpend(running);
    expect(now.parts.map((p) => p.purpose)).toEqual(['first']);
    expect(now).toMatchObject({ last: at(3), open: true });
    const later = transcriptSpend(AGENT_CHAT, { after: now.last });
    expect(later.parts.map((p) => p.purpose)).toEqual(['answer', 'resume', 'rework', 'main']);
    expect(later.parts.reduce((n, p) => n + p.costUsd, 0)).toBeCloseTo(3);
    // Ended without a record (or idle): priced from the table.
    const idle = transcriptSpend(running, { after: now.last, settled: true });
    expect(idle.parts.every((p) => p.priced)).toBe(true);
    expect(idle.parts[0].costUsd).toBeCloseTo(priceOf('claude-opus-5-5', { tokens: { input: 10, output: 1000, cacheRead: 50_000, cacheCreation: 0 }, write1h: 0 }));
  });

  it("is orchestration when no Flotilla prompt started the chat, and skips a resumed chat's copies", () => {
    const own = [
      line.reply(-30, 'old1'), // copied from the chat it resumed, before it started
      line.prompt(1, 'Please add tickets for the flaky tests'),
      line.reply(2, 'n1'),
      line.prompt(3, FIRST.replace('Pixel-6', 'Echo-1')), // pasted into the user's chat: still Flotilla's prompt
      line.reply(4, 'n2'),
      line.cost(2, 0),
    ].join('\n');
    const s = transcriptSpend(own);
    expect(s.parts.map((p) => [p.purpose, p.contextK.length])).toEqual([
      ['orchestration', 1],
      ['first', 1],
    ]);
    expect(s.parts.reduce((n, p) => n + p.costUsd, 0)).toBeCloseTo(2);
    // A message another transcript counted isn't counted again.
    const seen = new Set(['n1']);
    expect(transcriptSpend(own, { seen }).parts.map((p) => p.purpose)).toEqual(['first']);
    expect(seen.has('n2')).toBe(true);
  });
});

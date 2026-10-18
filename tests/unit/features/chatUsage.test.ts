import { describe, expect, it } from 'vitest';
import { parseTranscript } from '../../../src/features/chats/chats';
import { addUsage, formatTokens } from '../../../src/features/chats/usage';
import { NO_USAGE, runawayReason } from '../../../src/features/backlog/runaway';

const reply = (id: string, read: number, written: number, content: unknown[] = []) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-17T10:00:00Z',
    message: { id, model: 'claude-opus-5-5', content, usage: { input_tokens: 2, cache_read_input_tokens: read, cache_creation_input_tokens: written, output_tokens: 10 } },
  });
const bash = (id: string, command: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command } });
const result = (id: string, error: boolean) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error }] } });
const usageOf = (lines: string[]) => parseTranscript('s', lines.join('\n'), new Date()).usage;

describe('a chat\'s token use', () => {
  it('adds up its replies once each (a reply spans several lines), its context the last one\'s', () => {
    const u = usageOf([
      JSON.stringify({ type: 'user', timestamp: '2026-10-17T10:00:00Z', message: { content: 'Hi' } }),
      reply('m1', 20_000, 5_000),
      reply('m1', 20_000, 5_000),
      reply('m2', 25_000, 1_000),
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { id: 'x', usage: { cache_read_input_tokens: 999_999 } } }),
    ]);
    expect(u).toEqual({ turns: 2, context: 26_002, reRead: 45_000, written: 6_000, output: 20, failStreak: 0, failRuns: 0 });
  });

  it('counts the same command failing in a row; an edit, or its success, ends the run', () => {
    const lines = [
      reply('a', 1, 1, [bash('t1', 'npm test')]),
      result('t1', true),
      reply('b', 1, 1, [bash('t2', 'git status')]),
      result('t2', false),
      reply('c', 1, 1, [bash('t3', 'npm test')]),
      result('t3', true),
      reply('d', 1, 1, [bash('t4', 'npm test')]),
      result('t4', true),
    ];
    expect(usageOf(lines)?.failStreak).toBe(3);
    expect(usageOf([...lines, reply('e', 1, 1, [{ type: 'tool_use', id: 'e1', name: 'Edit', input: {} }])])?.failStreak).toBe(0);
    expect(usageOf([...lines, reply('e', 1, 1, [bash('t5', 'npm test')]), result('t5', false)])?.failStreak).toBe(0);
    expect(usageOf([...lines, reply('e', 1, 1, [bash('t5', 'npm run build')]), result('t5', true)])?.failStreak).toBe(1);
    // Runs of failures: npm test's, then a new one after its success, or another command's.
    expect(usageOf(lines)?.failRuns).toBe(1);
    const again = [reply('e', 1, 1, [bash('t5', 'npm test')]), result('t5', false), reply('f', 1, 1, [bash('t6', 'npm test')]), result('t6', true)];
    expect(usageOf([...lines, ...again])?.failRuns).toBe(2);
    expect(usageOf([...lines, reply('e', 1, 1, [bash('t5', 'npm run build')]), result('t5', true)])?.failRuns).toBe(2);
  });

  it('counts PowerShell commands as well, and each of several run at once', () => {
    const ps = (id: string, command: string) => ({ type: 'tool_use', id, name: 'PowerShell', input: { command } });
    const both = (a: string, b: string) =>
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: a, is_error: true }, { type: 'tool_result', tool_use_id: b, is_error: true }] } });
    expect(usageOf([reply('a', 1, 1, [ps('p1', 'npm test')]), result('p1', true), reply('b', 1, 1, [ps('p2', 'npm test')]), result('p2', true)])?.failStreak).toBe(2);
    // Two calls of one reply, both failing: both count.
    expect(usageOf([reply('a', 1, 1, [ps('p1', 'npm test'), bash('b1', 'npm test')]), both('p1', 'b1')])?.failStreak).toBe(2);
  });

  it('adds up several chats, and formats tokens short', () => {
    expect(addUsage([undefined, { ...NO_USAGE, turns: 2, context: 10, reRead: 5 }, { ...NO_USAGE, turns: 1, context: 30, reRead: 7 }])).toMatchObject({ turns: 3, context: 30, reRead: 12 });
    expect(addUsage([undefined])).toBeUndefined();
    expect([formatTokens(950), formatTokens(12_400), formatTokens(3_440_000)]).toEqual(['950', '12k', '3.4M']);
  });
});

describe('runaway agents', () => {
  it('stops one repeating a failing command, counted from when it started', () => {
    expect(runawayReason({ ...NO_USAGE, failStreak: 5, failRuns: 1 }, NO_USAGE, 0)).toMatch(/failed 5 times in a row/);
    expect(runawayReason({ ...NO_USAGE, failStreak: 4, failRuns: 1 }, NO_USAGE, 0)).toBeUndefined();
    // Resumed after being stopped for it: 5 more of the same run.
    const stopped = { ...NO_USAGE, failStreak: 5, failRuns: 1 };
    expect(runawayReason({ ...NO_USAGE, failStreak: 9, failRuns: 1 }, stopped, 0)).toBeUndefined();
    expect(runawayReason({ ...NO_USAGE, failStreak: 10, failRuns: 1 }, stopped, 0)).toMatch(/failed 10 times/);
    // A success since the resume, then a new run: it counts whole (5, not 5 + 5).
    expect(runawayReason({ ...NO_USAGE, failStreak: 5, failRuns: 2 }, stopped, 0)).toMatch(/failed 5 times/);
  });

  it('stops one past its budget of re-read tokens since it started; 0 is no budget', () => {
    expect(runawayReason({ ...NO_USAGE, reRead: 31_000_000 }, { ...NO_USAGE, reRead: 5_000_000 }, 25_000_000)).toMatch(/re-read 26\.0M tokens since it started/);
    expect(runawayReason({ ...NO_USAGE, reRead: 29_000_000 }, { ...NO_USAGE, reRead: 5_000_000 }, 25_000_000)).toBeUndefined();
    expect(runawayReason({ ...NO_USAGE, reRead: 99_000_000 }, NO_USAGE, 0)).toBeUndefined();
  });
});

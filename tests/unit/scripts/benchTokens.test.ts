import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  sessionOf,
  sinceTime,
} from '../../../scripts/bench-tokens.mjs';

/** One assistant turn that read `read` cached tokens, and called a tool with id. */
const turn = (n: number, read: number, toolId?: string) => ({
  type: 'assistant',
  timestamp: `2026-10-18T10:00:${String(n).padStart(2, '0')}Z`,
  message: {
    id: `msg-${n}`,
    model: 'claude-opus-5-5',
    usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: read, output_tokens: 10 },
    content: toolId ? [{ type: 'tool_use', id: toolId, name: 'Read', input: {} }] : [],
  },
});
const result = (toolId: string, chars: number) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: 'x'.repeat(chars) }] },
});
const compact = (preTokens: number) => ({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens } });

describe('sessionOf', () => {
  const entries = [
    { type: 'user', message: { content: 'You are agent Comet-1, working on backlog item BL-83' } },
    turn(1, 1000, 't1'),
    result('t1', 400),
    turn(2, 3000),
    turn(3, 5000),
    compact(190_000),
    turn(4, 1000),
  ];
  const s = sessionOf(entries, '/p/folder/abc.jsonl');

  it('counts compactions: the context compacted, after how many turns', () => {
    expect(s.compactions).toEqual([{ turn: 3, tokens: 190_000, trigger: 'auto' }]);
  });

  it('reports what a turn re-reads on average', () => {
    expect(s.turns).toBe(4);
    expect(s.readPerTurn).toBe(2500);
  });

  it('stops counting a tool result as re-read once a compaction summarized it away', () => {
    // 400 characters, about 100 tokens, re-read on turns 2 and 3; not on turn 4, after the compaction.
    expect(s.kinds.Read).toEqual({ results: 1, tokens: 100, reread: 200 });
  });

  it('reads the role and ticket from the first prompt', () => {
    expect(s.role).toBe('implementer');
    expect(s.ticket).toBe('BL-83');
  });

  it('has no compactions in a session that never compacted', () => {
    expect(sessionOf([turn(1, 10)], '/p/f/x.jsonl').compactions).toEqual([]);
  });
});

describe('sinceTime', () => {
  it('keeps a date as that UTC day', () => {
    expect(sinceTime('2026-10-18')).toBe('2026-10-18');
  });

  it('reads a time without a zone as local time', () => {
    expect(sinceTime('2026-10-18T18:42')).toBe(new Date(2026, 9, 18, 18, 42).toISOString());
  });

  it('keeps a time with a zone as it is', () => {
    expect(sinceTime('2026-10-18T16:42:00Z')).toBe('2026-10-18T16:42:00.000Z');
  });

  it('refuses what is not a time', () => {
    expect(sinceTime('yesterday')).toBeUndefined();
  });
});

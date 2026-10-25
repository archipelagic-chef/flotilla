import { describe, expect, it } from 'vitest';
import {
  SUMMARY_EVERY_MS,
  summaryAnswer,
  summaryArgs,
  summaryInput,
  summaryWait,
} from '../../../src/features/chats/summary';

const assistant = (...content: unknown[]) => JSON.stringify({ type: 'assistant', message: { content } });
const user = (content: unknown) => JSON.stringify({ type: 'user', message: { content } });
const tool = (n: number) => assistant({ type: 'tool_use', id: `t${n}`, name: 'Bash', input: { command: `npm test ${n}` } });

describe('summaryInput', () => {
  it('gives the messages, tool calls and results, oldest first', () => {
    const lines = [
      user('Fix the login'),
      assistant({ type: 'text', text: 'Looking at it.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/src/a.ts' } }),
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'const a = 1;' }]),
      assistant({ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }),
      user([{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: '2 failed' }] }]),
    ];
    expect(summaryInput(lines).split('\n')).toEqual([
      'User: Fix the login',
      'Agent: Looking at it.',
      'Tool Read: /w/src/a.ts',
      'Result: const a = 1;',
      'Tool Bash: npm test',
      'Failed: 2 failed',
    ]);
  });

  it('gives a todo list as its steps', () => {
    const todos = [
      { content: 'Read', status: 'completed' },
      { content: 'Fix', status: 'in_progress' },
      { content: 'Test', status: 'pending' },
    ];
    expect(summaryInput([assistant({ type: 'tool_use', id: 't', name: 'TodoWrite', input: { todos } })])).toBe(
      'Tool TodoWrite: Read (done); Fix (doing); Test (to do)',
    );
  });

  it('keeps only the last 30 items', () => {
    const out = summaryInput(Array.from({ length: 50 }, (_, n) => tool(n))).split('\n');
    expect(out).toHaveLength(30);
    expect(out[0]).toBe('Tool Bash: npm test 20');
    expect(out.at(-1)).toBe('Tool Bash: npm test 49');
  });

  it('is capped in size, dropping the oldest first, and each item is cut', () => {
    const long = assistant({ type: 'text', text: 'x'.repeat(5000) });
    const out = summaryInput([long, long, long, long, tool(1)], { chars: 1500 });
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out.endsWith('Tool Bash: npm test 1')).toBe(true);
    expect(out.split('\n')).toHaveLength(3);
    expect(out.split('\n')[0].length).toBeLessThanOrEqual(610);
  });

  it("skips what does not parse (a cut first line) and subagents' lines", () => {
    const side = JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'sub' }] } });
    expect(summaryInput(['{"type":"assis', side, tool(1), ''])).toBe('Tool Bash: npm test 1');
  });
});

describe('summaryArgs', () => {
  it('asks once, on the model, keeping nothing, with no tools or hooks', () => {
    const args = summaryArgs('haiku');
    expect(args).toContain('--no-session-persistence');
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'haiku']);
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', '']);
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ disableAllHooks: true });
  });
});

describe('summaryAnswer', () => {
  it('takes its first two lines', () => {
    expect(summaryAnswer(JSON.stringify({ type: 'result', subtype: 'success', result: 'Running tests.\n\nNothing looks wrong.\nMore.' }))).toEqual({
      text: 'Running tests.\nNothing looks wrong.',
    });
  });

  it('says why it failed', () => {
    expect(summaryAnswer(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }))).toEqual({ error: 'error_max_turns' });
    expect(summaryAnswer('spawn failed')).toEqual({ error: 'spawn failed' });
  });
});

describe('summaryWait', () => {
  const at = '2026-10-24T10:00:00Z';
  const t = new Date(at).getTime();
  it('runs at once the first time, then once a minute', () => {
    expect(summaryWait(undefined, t)).toBe(0);
    expect(summaryWait({ at, text: 'a' }, t + 20_000)).toBe(SUMMARY_EVERY_MS - 20_000);
    expect(summaryWait({ at, text: 'a' }, t + SUMMARY_EVERY_MS)).toBe(0);
  });

  it('waits while one is written, and not after one failed', () => {
    expect(summaryWait({ at, running: true }, t + 5 * SUMMARY_EVERY_MS)).toBe(SUMMARY_EVERY_MS);
    expect(summaryWait({ at, error: 'x' }, t + 1000)).toBe(0);
  });
});

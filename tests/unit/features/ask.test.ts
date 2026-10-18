import { describe, expect, it } from 'vitest';
import { askArgs, askContextText, askEvent, askSettings, earlierText, interruptRequest, LineBuffer, postedAnswer, toolLabel, userMessage } from '../../../src/features/backlog/ask';

describe('askArgs', () => {
  const args = askArgs({ model: 'sonnet', instructions: 'Be brief.', plugins: ['superpowers@official'] });

  it('streams both ways, keeps nothing and asks no one', () => {
    for (const flag of ['-p', '--verbose', '--include-partial-messages', '--no-session-persistence']) expect(args).toContain(flag);
    expect(args[args.indexOf('--input-format') + 1]).toBe('stream-json');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
  });

  it('starts lean, with hooks and the enabled plugins off', () => {
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('--strict-mcp-config');
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ disableAllHooks: true, enabledPlugins: { 'superpowers@official': false } });
  });

  it('only reads: the reading tools, and git log, diff, show and status', () => {
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Bash');
    // The allowed list is last (variadic): nothing after it is taken for a rule.
    expect(args.slice(args.indexOf('--allowedTools') + 1)).toEqual(['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git status:*)']);
    expect(args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--tools'))).toEqual(['Bash(git *--output*)', 'Bash(git *--ext-diff*)']);
  });

  it('leaves the model to Claude Code when none is given', () => {
    expect(askArgs({ instructions: 'x', plugins: [] })).not.toContain('--model');
    expect(JSON.parse(askSettings([]))).toEqual({ disableAllHooks: true });
  });
});

describe('askContextText', () => {
  const base = {
    id: 'BL-80',
    title: 'Ask about a ticket',
    status: 'doing',
    file: '/repo/.flotilla/backlog/BL-80.md',
    description: 'Do the thing.',
    activity: [1, 2, 3, 4, 5].map((n) => ({ date: `2026-10-1${n} 10:00`, author: `Agent A-${n}`, body: `Report ${n}` })),
    commits: [{ short: 'abc1234', subject: 'BL-80: Ask' }],
  };

  it('gives the description, the latest entries and the branch', () => {
    const text = askContextText({ ...base, base: 'main', diffStat: ' src/ask.ts | 10 +++', worktree: { path: '/wt', branch: 'feature/BL-80', changes: ' M src/ask.ts' } });
    expect(text).toContain('# BL-80: Ask about a ticket');
    expect(text).toContain('Do the thing.');
    expect(text).toContain('4 of 5 entries');
    expect(text).not.toContain('Report 1');
    expect(text).toContain('Report 5');
    expect(text).toContain('Worktree: /wt');
    expect(text).toContain('- abc1234 BL-80: Ask');
    expect(text).toContain('src/ask.ts | 10');
    expect(text).toContain(' M src/ask.ts');
  });

  it('says when there is no worktree, no commits and no description', () => {
    const text = askContextText({ ...base, description: '', activity: [], commits: [] });
    expect(text).toContain('No worktree');
    expect(text).toContain('No commits of its own');
    expect(text).toContain('(none)');
  });

  it('cuts a long description', () => {
    const text = askContextText({ ...base, description: 'x'.repeat(20000) });
    expect(text.length).toBeLessThan(12000);
    expect(text).toContain('[…cut');
  });
});

describe('askEvent', () => {
  it('reads the stream: text as it comes, tools, and the result', () => {
    expect(askEvent(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x' }))).toEqual({ kind: 'ready' });
    expect(askEvent(JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: {} } }))).toEqual({ kind: 'message' });
    expect(askEvent(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } } }))).toEqual({
      kind: 'text',
      text: 'Hi',
    });
    expect(
      askEvent(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } }] } })),
    ).toEqual({ kind: 'tool', label: 'Reading src/a.ts' });
    expect(askEvent(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.' }))).toEqual({ kind: 'result', text: 'Done.' });
    expect(askEvent(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true }))).toEqual({ kind: 'result', error: 'error_during_execution' });
    expect(askEvent(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1760572800' }))).toEqual({
      kind: 'result',
      error: 'Claude AI usage limit reached|1760572800',
    });
  });

  it('skips what the chat does not show', () => {
    expect(askEvent('not json')).toBeUndefined();
    expect(askEvent(JSON.stringify({ type: 'system', subtype: 'status' }))).toBeUndefined();
    expect(askEvent(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }))).toBeUndefined();
    expect(askEvent(JSON.stringify({ type: 'user', message: {} }))).toBeUndefined();
  });
});

describe('the rest', () => {
  it('labels tools briefly', () => {
    expect(toolLabel('Bash', { command: 'git log --oneline -5' })).toBe('Running git log --oneline -5');
    expect(toolLabel('Grep', { pattern: 'askEvent' })).toBe('Searching for askEvent');
    expect(toolLabel('Other', {})).toBe('Using Other');
  });

  it('splits output into whole lines', () => {
    const b = new LineBuffer();
    expect(b.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(b.push(':2}\r\n\n')).toEqual(['{"b":2}']);
  });

  it('writes messages and the interrupt as single lines', () => {
    expect(JSON.parse(userMessage('Hi\nthere'))).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Hi\nthere' }] } });
    expect(userMessage('x').endsWith('\n')).toBe(true);
    expect(JSON.parse(interruptRequest('r1'))).toEqual({ type: 'control_request', request_id: 'r1', request: { subtype: 'interrupt' } });
  });

  it('gives the chat so far, and a posted answer with its question', () => {
    expect(earlierText([])).toBe('');
    expect(earlierText([{ question: 'Why?', answer: 'Because.' }])).toContain('Q: Why?\n\nA: Because.');
    expect(postedAnswer('What is it for?\nAnd why?', 'For this.', 'sonnet')).toBe('Asked about this ticket (Ask, sonnet):\n\n> What is it for?\n> And why?\n\nFor this.');
  });
});

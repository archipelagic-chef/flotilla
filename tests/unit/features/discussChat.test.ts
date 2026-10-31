import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  discussArgs,
  discussionOpener,
  discussionTurns,
} from '../../../src/features/backlog/discussChat';
import { isDiscussionChat } from '../../../src/features/backlog/shaping';

const SESSION = '11111111-2222-3333-4444-555555555555';
const args = (resume: boolean) =>
  discussArgs({
    choice: ['--model', 'opus'],
    instructions: 'The rules.',
    plugins: ['a@b'],
    session: SESSION,
    resume,
    tools: ['Read', 'Grep', 'Glob', 'Edit(//t/BL-1.md)'],
  });

describe('discussArgs (BL-241)', () => {
  it('streams both ways and keeps its session: new, then resumed', () => {
    const a = args(false);
    expect(a).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages']));
    expect(a).not.toContain('--no-session-persistence');
    expect(a.slice(a.indexOf('--session-id'), a.indexOf('--session-id') + 2)).toEqual(['--session-id', SESSION]);
    expect(a).not.toContain('--resume');
    const r = args(true);
    expect(r.slice(r.indexOf('--resume'), r.indexOf('--resume') + 2)).toEqual(['--resume', SESSION]);
    expect(r).not.toContain('--session-id');
  });

  it('has its rules as the system prompt, its tools only (the ticket the one file it edits), and no hooks', () => {
    const a = args(false);
    expect(a[a.indexOf('--append-system-prompt') + 1]).toBe('The rules.');
    expect(a[a.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(a[a.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Edit');
    expect(a.slice(a.indexOf('--allowedTools') + 1)).toEqual(['Read', 'Grep', 'Glob', 'Edit(//t/BL-1.md)']);
    expect(JSON.parse(a[a.indexOf('--settings') + 1])).toEqual({ disableAllHooks: true, enabledPlugins: { 'a@b': false } });
    expect(a.slice(a.indexOf('--model'), a.indexOf('--model') + 2)).toEqual(['--model', 'opus']);
  });
});

describe('discussionOpener', () => {
  it('names the ticket and its agent, as a discussion', () => {
    expect(isDiscussionChat(discussionOpener({ id: 'BL-1', title: 'A ticket' }, 'Iris-7'))).toBe(true);
  });
});

describe('discussionTurns', () => {
  const line = (o: unknown) => JSON.stringify(o);
  it("reads the owner's messages and the last text of each answer; the first message is the opener", () => {
    const jsonl = [
      line({ type: 'queue-operation' }),
      line({ type: 'user', message: { content: 'Open the discussion.' } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Let me look.' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'file' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'What is it for?' }] } }),
      line({ type: 'user', isMeta: true, message: { content: 'caveat' } }),
      line({ type: 'user', message: { content: [{ type: 'text', text: 'Speed.' }] } }),
      'not json',
    ].join('\n');
    expect(discussionTurns(jsonl)).toEqual([
      { question: 'Open the discussion.', answer: 'What is it for?', state: 'done', opener: true },
      { question: 'Speed.', answer: '', state: 'done' },
    ]);
  });
});

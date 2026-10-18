import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { AskChat, type AskChatDeps } from '../../../src/features/backlog/askChat';

/** A Claude process as the chat sees it: what's written to it, and lines it prints. */
class FakeClaude extends EventEmitter {
  readonly written: Array<Record<string, unknown>> = [];
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  readonly stdin = new Writable({
    write: (chunk: Buffer, _enc, done) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) this.written.push(JSON.parse(line) as Record<string, unknown>);
      done();
    },
  });
  print(...events: unknown[]): void {
    this.stdout.write(events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  }
  kill(): boolean {
    this.killed = true;
    setImmediate(() => this.emit('close', null));
    return true;
  }
  /** The texts of the user messages it got. */
  get questions(): string[] {
    return this.written
      .filter((m) => m.type === 'user')
      .map((m) => ((m.message as { content: Array<{ text: string }> }).content[0].text));
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const result = (text: string) => ({ type: 'result', subtype: 'success', is_error: false, result: text });

function setup(o: { short?: () => string | undefined } = {}) {
  const spawned: FakeClaude[] = [];
  let changes = 0;
  const deps: AskChatDeps = {
    model: 'sonnet',
    memoryShort: o.short ?? (() => undefined),
    context: async () => ({ cwd: '/wt', text: '# BL-80: Ask' }),
    spawn: () => {
      const c = new FakeClaude();
      spawned.push(c);
      return c as unknown as ChildProcessWithoutNullStreams;
    },
    render: async (md) => `<p>${md}</p>`,
    changed: () => changes++,
    log: () => undefined,
  };
  const chat = new AskChat(deps, { memoryRetryMs: 5, stopGraceMs: 20 });
  return { chat, spawned, changes: () => changes };
}

describe('AskChat', () => {
  it('starts with the ticket, streams the answer, and goes on in the same process', async () => {
    const { chat, spawned } = setup();
    await chat.ask("What's this for?");
    expect(spawned).toHaveLength(1);
    const claude = spawned[0];
    expect(claude.questions[0]).toContain('# BL-80: Ask');
    expect(claude.questions[0]).toContain("## Question\n\nWhat's this for?");

    claude.print(delta('For '), delta('asking.'));
    await tick();
    expect(chat.view().turns[0]).toMatchObject({ state: 'answering', answer: 'For asking.' });

    claude.print(result('For asking.'));
    await tick();
    expect(chat.view().turns[0]).toMatchObject({ state: 'done', answer: 'For asking.', html: '<p>For asking.</p>' });

    await chat.ask('How far is it?');
    expect(spawned).toHaveLength(1);
    expect(claude.questions[1]).toBe('How far is it?');
  });

  it('shows what it looks at, and keeps only the final message as the answer', async () => {
    const { chat, spawned } = setup();
    await chat.ask('Which files?');
    const claude = spawned[0];
    claude.print(delta('Let me look.'), { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'ask' } }] } });
    await tick();
    expect(chat.view().turns[0].activity).toBe('Searching for ask…');
    claude.print({ type: 'stream_event', event: { type: 'message_start' } }, delta('src/ask.ts'));
    await tick();
    expect(chat.view().turns[0].answer).toBe('Let me look.\n\nsrc/ask.ts');
    claude.print(result('src/ask.ts'));
    await tick();
    expect(chat.view().turns[0]).toMatchObject({ state: 'done', answer: 'src/ask.ts' });
  });

  it('stops an answer with an interrupt, keeping what it wrote; the chat goes on', async () => {
    const { chat, spawned } = setup();
    await chat.ask('Tell me everything');
    const claude = spawned[0];
    claude.print(delta('Well, '));
    await tick();
    chat.stop();
    expect(claude.written.at(-1)).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } });
    claude.print(delta('more'), { type: 'result', subtype: 'error_during_execution', is_error: true });
    await tick();
    expect(chat.view().turns[0]).toMatchObject({ state: 'stopped', answer: 'Well, ' });
    expect(chat.answered(0)).toBeDefined();
    await chat.ask('Next');
    expect(spawned).toHaveLength(1);
    expect(claude.killed).toBe(false);
  });

  it('ends a process that does not stop, and starts a new one with the chat so far', async () => {
    const { chat, spawned } = setup();
    await chat.ask('First');
    spawned[0].print(result('One.'));
    await tick();
    await chat.ask('Second');
    chat.stop();
    await new Promise((r) => setTimeout(r, 40));
    expect(spawned[0].killed).toBe(true);
    await chat.ask('Third');
    expect(spawned).toHaveLength(2);
    expect(spawned[1].questions[0]).toContain('Q: First\n\nA: One.');
    expect(spawned[1].questions[0]).toContain('## Question\n\nThird');
  });

  it('says why an answer failed: the process ended, or a usage limit', async () => {
    const { chat, spawned } = setup();
    await chat.ask('Q');
    spawned[0].stderr.write('boom');
    await tick();
    spawned[0].emit('close', 1);
    await tick();
    expect(chat.view().turns[0]).toMatchObject({ state: 'failed', error: 'boom' });

    await chat.ask('Again');
    spawned[1].print({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 4:30am" });
    await tick();
    expect(chat.view().turns[1].error).toMatch(/^Claude's usage limit is reached; try again after/);
  });

  it('waits while memory is short, and can be stopped meanwhile', async () => {
    let short: string | undefined = 'Waiting for memory…';
    const { chat, spawned } = setup({ short: () => short });
    const asked = chat.ask('Q');
    await tick();
    expect(chat.view().turns[0]).toMatchObject({ state: 'waiting', activity: 'Waiting for memory…' });
    expect(spawned).toHaveLength(0);
    short = undefined;
    await asked;
    expect(spawned).toHaveLength(1);

    const second = setup({ short: () => 'Waiting for memory…' });
    const waiting = second.chat.ask('Q');
    await tick();
    second.chat.stop();
    await waiting;
    expect(second.spawned).toHaveLength(0);
    expect(second.chat.view().turns[0].state).toBe('stopped');
  });

  it('starts over with New Question, and ends its process when disposed', async () => {
    const { chat, spawned } = setup();
    await chat.ask('Q');
    chat.reset();
    expect(spawned[0].killed).toBe(true);
    expect(chat.view().turns).toEqual([]);
    await chat.ask('Fresh');
    expect(spawned).toHaveLength(2);
    expect(spawned[1].questions[0]).not.toContain('Earlier in this chat');
    chat.dispose();
    expect(spawned[1].killed).toBe(true);
  });

  it('asks one question at a time, and marks a posted answer', async () => {
    const { chat, spawned } = setup();
    await chat.ask('Q');
    await chat.ask('Too soon');
    expect(chat.view().turns).toHaveLength(1);
    expect(chat.answered(0)).toBeUndefined();
    spawned[0].print(result('A'));
    await tick();
    const turn = chat.answered(0)!;
    chat.markPosted(turn);
    expect(chat.view().turns[0].posted).toBe(true);
  });
});

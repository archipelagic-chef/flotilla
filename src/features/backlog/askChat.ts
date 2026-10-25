import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  type AskEvent,
  askEvent,
  type AskTurn,
  type AskView,
  earlierText,
  interruptRequest,
  LineBuffer,
  userMessage,
} from './ask';
import { parseUsageLimit } from './limits';

/** What a ticket's Ask chat needs from its tab: how to start its process, and where its changes go. */
export interface AskChatDeps {
  /** The model it answers with, as shown. */
  model: string;
  /** Too little memory free to start a process: what to say while it waits; undefined when there's room. */
  memoryShort(): string | undefined;
  /** The ticket's context (the first message's start), and the folder to answer in. */
  context(): Promise<{ cwd: string; text: string }>;
  /** Starts an Ask process in cwd (see askArgs). */
  spawn(cwd: string): ChildProcessWithoutNullStreams;
  /** Markdown as HTML, for a finished answer. */
  render(markdown: string): Promise<string>;
  /** The chat changed: its view is to be shown again. */
  changed(): void;
  log(line: string): void;
}

/** How often a question waiting for memory looks again, and how long a stopped answer may take to end. */
const MEMORY_RETRY_MS = 5000;
const STOP_GRACE_MS = 5000;

/**
 * A ticket's Ask chat (BL-80): its questions and answers, and the one process that answers them. The process starts
 * with the first question (once there's memory for it) and goes on with the follow-ups; it ends with New Question or
 * when the tab closes, and nothing of the chat is kept. If it ends on its own (or doesn't stop when asked), the next
 * question starts a new one, given the chat so far.
 */
export class AskChat {
  private turns: AskTurn[] = [];
  private child: ChildProcessWithoutNullStreams | undefined;
  /** The turn its process is answering. */
  private active: AskTurn | undefined;
  /** Changes when the chat starts over: what was underway for the old one stops. */
  private epoch = 0;
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private requests = 0;

  constructor(
    private readonly d: AskChatDeps,
    private readonly timing = { memoryRetryMs: MEMORY_RETRY_MS, stopGraceMs: STOP_GRACE_MS },
  ) {}

  view(): AskView {
    return { turns: this.turns.map((t) => ({ ...t })), model: this.d.model, busy: this.busy };
  }

  /** The question being answered (or waiting to be). */
  private get current(): AskTurn | undefined {
    const last = this.turns[this.turns.length - 1];
    return last && (last.state === 'waiting' || last.state === 'answering') ? last : undefined;
  }

  /**
   * A question is underway: waiting, being answered, or stopped but not ended yet (its result, or the grace's end, is
   * still to come). Until then a new question would get the stopped answer's last words and its ending.
   */
  get busy(): boolean {
    return !!this.current || !!this.active;
  }

  async ask(text: string): Promise<void> {
    const question = text.trim();
    if (!question || this.busy) return;
    const turn: AskTurn = { question, answer: '', state: 'waiting' };
    const earlier = this.turns.filter((t) => t.answer.trim());
    this.turns.push(turn);
    this.d.changed();
    const epoch = this.epoch;
    const gone = () => epoch !== this.epoch || turn.state !== 'waiting';
    try {
      let message = question;
      if (!this.child) {
        // Not counted against flotilla.agents.maxRunning (it's short, and only reads), but it waits for memory.
        for (let short = this.d.memoryShort(); short; short = this.d.memoryShort()) {
          turn.activity = short;
          this.d.changed();
          await new Promise((r) => setTimeout(r, this.timing.memoryRetryMs));
          if (gone()) return;
        }
        turn.activity = 'Reading the ticket…';
        this.d.changed();
        const context = await this.d.context();
        if (gone()) return;
        this.launch(context.cwd);
        message = [context.text, earlierText(earlier), `## Question\n\n${question}`].filter(Boolean).join('\n\n');
      }
      turn.state = 'answering';
      turn.activity = 'Thinking…';
      this.active = turn;
      this.child!.stdin.write(userMessage(message));
      this.d.changed();
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.fail(turn, error instanceof Error ? error.message : String(error));
    }
  }

  /** Stops the answer being written: what it wrote so far stays. The chat goes on. */
  stop(): void {
    const turn = this.current;
    if (!turn) return;
    const answering = turn.state === 'answering';
    turn.state = 'stopped';
    // Busy until it has ended (see busy).
    turn.activity = answering && this.child ? 'Stopping…' : undefined;
    this.d.changed();
    if (!answering || !this.child) return;
    const child = this.child;
    try {
      child.stdin.write(interruptRequest(`stop-${++this.requests}`));
    } catch {
      // It's ending anyway.
    }
    // One that doesn't stop is ended: the next question starts a new one.
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      if (this.child !== child || this.active !== turn) return;
      this.end();
      void this.finish(turn);
    }, this.timing.stopGraceMs);
  }

  /** New Question: the chat starts over, its process ended. */
  reset(): void {
    this.epoch++;
    this.end();
    this.turns = [];
    this.d.changed();
  }

  dispose(): void {
    this.epoch++;
    this.end();
  }

  /** The question and answer of a finished turn, to post to the ticket. */
  answered(index: number): AskTurn | undefined {
    const t = this.turns[index];
    return t && (t.state === 'done' || (t.state === 'stopped' && t.answer.trim())) ? t : undefined;
  }

  markPosted(turn: AskTurn): void {
    turn.posted = true;
    this.d.changed();
  }

  private launch(cwd: string): void {
    const child = this.d.spawn(cwd);
    this.child = child;
    const lines = new LineBuffer();
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of lines.push(chunk.toString())) {
        const event = askEvent(line);
        if (event && this.child === child) this.onEvent(event);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)));
    // Writing to a process that has ended fails here, not where it's written.
    child.stdin.on('error', () => undefined);
    const ended = (why: string) => {
      if (this.child !== child) return;
      this.child = undefined;
      clearTimeout(this.stopTimer);
      const turn = this.active;
      this.active = undefined;
      this.d.log(`Ask stopped (${why}).${stderr.trim() ? ` ${stderr.trim()}` : ''}`);
      if (turn?.state === 'answering') this.fail(turn, stderr.trim() || `Claude Code stopped (${why}).`);
      else if (turn) void this.finish(turn);
    };
    child.on('error', (e) => ended(e.message));
    child.on('close', (code) => ended(`exit code ${code}`));
  }

  private onEvent(e: AskEvent): void {
    const turn = this.active;
    if (!turn) return;
    switch (e.kind) {
      case 'message':
        if (turn.answer.trim() && !turn.answer.endsWith('\n\n')) turn.answer += '\n\n';
        return;
      case 'text':
        if (turn.state !== 'answering') return;
        turn.answer += e.text;
        turn.activity = undefined;
        this.d.changed();
        return;
      case 'tool':
        if (turn.state !== 'answering') return;
        turn.activity = `${e.label}…`;
        this.d.changed();
        return;
      case 'result':
        this.active = undefined;
        clearTimeout(this.stopTimer);
        if (turn.state === 'stopped') {
          void this.finish(turn);
        } else if (e.error !== undefined) {
          this.fail(turn, e.error);
        } else {
          // The answer is its last message; what it said on the way (before looking things up) goes.
          if (e.text?.trim()) turn.answer = e.text;
          turn.state = 'done';
          void this.finish(turn);
        }
        return;
    }
  }

  /** A turn that's over: its answer rendered. */
  private async finish(turn: AskTurn): Promise<void> {
    turn.activity = undefined;
    const epoch = this.epoch;
    if (turn.answer.trim()) {
      try {
        turn.html = await this.d.render(turn.answer);
      } catch {
        // Shown as written.
      }
    }
    if (epoch === this.epoch) this.d.changed();
  }

  private fail(turn: AskTurn, error: string): void {
    const limit = parseUsageLimit(error, new Date());
    turn.state = 'failed';
    turn.error = limit
      ? `${limit.kind === 'usage' ? "Claude's usage limit is reached" : limit.kind === 'rate' ? 'Claude is rate limited' : 'Claude is overloaded'}; try again ${limit.known ? `after ${limit.until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'in a few minutes'}.`
      : error.slice(0, 500);
    void this.finish(turn);
  }

  /** Ends the process (if any): the next question starts a new one. */
  private end(): void {
    const child = this.child;
    this.child = undefined;
    this.active = undefined;
    clearTimeout(this.stopTimer);
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // Already closed.
    }
    child.kill();
  }
}

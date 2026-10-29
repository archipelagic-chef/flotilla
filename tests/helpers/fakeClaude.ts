import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

/** A Claude process as the chat sees it: what's written to it, and lines it prints. */
export class FakeClaude extends EventEmitter {
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
    return this.written.filter((m) => m.type === 'user').map((m) => (m.message as { content: Array<{ text: string }> }).content[0].text);
  }
}

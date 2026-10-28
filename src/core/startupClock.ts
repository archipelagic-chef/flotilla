/**
 * Where startup's time goes (BL-230): each step's first time, from the moment the extension host started, said in the
 * output channel as it happens, then once as a lasting "Startup took …" line when the last one expected is there.
 */
export class StartupClock {
  private readonly marks = new Map<string, number>();
  private said = false;

  constructor(
    private readonly log: (line: string) => void,
    /** The steps the summary waits for. */
    private readonly expected: readonly string[],
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Notes a step the first time it's reached (now, or at the time given); later times are ignored. */
  mark(step: string, at = this.now()): void {
    if (this.marks.has(step)) return;
    this.marks.set(step, at);
    this.log(`Startup: ${step} at ${ms(at)}`);
    if (!this.said && this.expected.every((s) => this.marks.has(s))) {
      this.said = true;
      this.log(this.summary());
    }
  }

  has(step: string): boolean {
    return this.marks.has(step);
  }

  /** "Startup took 1.9 s: activated 310 ms, view registered 420 ms, …", in the order the steps came. */
  summary(): string {
    const steps = [...this.marks].sort((a, b) => a[1] - b[1]);
    const last = steps.at(-1)?.[1] ?? 0;
    return `Startup took ${ms(last)}: ${steps.map(([step, at]) => `${step} ${ms(at)}`).join(', ')}`;
  }
}

function ms(at: number): string {
  return at >= 1000 ? `${(at / 1000).toFixed(1)} s` : `${Math.round(at)} ms`;
}

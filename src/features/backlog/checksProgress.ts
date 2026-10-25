/**
 * How far a merge's checks are, read from their output as it comes (BL-169): the step (npm's script headers, vitest's
 * RUN), vitest's test files done, the wait for a test slot (BL-138) and the last lines. Their failure, read from the
 * whole output: the failing tests, each with its first error lines.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

/** How many lines of output the live tail keeps. */
export const TAIL_LINES = 30;

/** What the output says so far. */
export interface ChecksProgress {
  /** The step that runs: "Typecheck", "Tests". */
  step?: string;
  /** Test files done, and of those, failed. */
  files: number;
  failedFiles: number;
  /** The test files of the run, once its summary says (or the last run's, given). */
  total?: number;
  /** What it waits for: "1 other test run (BL-120)". */
  wait?: string;
  /** The last lines, without colours. */
  tail: string[];
}

/** Reads the checks' output, a chunk at a time. */
export class ChecksReader {
  private partial = '';
  readonly progress: ChecksProgress = { files: 0, failedFiles: 0, tail: [] };

  push(text: string): void {
    const lines = (this.partial + text).split('\n');
    this.partial = lines.pop() ?? '';
    for (const line of lines) this.line(line);
  }

  /** The line being written (no newline yet) as the last of the tail. */
  tail(): string[] {
    const open = plain(this.partial);
    return open.trim() ? [...this.progress.tail, open].slice(-TAIL_LINES) : this.progress.tail;
  }

  private line(raw: string): void {
    const line = plain(raw);
    const p = this.progress;
    let m: RegExpMatchArray | null;
    if ((m = /^> (?:\S+@\S*\s+)?([\w:-]+)$/.exec(line))) {
      p.step = stepName(m[1]);
      p.wait = undefined;
    } else if (/^\s*RUN\s+v\d/.test(line)) {
      p.step = 'Tests';
      p.wait = undefined;
    } else if ((m = /^Waiting for (.+?)…?$/.exec(line.trim()))) p.wait = m[1];
    else if ((m = /^\s*([✓×❯↓])\s+\S+\s+\(\d+ tests?\b/.exec(line))) {
      p.files++;
      if (m[1] === '×' || m[1] === '❯') p.failedFiles++;
      p.wait = undefined;
    } else if ((m = /^\s*Test Files\s.*\((\d+)\)\s*$/.exec(line))) p.total = Number(m[1]);
    if (!line.trim() && !p.tail.at(-1)?.trim()) return;
    p.tail.push(line);
    if (p.tail.length > TAIL_LINES) p.tail.shift();
  }
}

/** The output without colours, and with what a carriage return wrote over gone. */
function plain(text: string): string {
  return text.replace(ANSI, '').replace(/\r$/, '').split('\r').pop() ?? '';
}

/** "test" → "Tests", "typecheck" → "Typecheck". */
export function stepName(script: string): string {
  return script === 'test' ? 'Tests' : script.charAt(0).toUpperCase() + script.slice(1);
}

/** "1:12", "12:05", "1:02:03". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}

/** How far it is, as a fraction (0 to 1) of the test files; undefined without them, or without their number. */
export function fraction(p: Pick<ChecksProgress, 'step' | 'files' | 'total'>): number | undefined {
  return p.step === 'Tests' && p.total ? Math.min(1, p.files / p.total) : undefined;
}

/** "Tests: 84 of 145 files · 1:12", "Tests: 84 files · 1:12", "Typecheck · 0:12". */
export function progressLine(p: Pick<ChecksProgress, 'step' | 'files' | 'total'>, ms: number): string {
  const files =
    p.step === 'Tests' && p.files ? `: ${p.total ? `${p.files} of ${Math.max(p.total, p.files)}` : p.files} file${(p.total ?? p.files) === 1 ? '' : 's'}` : '';
  return `${p.step ?? 'Checks'}${files} · ${elapsed(ms)}`;
}

/** A failing test, "file › name" (or a file that failed to load), with its first error lines. */
export interface FailedTest {
  test: string;
  error: string[];
}

/** The failing tests in the checks' whole output (vitest's FAIL lines), each once, with their first error lines. */
export function failureSummary(output: string, maxTests = 30, maxLines = 4): FailedTest[] {
  const lines = output.replace(ANSI, '').replace(/\r\n?/g, '\n').split('\n');
  const found = new Map<string, FailedTest>();
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*FAIL\s+(\S+)(?:\s+>\s+(.+?))?(?:\s+\[ .* \])?\s*$/.exec(lines[i]);
    if (!m) continue;
    const test = m[2]
      ? `${m[1]} › ${m[2]
          .trim()
          .split(/\s+>\s+/)
          .join(' › ')}`
      : m[1];
    if (found.has(test)) continue;
    const error: string[] = [];
    for (let j = i + 1; j < lines.length && error.length < maxLines; j++) {
      const l = lines[j];
      // Its error ends at the next failure, a rule, its stack or diff, or the summary.
      if (
        /^\s*FAIL\s/.test(l) ||
        /^\s*⎯/.test(l) ||
        /^\s*❯\s/.test(l) ||
        /^\s*at\s/.test(l) ||
        /^[-+] (Expected|Received)/.test(l) ||
        /^\s*Test Files\s/.test(l)
      )
        break;
      if (l.trim()) error.push(l.trimEnd());
    }
    found.set(test, { test, error });
    if (found.size >= maxTests) break;
  }
  return [...found.values()];
}

import { describe, expect, it } from 'vitest';
import { ChecksReader, elapsed, failureSummary, fraction, progressLine, TAIL_LINES } from '../../../src/features/backlog/checksProgress';

/** vitest's output, written to a pipe (no terminal): one line per test file as it ends, then its summary. */
const RUN = [
  '',
  '> flotilla@0.1.0 typecheck',
  '> tsc --noEmit && tsc --noEmit -p tsconfig.webview.json',
  '',
  '',
  '> flotilla@0.1.0 test',
  '> node scripts/test.mjs',
  '',
  'Waiting for 1 other test run (BL-120)…',
  '\x1b[1m\x1b[46m RUN \x1b[49m\x1b[22m \x1b[36mv5.0.3 \x1b[39m\x1b[90m/repo\x1b[39m',
  '',
  ' \x1b[32m✓\x1b[39m tests/unit/a.test.ts \x1b[2m(\x1b[22m\x1b[2m10 tests\x1b[22m\x1b[2m)\x1b[22m\x1b[32m 71\x1b[2mms\x1b[22m\x1b[39m',
  ' \x1b[33m❯\x1b[39m tests/unit/b.test.ts (3 tests | 1 failed) 40ms',
  '   \x1b[31m×\x1b[39m b > adds 12ms',
  ' ✓ tests/unit/c.test.ts (1 test) 3ms',
];

const FAILURES = [
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' \x1b[31mFAIL\x1b[39m  tests/unit/b.test.ts > b > adds',
  'AssertionError: expected 3 to be 4 // Object.is equality',
  '',
  '- Expected',
  '+ Received',
  '',
  ' ❯ tests/unit/b.test.ts:5:15',
  '',
  ' FAIL  tests/unit/d.test.ts > slow one',
  'Error: Test timed out in 30000ms.',
  'If this is a long-running test, pass a timeout value as the last argument.',
  ' ❯ tests/unit/d.test.ts:9:3',
  '',
  ' FAIL  tests/unit/b.test.ts > b > adds',
  ' Test Files  1 failed | 2 passed (145)',
  '      Tests  1 failed | 13 passed (14)',
];

describe("The checks' progress (BL-169)", () => {
  it('follows the steps, the wait for a test slot, the test files done and their number', () => {
    const r = new ChecksReader();
    r.push(RUN.slice(0, 4).join('\n') + '\n');
    expect(r.progress).toMatchObject({ step: 'Typecheck', files: 0 });
    r.push(RUN.slice(4, 9).join('\n') + '\n');
    expect(r.progress).toMatchObject({ step: 'Tests', wait: '1 other test run (BL-120)' });
    // Its chunks end anywhere: a line is read once it ends.
    const rest = RUN.slice(9).join('\n') + '\n';
    r.push(rest.slice(0, 120));
    r.push(rest.slice(120));
    expect(r.progress).toMatchObject({ step: 'Tests', wait: undefined, files: 3, failedFiles: 1 });
    expect(r.progress.total).toBeUndefined();
    expect(r.progress.tail.at(-1)).toBe(' ✓ tests/unit/c.test.ts (1 test) 3ms');
    r.push(FAILURES.join('\n') + '\n');
    expect(r.progress.total).toBe(145);
  });

  it("reads npm's header of a package without a version, and not the command under it", () => {
    const r = new ChecksReader();
    r.push('> checks\n> node tools/checks.js\n');
    expect(r.progress.step).toBe('Checks');
  });

  it('keeps the last lines, without colours, blank runs as one, with the line being written', () => {
    const r = new ChecksReader();
    r.push(Array.from({ length: 50 }, (_, i) => `\x1b[2mline ${i}\x1b[0m`).join('\n') + '\n\n\n\nhalf');
    const tail = r.tail();
    expect(tail).toHaveLength(TAIL_LINES);
    expect(tail.slice(-3)).toEqual(['line 49', '', 'half']);
    // What a carriage return wrote over is gone.
    r.push(' done\rprogress 1\rprogress 2\n');
    expect(r.tail().at(-1)).toBe('progress 2');
  });

  it('says how far it is: files of the total, or the elapsed time', () => {
    expect(progressLine({ step: 'Tests', files: 84, total: 145 }, 72_000)).toBe('Tests: 84 of 145 files · 1:12');
    expect(progressLine({ step: 'Tests', files: 84 }, 72_000)).toBe('Tests: 84 files · 1:12');
    expect(progressLine({ step: 'Typecheck', files: 0, total: 145 }, 12_000)).toBe('Typecheck · 0:12');
    expect(progressLine({ files: 0 }, 3_725_000)).toBe('Checks · 1:02:05');
    // More files than the last run had: the files done, of as many.
    expect(progressLine({ step: 'Tests', files: 150, total: 145 }, 0)).toBe('Tests: 150 of 150 files · 0:00');
    expect(fraction({ step: 'Tests', files: 29, total: 50 })).toBeCloseTo(0.58);
    expect(fraction({ step: 'Typecheck', files: 0, total: 50 })).toBeUndefined();
    expect(fraction({ step: 'Tests', files: 3 })).toBeUndefined();
    expect(elapsed(59_999)).toBe('0:59');
  });
});

describe("The checks' failure (BL-169)", () => {
  it('lists the failing tests, file › name, each once with its first error lines', () => {
    expect(failureSummary([...RUN, ...FAILURES].join('\n'))).toEqual([
      { test: 'tests/unit/b.test.ts › b › adds', error: ['AssertionError: expected 3 to be 4 // Object.is equality'] },
      { test: 'tests/unit/d.test.ts › slow one', error: ['Error: Test timed out in 30000ms.', 'If this is a long-running test, pass a timeout value as the last argument.'] },
    ]);
  });

  it('names a file that failed to load, and nothing for output without vitest failures', () => {
    expect(failureSummary(' FAIL  tests/e.test.ts [ tests/e.test.ts ]\nError: Transform failed with 1 error:\n')).toEqual([
      { test: 'tests/e.test.ts', error: ['Error: Transform failed with 1 error:'] },
    ]);
    expect(failureSummary(' FAIL  tests/e.test.ts\nSyntaxError: Unexpected token\n')).toEqual([{ test: 'tests/e.test.ts', error: ['SyntaxError: Unexpected token'] }]);
    expect(failureSummary('src/a.ts(3,1): error TS2322: no\n')).toEqual([]);
  });
});

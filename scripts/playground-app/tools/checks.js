// The playground's slow checks (npm run checks; BL-169's demo sets them as the merge's): each test file in turn, with
// node's test runner, a pause before each as on a busy machine, printed as vitest prints to a pipe (a line per file,
// then the failing tests with their errors, and the summary), so the merge's checks show how far they are.
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const PAUSE_MS = Number(process.env.PLAYGROUND_CHECKS_PAUSE_MS ?? 2000);
const files = readdirSync('test')
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => `test/${f}`);

/** A file's top-level tests from node's TAP output: name, passed, and the first lines of its error. */
function results(tap) {
  const out = [];
  const lines = tap.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(not )?ok \d+ - (.+)$/.exec(lines[i]);
    if (!m) continue;
    const error = [];
    if (m[1]) {
      const at = lines.findIndex((l, j) => j > i && /^ {2}error: /.test(l));
      const first = at > 0 ? lines[at].replace(/^ {2}error: (\|-)?/, '').replace(/^'|'$/g, '') : '';
      if (first.trim()) error.push(first.trim());
      for (let j = at + 1; at > 0 && j < lines.length && /^ {4}/.test(lines[j]) && error.length < 3; j++) if (lines[j].trim()) error.push(lines[j].trim());
    }
    out.push({ name: m[2], passed: !m[1], error });
  }
  return out;
}

console.log(` RUN  v0 ${process.cwd()} (the playground's checks)\n`);
const failures = [];
let failedFiles = 0;
let tests = 0;
for (const file of files) {
  await sleep(PAUSE_MS);
  const started = Date.now();
  const tap = await new Promise((resolve) => execFile(process.execPath, ['--test', '--test-reporter=tap', file], (_e, stdout) => resolve(stdout)));
  const found = results(tap);
  const failed = found.filter((t) => !t.passed);
  tests += found.length;
  const count = `${found.length} test${found.length === 1 ? '' : 's'}${failed.length ? ` | ${failed.length} failed` : ''}`;
  console.log(` ${failed.length ? '❯' : '✓'} ${file} (${count}) ${Date.now() - started}ms`);
  for (const t of failed) console.log(`   × ${t.name}`);
  if (failed.length) failedFiles++;
  failures.push(...failed.map((t) => ({ file, ...t })));
}
if (failures.length) {
  console.log(`\n⎯⎯⎯⎯⎯⎯⎯ Failed Tests ${failures.length} ⎯⎯⎯⎯⎯⎯⎯\n`);
  for (const f of failures) console.log(` FAIL  ${f.file} > ${f.name}\n${f.error.join('\n')}\n`);
}
const passedFiles = files.length - failedFiles;
console.log(` Test Files  ${failedFiles ? `${failedFiles} failed | ` : ''}${passedFiles} passed (${files.length})`);
console.log(`      Tests  ${failures.length ? `${failures.length} failed | ` : ''}${tests - failures.length} passed (${tests})`);
process.exit(failures.length ? 1 : 0);

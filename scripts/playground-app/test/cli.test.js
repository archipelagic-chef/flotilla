import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { greet } from '../src/greeting.js';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('the CLI prints the greeting', async () => {
  const { stdout } = await run(process.execPath, [cli, 'Ada']);
  assert.equal(stdout, `${greet('Ada')}\n`);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { greet } from '../src/greeting.js';
import { createServer } from '../src/server.js';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('greet says hello with a comma', () => {
  assert.equal(greet('Ada'), 'Hello, Ada!');
});

test('greet says hello to the world by default', () => {
  assert.match(greet(), /world/);
});

test('the CLI prints the greeting', async () => {
  const { stdout } = await run(process.execPath, [cli, 'Ada']);
  assert.equal(stdout, `${greet('Ada')}\n`);
});

test('the server answers with the greeting', async (t) => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), `${greet('playground')}\n`);
});

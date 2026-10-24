import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { greet } from '../src/greeting.js';
import { createServer } from '../src/server.js';

test('the server answers with the greeting', async (t) => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), `${greet('playground')}\n`);
});

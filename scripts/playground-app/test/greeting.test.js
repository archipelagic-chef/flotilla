import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../src/greeting.js';

test('greet says hello with a comma', () => {
  assert.equal(greet('Ada'), 'Hello, Ada!');
});

test('greet says hello to the world by default', () => {
  assert.match(greet(), /world/);
});

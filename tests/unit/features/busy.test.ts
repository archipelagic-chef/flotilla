import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  buildOrTestRunning,
  transcriptBusy,
} from '../../../src/features/backlog/busy';
import {
  makeTempDir,
  removeDir,
} from '../../helpers/gitRepo';

/** A transcript line: an assistant's Bash call, or its result. */
const call = (id: string, command: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const result = (id: string) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const text = (t: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });

describe('whether an agent is building or testing', () => {
  it('is busy while a test run has no result yet', () => {
    expect(buildOrTestRunning([text('Running the tests.'), call('t1', 'npm test -- review')])).toBe(true);
  });

  it('is not busy once its result is in', () => {
    expect(buildOrTestRunning([call('t1', 'npx vitest run'), result('t1'), text('All green.')])).toBe(false);
  });

  it('is not busy for other commands', () => {
    expect(buildOrTestRunning([call('g1', 'git status'), call('l1', 'ls -la src')])).toBe(false);
  });

  it('recognizes the common build and test commands', () => {
    for (const command of ['npm run build', 'pnpm test', 'npx tsc --noEmit', 'cargo test', 'go build ./...', 'make test']) {
      expect(buildOrTestRunning([call('x', command)]), command).toBe(true);
    }
  });

  it('skips lines that do not parse', () => {
    expect(buildOrTestRunning(['not json', '', call('t1', 'npm test')])).toBe(true);
  });
});

describe('reading a transcript', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => removeDir(dir));

  it('reads the file and says whether a build or test is running', async () => {
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, [call('t1', 'npm run test'), result('t1'), call('t2', 'vitest run')].join('\n') + '\n');
    expect(await transcriptBusy(file)).toBe(true);
    fs.writeFileSync(file, [call('t1', 'npm run test'), result('t1')].join('\n') + '\n');
    expect(await transcriptBusy(file)).toBe(false);
  });

  it("is not busy when the transcript can't be read", async () => {
    expect(await transcriptBusy(path.join(dir, 'missing.jsonl'))).toBe(false);
  });
});

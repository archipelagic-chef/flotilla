import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { sendWindowRequest, takeWindowRequests } from '../../../src/features/workstreams/windowRequests';
import { makeTempDir, removeDir } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

describe('window requests', () => {
  it('hands a request to the window once, and drops stale or invalid ones', async () => {
    const gitDir = makeTempDir();
    cleanup.push(gitDir);
    await sendWindowRequest(gitDir, { type: 'openChat', sessionId: 'abc-123' });
    const dir = path.join(gitDir, 'flotilla', 'requests');
    fs.writeFileSync(path.join(dir, `${Date.now() - 180_000}-old.json`), JSON.stringify({ type: 'openChat', sessionId: 'old' }));
    fs.writeFileSync(path.join(dir, `${Date.now()}-bad.json`), JSON.stringify({ type: 'openChat', sessionId: '../x' }));
    expect(await takeWindowRequests(gitDir)).toEqual([{ type: 'openChat', sessionId: 'abc-123' }]);
    expect(await takeWindowRequests(gitDir)).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { classifyActivity, lastActivity } from '../../../src/features/workstreams/activity';
import {
  AGENT_STATUS_FILE,
  clearAgentStatus,
  parseAgentStatus,
  readAgentStatus,
} from '../../../src/features/workstreams/agentStatus';
import {
  deleteHeartbeat,
  envFromRemoteName,
  isAlive,
  isHeartbeatPath,
  readHeartbeat,
  writeHeartbeat,
} from '../../../src/features/workstreams/heartbeat';
import { makeTempDir, removeDir, writeFile } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));
const at = '2026-10-09T10:00:00.000Z';

describe('parseAgentStatus', () => {
  it('parses a valid status', () => {
    expect(parseAgentStatus(JSON.stringify({ state: 'waiting-for-input', message: ' Need approval ', updatedAt: at }))).toEqual({
      state: 'waiting-for-input',
      message: 'Need approval',
      updatedAt: new Date(at),
    });
  });

  it('accepts a UTF-8 BOM and CRLF line endings (Windows tools)', () => {
    const text = `﻿{\r\n  "state": "done",\r\n  "updatedAt": "${at}"\r\n}\r\n`;
    expect(parseAgentStatus(text)).toEqual({ state: 'done', message: undefined, updatedAt: new Date(at) });
  });

  it.each([
    'not json',
    '[]',
    JSON.stringify({ state: 'sleeping', updatedAt: at }),
    JSON.stringify({ state: 'done' }),
    JSON.stringify({ state: 'done', updatedAt: 'yesterday' }),
  ])('rejects %s', (text) => {
    expect(parseAgentStatus(text)).toBeUndefined();
  });

  it('reads, reports invalid files and clears', async () => {
    const dir = makeTempDir();
    cleanup.push(dir);
    expect(await readAgentStatus(dir)).toBeUndefined();
    writeFile(dir, AGENT_STATUS_FILE, 'garbage');
    const invalid: string[] = [];
    expect(await readAgentStatus(dir, (f) => invalid.push(f))).toBeUndefined();
    expect(invalid).toEqual([path.join(dir, AGENT_STATUS_FILE)]);
    writeFile(dir, AGENT_STATUS_FILE, JSON.stringify({ state: 'working', updatedAt: at }));
    expect((await readAgentStatus(dir))?.state).toBe('working');
    await clearAgentStatus(dir);
    expect(fs.existsSync(path.join(dir, AGENT_STATUS_FILE))).toBe(false);
  });
});

describe('heartbeat', () => {
  it('maps remote names to environments', () => {
    expect(envFromRemoteName('dev-container')).toBe('container');
    expect(envFromRemoteName('attached-container')).toBe('container');
    expect(envFromRemoteName(undefined)).toBe('host');
    expect(envFromRemoteName('wsl')).toBe('host');
  });

  it('recognises the heartbeat file and its temp files in watcher URI paths', () => {
    expect(isHeartbeatPath('/r/.git/worktrees/a/flotilla-window.json')).toBe(true);
    expect(isHeartbeatPath('/r/.git/worktrees/a/flotilla-window.json.4242.tmp')).toBe(true);
    expect(isHeartbeatPath('/c:/r/.git/flotilla-window.json.7.tmp')).toBe(true);
    expect(isHeartbeatPath('/r/.git/worktrees/a/workstream.json')).toBe(false);
    expect(isHeartbeatPath('/r/.git/worktrees/a/HEAD')).toBe(false);
    expect(isHeartbeatPath('/r/.git/worktrees/flotilla-window.json.d/HEAD')).toBe(false);
  });

  it('writes, reads, ages and deletes', async () => {
    const dir = makeTempDir();
    cleanup.push(dir);
    const now = new Date(at);
    await writeHeartbeat(dir, 'container', 'linux', now);
    const hb = await readHeartbeat(dir);
    expect(hb).toEqual({ env: 'container', os: 'linux', updatedAt: now });
    expect(isAlive(hb, new Date(now.getTime() + 90_000))).toBe(true);
    expect(isAlive(hb, new Date(now.getTime() + 90_001))).toBe(false);
    expect(isAlive(undefined, now)).toBe(false);
    await deleteHeartbeat(dir);
    expect(await readHeartbeat(dir)).toBeUndefined();
  });
});

describe('activity', () => {
  it('uses the newest mtime of changed files and logs/HEAD', async () => {
    const wt = makeTempDir();
    const gitDir = makeTempDir();
    cleanup.push(wt, gitDir);
    writeFile(gitDir, 'logs/HEAD', 'x');
    writeFile(wt, 'a.txt', 'a');
    const old = new Date('2026-01-01T00:00:00Z');
    const recent = new Date('2026-10-01T00:00:00Z');
    fs.utimesSync(path.join(gitDir, 'logs', 'HEAD'), old, old);
    fs.utimesSync(path.join(wt, 'a.txt'), recent, recent);
    expect((await lastActivity(wt, gitDir, ['a.txt', 'missing.txt']))?.getTime()).toBe(recent.getTime());
    expect((await lastActivity(wt, gitDir, []))?.getTime()).toBe(old.getTime());
    expect(await lastActivity(wt, makeTempDir(), [])).toBeUndefined();
  });

  it('classifies by age', () => {
    const now = new Date(at);
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
    expect(classifyActivity(minutesAgo(4), now, 5, 7)).toBe('active');
    expect(classifyActivity(minutesAgo(6), now, 5, 7)).toBe('idle');
    expect(classifyActivity(minutesAgo(7 * 24 * 60), now, 5, 7)).toBe('stale');
    expect(classifyActivity(undefined, now, 5, 7)).toBe('stale');
  });
});

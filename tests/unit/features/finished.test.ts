import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatBytes, freedBytes, removalDecision, removeTopLevelLinks, type RemovalInput } from '../../../src/features/storage/finished';
import { makeTempDir, removeDir, writeFile } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

const safe: RemovalInput = {
  status: 'done',
  proposed: false,
  isMain: false,
  reachable: true,
  openTicketOnBranch: false,
  kept: false,
  changedFiles: 0,
  agentRunning: false,
  windowOpen: false,
  recentlyActive: false,
};

describe('removalDecision', () => {
  it('removes a done ticket’s worktree nobody uses and nothing in it can be lost', () => {
    expect(removalDecision(safe)).toEqual({ action: 'remove' });
  });

  it.each([
    ['todo', { status: 'todo' as const }],
    ['doing', { status: 'doing' as const }],
    ['review', { status: 'review' as const }],
    ['a proposal', { proposed: true }],
    ['the main worktree', { isMain: true }],
  ])('leaves %s alone', (_, change) => {
    expect(removalDecision({ ...safe, ...change })).toEqual({ action: 'skip' });
  });

  it.each([
    [{ reachable: false }, "it isn't reachable from this environment"],
    [{ openTicketOnBranch: true }, "another ticket that isn't done works on its branch"],
    [{ kept: true }, 'you chose to keep it'],
  ])('leaves a done ticket’s worktree alone when %o, and says why', (change, reason) => {
    expect(removalDecision({ ...safe, ...change })).toEqual({ action: 'skip', reason });
  });

  it.each([
    [{ changedFiles: 1 }, 'it has 1 uncommitted or untracked file'],
    [{ changedFiles: 10 }, 'it has 10 uncommitted or untracked files'],
    [{ agentRunning: true }, 'an agent is still running in it'],
    [{ windowOpen: true }, "it's open in a window"],
    [{ recentlyActive: true }, 'its files changed in the last few minutes'],
  ])('asks when %o', (change, reason) => {
    expect(removalDecision({ ...safe, ...change })).toEqual({ action: 'ask', reason });
  });
});

describe('freedBytes', () => {
  it('counts files without other hard links, and doesn’t follow links', async () => {
    const dir = makeTempDir();
    const outside = makeTempDir();
    cleanup.push(dir, outside);
    writeFile(dir, 'a.txt', '12345');
    writeFile(dir, 'sub/b.txt', '123');
    writeFile(dir, 'shared.txt', '1234567890');
    fs.linkSync(path.join(dir, 'shared.txt'), path.join(outside, 'shared.txt'));
    writeFile(outside, 'big/c.txt', 'x'.repeat(1000));
    fs.symlinkSync(path.join(outside, 'big'), path.join(dir, 'link'), 'junction');

    expect(await freedBytes(dir)).toBe(8);
  });

  it('gives up past its time limit', async () => {
    const dir = makeTempDir();
    cleanup.push(dir);
    writeFile(dir, 'a.txt', 'x');
    expect(await freedBytes(dir, -1)).toBeUndefined();
  });
});

describe('removeTopLevelLinks', () => {
  it('removes links and junctions as links, never what they point to', async () => {
    const dir = makeTempDir();
    const outside = makeTempDir();
    cleanup.push(dir, outside);
    writeFile(outside, 'node_modules/pkg/index.js', 'x');
    writeFile(outside, 'file.txt', 'x');
    writeFile(dir, 'keep.txt', 'x');
    fs.symlinkSync(path.join(outside, 'node_modules'), path.join(dir, 'node_modules.bl6'), 'junction');
    try {
      fs.symlinkSync(path.join(outside, 'file.txt'), path.join(dir, 'file-link'), 'file');
    } catch {
      // Windows without the right to make file symlinks: the junction is what matters
    }

    const removed = await removeTopLevelLinks(dir);

    expect(removed).toContain('node_modules.bl6');
    expect(fs.readdirSync(dir)).toEqual(['keep.txt']);
    expect(fs.readFileSync(path.join(outside, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('x');
    expect(fs.existsSync(path.join(outside, 'file.txt'))).toBe(true);
  });
});

describe('formatBytes', () => {
  it.each([
    [512, '512 bytes'],
    [12 * 1024, '12 KB'],
    [248 * 1024 * 1024, '248 MB'],
    [3.14 * 1024 ** 3, '3.1 GB'],
  ])('%d is %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

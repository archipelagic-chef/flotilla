import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checksDetail,
  checksQuestion,
  mergePaused,
  parsePausedAll,
  PausedAllStore,
  pausedMessage,
  resumedMessage,
  resumeOrder,
} from '../../../src/features/backlog/pausedAll';

describe("Pause All's record (BL-160)", () => {
  it('is kept in .git/flotilla/, read by another store (a restart, another window), and cleared', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paused-all-'));
    const store = new PausedAllStore(dir);
    expect(store.held).toBe(false);
    await store.write({
      at: '2026-10-21T21:00:00Z',
      agents: [
        { id: 'BL-2', kind: 'agent', session: 's2' },
        { id: 'BL-1', kind: 'discussion' },
      ],
    });
    expect(fs.existsSync(path.join(dir, 'flotilla', 'paused-all.json'))).toBe(true);
    const other = new PausedAllStore(dir);
    expect(other.read()?.agents).toEqual([
      { id: 'BL-2', kind: 'agent', session: 's2' },
      { id: 'BL-1', kind: 'discussion' },
    ]);
    await other.clear();
    expect(store.held).toBe(false);
  });

  it('holds with an empty set when the file is not readable', () => {
    expect(parsePausedAll('not json')).toEqual({ at: '', agents: [] });
    expect(parsePausedAll('{"agents":[{"id":"BL-1","kind":"agent"},{"id":2},{"id":"BL-3","kind":"x"}]}').agents).toEqual([{ id: 'BL-1', kind: 'agent' }]);
  });

  it('resumes in the backlog order, adds a later Pause All to the set, and says what it did', () => {
    const items = [{ id: 'BL-3' }, { id: 'BL-1' }, { id: 'BL-2' }];
    const set = [
      { id: 'BL-1', kind: 'agent' as const },
      { id: 'BL-9', kind: 'agent' as const },
      { id: 'BL-3', kind: 'agent' as const },
    ];
    expect(resumeOrder(items, set).map((a) => a.id)).toEqual(['BL-3', 'BL-1', 'BL-9']);
    expect(
      mergePaused(
        [{ id: 'BL-1', kind: 'agent', session: 'a' }],
        [
          { id: 'BL-1', kind: 'agent', session: 'b' },
          { id: 'BL-2', kind: 'agent' },
        ],
      ),
    ).toEqual([
      { id: 'BL-1', kind: 'agent', session: 'b' },
      { id: 'BL-2', kind: 'agent' },
    ]);
    expect(pausedMessage(5, 0)).toBe('Paused 5 agents. Nothing new starts until Resume All.');
    expect(pausedMessage(1, 2)).toBe("Paused 1 agent. 2 agents in chats can't be paused: stop them there. Nothing new starts until Resume All.");
    expect(resumedMessage(4, 1)).toBe('Resumed 4; 1 waits for a slot.');
    expect(resumedMessage(3, 0)).toBe('Resumed 3.');
  });
});

describe("Pause All's question while merges' checks run (BL-164)", () => {
  it('names the tickets, and says what each answer does', () => {
    expect(checksQuestion(['BL-122'])).toBe("BL-122's merge checks are running.");
    expect(checksQuestion(['BL-1', 'BL-2', 'BL-3'])).toBe("BL-1's, BL-2's and BL-3's merge checks are running.");
    expect(checksDetail(['BL-122'])).toMatch(/Stop Them: the checks stop; it can merge again after/);
  });

  it('keeps a merge agent in the saved set', () => {
    expect(parsePausedAll('{"at":"x","agents":[{"id":"BL-1","kind":"merge","session":"s"}]}').agents).toEqual([{ id: 'BL-1', kind: 'merge', session: 's' }]);
  });
});

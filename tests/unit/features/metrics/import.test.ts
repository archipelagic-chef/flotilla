import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { conflictRegions, parseConflictRegions } from '../../../../src/core/git/conflictRegions';
import { parseTicket } from '../../../../src/features/backlog/ticket';
import { readEvents } from '../../../../src/features/metrics/events';
import { eventsFromTicket, historyImported, importHistory, replayMerges } from '../../../../src/features/metrics/import';
import { git, initRepo, makeTempDir, writeFile } from '../../../helpers/gitRepo';

const TICKET = `# A ticket

What to do.

## Activity

### 2026-10-20 09:00 · Flotilla
The autopilot moved it from **To Do** to **In Progress**.

The autopilot started branch \`feature/BL-7-x\` for it.

### 2026-10-20 09:00 · Flotilla
Autopilot: opened a chat for agent Nova-7 (opus) in worktree \`feature/BL-7-x\`. It works without a window and reports here.

### 2026-10-20 10:00 · Agent Ember-6
Looked at it.

Verdict: changes requested

### 2026-10-20 11:00 · Flotilla
The limit reset after 3 tries (since Tue 10:30 AM): resumed the chat for agent Nova-7 to go on.

### 2026-10-20 12:00 · You
Fine now.

Verdict: approved

### 2026-10-20 12:30 · Flotilla
Merging \`feature/BL-7-x\` into \`main\` stopped: the checks failed on the merge (\`npm test\`).

### 2026-10-20 13:00 · Flotilla
Merged it into **main** (abc1234).

Moved it from **In Review** to **Done**.
`;

/** A repository with one merge that conflicts (one region both sides only added to, one they both changed) and one that doesn't. */
function seeded(): string {
  const repo = initRepo();
  writeFile(repo, 'list.ts', 'a\nb\nc\n');
  writeFile(repo, 'other.ts', 'x\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'feature/BL-7-x');
  writeFile(repo, 'list.ts', 'A\nb\nc\nfrom branch\n');
  git(repo, 'commit', '-q', '-am', 'BL-7: branch');
  git(repo, 'checkout', '-q', 'main');
  writeFile(repo, 'list.ts', 'AA\nb\nc\nfrom main\n');
  git(repo, 'commit', '-q', '-am', 'main');
  try {
    git(repo, 'merge', '-q', '--no-edit', '-m', 'Merge BL-7: A ticket', 'feature/BL-7-x');
  } catch {
    // The conflict, resolved by hand.
  }
  writeFile(repo, 'list.ts', 'AA\nb\nc\nfrom main\nfrom branch\n');
  git(repo, 'commit', '-q', '-am', 'Merge BL-7: A ticket');
  git(repo, 'checkout', '-q', '-b', 'feature/BL-8-y');
  writeFile(repo, 'other.ts', 'y\n');
  git(repo, 'commit', '-q', '-am', 'BL-8');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '--no-edit', '-m', 'Merge BL-8: clean', 'feature/BL-8-y');
  return repo;
}

describe('conflict regions', () => {
  it('counts each region, and tells pure additions from changes', () => {
    const text = ['x', '<<<<<<< ours', 'a', 'b', '||||||| base', '=======', 'c', '>>>>>>> theirs', '<<<<<<< ours', 'd', '||||||| base', 'old', '=======', 'e', '>>>>>>> theirs'].join('\n');
    expect(parseConflictRegions(text)).toEqual([
      { lines: 3, additions: true },
      { lines: 2, additions: false },
    ]);
  });

  it('replays a merge in memory', async () => {
    const repo = seeded();
    const files = await conflictRegions(repo, 'main~2', 'feature/BL-7-x');
    expect(files).toEqual([{ file: 'list.ts', regions: [{ lines: 2, additions: false }, { lines: 2, additions: true }] }]);
  });
});

describe('the history read in', () => {
  it("reads a ticket's lane moves, agent starts, verdicts, limits and merges", () => {
    const events = eventsFromTicket('BL-7', parseTicket(TICKET));
    expect(events.map((e) => [e.kind, e.agent, e.data])).toEqual([
      ['ticket-moved', undefined, { from: 'todo', to: 'doing', by: 'Autopilot' }],
      ['agent-started', 'Nova-7', { role: 'work', session: '', model: 'opus' }],
      ['review-verdict', 'Ember-6', { verdict: 'changes', round: 1, by: 'Ember-6' }],
      ['agent-resumed', 'Nova-7', { role: 'work', session: '' }],
      ['limit-lifted', undefined, { tries: 3 }],
      ['review-verdict', undefined, { verdict: 'approved', round: 2, by: 'You' }],
      ['merge-checks-failed', undefined, { failure: 'other', tests: [] }],
      ['merge-landed', undefined, { into: 'main', commit: 'abc1234' }],
      ['ticket-moved', undefined, { from: 'review', to: 'done', by: 'Flotilla' }],
    ]);
    expect(events.every((e) => e.imported && e.ticket === 'BL-7')).toBe(true);
    expect(events[0].at).toBe(new Date(2026, 9, 20, 9, 0).toISOString());
  });

  it("replays the merges of git's history: those that conflicted, with their ticket", async () => {
    const repo = seeded();
    const events = await replayMerges(repo);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'merge-conflicted', ticket: 'BL-7', imported: true, data: { files: [{ file: 'list.ts' }] } });
  });

  it('reads it all in once, before recording started', async () => {
    const repo = seeded();
    const commonDir = path.join(repo, '.git');
    const tickets = [{ id: 'BL-7', ticket: parseTicket(TICKET) }];
    expect(historyImported(commonDir)).toBe(false);
    const n = await importHistory({ commonDir, mainRoot: repo, tickets, before: new Date(2026, 9, 20, 12, 0) });
    const events = await readEvents(commonDir);
    expect(events).toHaveLength(n!);
    // What happened from 12:00 on is recorded already, and so are the seeded merges (committed just now).
    expect(events.map((e) => e.kind)).toEqual(['ticket-moved', 'agent-started', 'review-verdict', 'agent-resumed', 'limit-lifted']);
    expect(historyImported(commonDir)).toBe(true);
    expect(await importHistory({ commonDir, mainRoot: repo, tickets })).toBeUndefined();
    expect(await readEvents(commonDir)).toHaveLength(n!);
  });

  it('reads in the replayed merges too', async () => {
    const repo = seeded();
    const commonDir = path.join(repo, '.git');
    await importHistory({ commonDir, mainRoot: repo, tickets: [] });
    expect((await readEvents(commonDir)).map((e) => e.kind)).toEqual(['merge-conflicted']);
    expect(fs.existsSync(path.join(commonDir, 'flotilla', 'metrics', 'imported'))).toBe(true);
  });
});

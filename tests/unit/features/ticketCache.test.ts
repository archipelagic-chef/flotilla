import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { movesSince, ticketCommits } from '../../../src/features/history/log';
import { LocalBacklog } from '../../../src/features/backlog/localBacklog';
import { git, initRepo, makeTempDir, removeDir, writeFile } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

function commit(repo: string, file: string, message: string): void {
  writeFile(repo, file, `${message}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', message);
}

describe('mention index', () => {
  it('reports the branches and commits that came in when a ref moved, and nothing otherwise', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    commit(repo, 'a.txt', 'BL-1 first');
    expect(await movesSince(repo)).toBeDefined();
    expect(await movesSince(repo)).toBeUndefined();

    git(repo, 'switch', '-q', '-c', 'side');
    commit(repo, 'b.txt', 'Also BL-1 on a branch');
    // Another ticket's view rebuilds the mention index first: a move must still be reported, once.
    await ticketCommits(repo, { branches: [], ids: ['BL-1'], limit: 50 });
    const moves = await movesSince(repo);
    expect(moves?.branches).toEqual(['side']);
    expect(moves?.commits.map((c) => c.subject)).toEqual(['Also BL-1 on a branch']);
    expect(await movesSince(repo)).toBeUndefined();
  });

  it('matches whole ids, case-insensitively, and only up to the limit', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    commit(repo, 'a.txt', 'bl-1 lower case');
    commit(repo, 'b.txt', 'BL-12 is another ticket');
    commit(repo, 'c.txt', 'BL-1 again');
    commit(repo, 'd.txt', 'BL-1 once more');
    const commits = await ticketCommits(repo, { branches: [], ids: ['BL-1'], limit: 2 });
    expect(commits).toHaveLength(2);
    expect(commits.every((c) => /^BL-1 /i.test(c.subject))).toBe(true);
  });
});

describe('cached ticket reads', () => {
  it('reads a ticket again only when its file changed, and after this process writes it', async () => {
    const dir = makeTempDir();
    cleanup.push(dir);
    const backlog = new LocalBacklog(dir, path.join(dir, '.git'));
    const item = { id: 'BL-1', title: 'First', notes: undefined };
    await backlog.writeTicket('BL-1', { title: 'First', description: 'One.', activity: [] });
    expect((await backlog.readTicketCached(item)).description).toBe('One.');

    // Another process writes the file: its size changes, so it's read again.
    fs.writeFileSync(backlog.docPath('BL-1'), '# First\n\nTwo, longer.\n');
    expect((await backlog.readTicketCached(item)).description).toBe('Two, longer.');

    // This process writes it: the cache is dropped even when nothing else changed.
    await backlog.writeTicket('BL-1', { title: 'First', description: 'Three.', activity: [] });
    expect((await backlog.readTicketCached(item)).description).toBe('Three.');
  });

  it('gives a ticket without a file its title and no activity', async () => {
    const dir = makeTempDir();
    cleanup.push(dir);
    const backlog = new LocalBacklog(dir, path.join(dir, '.git'));
    expect(await backlog.readTicketCached({ id: 'BL-2', title: 'Missing', notes: 'Notes.' })).toEqual({ title: 'Missing', description: 'Notes.', activity: [] });
  });
});

describe('backlog watch', () => {
  it('says which files changed', async () => {
    const dir = makeTempDir();
    cleanup.push(dir);
    fs.mkdirSync(path.join(dir, '.flotilla', 'backlog'), { recursive: true });
    const backlog = new LocalBacklog(dir, path.join(dir, '.git'));
    const seen: string[][] = [];
    const watch = backlog.watch((changed) => seen.push([...changed]));
    try {
      await new Promise((r) => setTimeout(r, 200));
      await backlog.writeTicket('BL-3', { title: 'Third', description: 'Changed.', activity: [] });
      const deadline = Date.now() + 5000;
      while (!seen.some((names) => names.includes('BL-3.md')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(seen.flat()).toContain('BL-3.md');
      expect(seen.flat()).not.toContain('BL-3.md.tmp');
    } finally {
      watch.dispose();
    }
  });
});

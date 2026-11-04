import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  commitChanges,
  ownCommits,
  readLog,
  ticketCommits,
} from '../../../src/features/history/log';
import {
  git,
  initRepo,
  makeTempDir,
  removeDir,
  writeFile,
} from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

function commit(repo: string, file: string, message: string): void {
  writeFile(repo, file, `${message}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', message);
}

describe('readLog', () => {
  it('pages through the history, newest first, with refs and multi-line messages', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    commit(repo, 'a.txt', 'first');
    commit(repo, 'b.txt', 'second');
    commit(repo, 'c.txt', 'third\n\nwith a body\nover two lines');
    git(repo, 'tag', 'v1');

    const page = await readLog(repo, { skip: 0, limit: 2, upstream: undefined, hasRemote: false });
    expect(page.more).toBe(true);
    expect(page.commits.map((c) => c.subject)).toEqual(['third', 'second']);
    expect(page.commits[0].body).toBe('with a body\nover two lines');
    expect(page.commits[0].refs).toEqual(expect.arrayContaining(['tag: v1']));
    expect(page.commits[0].refs.some((r) => r.startsWith('HEAD'))).toBe(false);
    expect(page.commits[0].hash).toMatch(/^[0-9a-f]{40}$/);
    expect(page.commits.every((c) => !c.outgoing)).toBe(true);

    const rest = await readLog(repo, { skip: 2, limit: 2, upstream: undefined, hasRemote: false });
    expect(rest.more).toBe(false);
    // initRepo makes the root commit.
    expect(rest.commits.map((c) => c.subject)).toEqual(['first', 'initial']);
    expect(rest.commits[0].parents).toHaveLength(1);
    expect(rest.commits[1].parents).toEqual([]);
  });

  it('marks the commits that are not on the upstream', async () => {
    const remote = makeTempDir();
    cleanup.push(remote);
    git(remote, 'init', '-q', '--bare');
    const repo = initRepo();
    cleanup.push(repo);
    commit(repo, 'a.txt', 'pushed');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', '-u', 'origin', 'HEAD');
    commit(repo, 'b.txt', 'local');

    const { commits } = await readLog(repo, { skip: 0, limit: 10, upstream: 'origin/x', hasRemote: true });
    expect(commits.map((c) => [c.subject, c.outgoing])).toEqual([
      ['local', true],
      ['pushed', false],
      ['initial', false],
    ]);
  });
});

describe('commitChanges', () => {
  it('lists what a commit changed, also for the first commit', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    commit(repo, 'a.txt', 'first');
    commit(repo, 'b.txt', 'second');
    const [second, first, root] = git(repo, 'rev-list', 'HEAD').trim().split('\n');

    const a = await commitChanges(repo, second);
    expect(a.changes).toEqual([{ path: 'b.txt', kind: 'added' }]);
    expect(a.parent).toBe(first);
    const b = await commitChanges(repo, first);
    expect(b.changes).toEqual([{ path: 'a.txt', kind: 'added' }]);
    // The root commit has no parent: everything in it is added.
    const c = await commitChanges(repo, root);
    expect(c.changes.length).toBeGreaterThan(0);
    expect(c.changes.every((x) => x.kind === 'added')).toBe(true);
  });
});

describe('ticketCommits', () => {
  it("finds a ticket's commits: on its branches past the base, and mentioning it anywhere", async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const main = git(repo, 'branch', '--show-current').trim();
    commit(repo, 'a.txt', 'Fix BL-12 on main');
    commit(repo, 'b.txt', 'Prepare ABC-7 on main');
    git(repo, 'switch', '-q', '-c', 'feature/BL-1-sso');
    commit(repo, 'c.txt', 'SAML flow');
    commit(repo, 'd.txt', 'Logout');
    git(repo, 'switch', '-q', main);
    const commits = await ticketCommits(repo, { branches: ['feature/BL-1-sso'], base: main, ids: ['BL-1', 'ABC-7'], limit: 50 });
    expect(commits.map((c) => [c.subject, c.branches])).toEqual([
      ['Logout', ['feature/BL-1-sso']],
      ['SAML flow', ['feature/BL-1-sso']],
      // "BL-12" isn't BL-1.
      ['Prepare ABC-7 on main', []],
    ]);
  });
});

describe('ownCommits (BL-275)', () => {
  const c = (subject: string, branches: string[]) => ({ subject, branches });
  const shared = new Set(['feature/storage-follow-ups']);

  it("keeps only the ticket's own commits on a branch other tickets share", () => {
    const commits = [
      c('BL-3: Keep the chats', ['feature/storage-follow-ups']),
      c('BL-4: Keep the notes', ['feature/storage-follow-ups']),
      c('BL-30: Not this one either', ['feature/storage-follow-ups']),
      c('Tidy up', ['feature/storage-follow-ups']),
    ];
    expect(ownCommits(commits, ['BL-3'], shared).map((x) => x.subject)).toEqual(['BL-3: Keep the chats']);
  });

  it('keeps every commit of a branch of its own, on a ticket with two branches too', () => {
    const commits = [c('Tidy up', ['feature/BL-3-a']), c('More', ['feature/BL-3-b']), c('BL-4: also here', ['feature/storage-follow-ups', 'feature/BL-3-a'])];
    expect(ownCommits(commits, ['BL-3'], shared)).toEqual(commits);
  });

  it('keeps the commits found by mentioning it (merged: on no branch anymore)', () => {
    const commits = [c('Merge BL-3', [])];
    expect(ownCommits(commits, ['BL-3'], shared)).toEqual(commits);
  });
});

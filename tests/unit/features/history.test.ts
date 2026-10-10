import { afterEach, describe, expect, it } from 'vitest';
import { commitChanges, readLog } from '../../../src/features/history/log';
import { git, initRepo, makeTempDir, removeDir, writeFile } from '../../helpers/gitRepo';

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

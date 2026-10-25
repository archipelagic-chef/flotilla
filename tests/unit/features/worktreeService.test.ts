import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { GitError } from '../../../src/core/git/gitCli';
import { locateRepo } from '../../../src/core/repoLocator';
import { WorktreeService } from '../../../src/features/worktrees/worktreeService';
import {
  expectSamePath,
  git,
  initRepo,
  makeTempDir,
  removeDir,
  simulateOtherEnvironment,
  symlinkedRepo,
  writeFile,
} from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

function service(repo: string, autoAdopt = true): WorktreeService {
  return new WorktreeService({ mainRoot: repo, commonDir: path.join(repo, '.git') }, () => ({ autoAdopt }));
}

describe('WorktreeService.create', () => {
  it('creates a portable worktree for a new branch under .worktrees', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const wt = await service(repo).create({ kind: 'new', branch: 'feature/login' });
    expectSamePath(wt.path, path.join(repo, '.worktrees', 'feature-login'));
    expect(wt).toMatchObject({ branch: 'feature/login', portable: true, insideRepo: true });
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('adds a suffix when the folder name is taken', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const s = service(repo);
    await s.create({ kind: 'new', branch: 'feat/a' });
    const second = await s.create({ kind: 'new', branch: 'feat-a' });
    expectSamePath(second.path, path.join(repo, '.worktrees', 'feat-a-2'));
  });

  it('creates from an existing local branch', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    git(repo, 'branch', 'existing');
    const wt = await service(repo).create({ kind: 'existing', branch: 'existing' });
    expect(wt.branch).toBe('existing');
  });

  it('creates a tracking branch from a remote branch', async () => {
    const repo = initRepo();
    const origin = makeTempDir();
    cleanup.push(repo, origin);
    git(origin, 'init', '-q', '--bare');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'checkout', '-q', '-b', 'remote-only');
    writeFile(repo, 'r.txt', 'r\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'remote work');
    git(repo, 'push', '-q', 'origin', 'remote-only');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'branch', '-q', '-D', 'remote-only');

    const s = service(repo);
    expect((await s.listBranches()).remote).toEqual(['origin/remote-only']);
    const wt = await s.create({ kind: 'remote', remoteRef: 'origin/remote-only' });
    expect(wt.branch).toBe('remote-only');
    expect(git(wt.path!, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/remote-only');
  });

  it.skipIf(process.platform === 'win32')('creates a working portable worktree when the repo is opened through a symlink', async () => {
    const { repo, linkedRepo, dirs } = symlinkedRepo();
    cleanup.push(...dirs);
    const roots = (await locateRepo(linkedRepo))!;
    const wt = await new WorktreeService(roots, () => ({ autoAdopt: true })).create({ kind: 'new', branch: 'feat' });
    expect(wt).toMatchObject({ path: path.join(repo, '.worktrees', 'feat'), portable: true });
    expect(fs.readFileSync(path.join(repo, '.worktrees', 'feat', '.git'), 'utf8')).toBe('gitdir: ../../.git/worktrees/feat\n');
    expect(git(path.join(linkedRepo, '.worktrees', 'feat'), 'status', '--porcelain')).toBe('');
  });

  it('works when the repo path has spaces and non-ASCII characters', async () => {
    const parent = makeTempDir();
    cleanup.push(parent);
    const repo = initRepo(path.join(parent, 'my repo ö'));
    const s = service(repo);
    const wt = await s.create({ kind: 'new', branch: 'feat/ö-test' });
    expectSamePath(wt.path, path.join(repo, '.worktrees', 'feat-ö-test'));
    expect(git(wt.path!, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/ö-test');
    await s.remove(wt, { force: false });
    expect(fs.existsSync(wt.path!)).toBe(false);
  });
});

describe('WorktreeService.list (adoption)', () => {
  it('auto-adopts plain worktrees inside the repo but never touches outside ones', async () => {
    const repo = initRepo();
    const outsideParent = makeTempDir();
    cleanup.push(repo, outsideParent);
    git(repo, 'worktree', 'add', '-b', 'in', path.join(repo, '.worktrees', 'in'));
    git(repo, 'worktree', 'add', '-b', 'out', path.join(outsideParent, 'out'));
    const outGitFile = fs.readFileSync(path.join(outsideParent, 'out', '.git'), 'utf8');

    const list = await service(repo).list();
    expect(list.find((w) => w.id === 'in')!.portable).toBe(true);
    expect(list.find((w) => w.id === 'out')!.portable).toBe(false);
    expect(fs.readFileSync(path.join(outsideParent, 'out', '.git'), 'utf8')).toBe(outGitFile);
  });

  it('reports a worktree that cannot be adopted and still lists the others', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    git(repo, 'worktree', 'add', '-b', 'stuck', path.join(repo, '.worktrees', 'stuck'));
    git(repo, 'worktree', 'add', '-b', 'fine', path.join(repo, '.worktrees', 'fine'));
    // A directory where the lock file goes makes lock() throw (EISDIR / EPERM).
    fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'stuck', 'locked'));
    const stuckGitFile = fs.readFileSync(path.join(repo, '.worktrees', 'stuck', '.git'), 'utf8');
    const errors: Array<[string | undefined, unknown]> = [];
    const s = new WorktreeService({ mainRoot: repo, commonDir: path.join(repo, '.git') }, () => ({
      autoAdopt: true,
      onAdoptError: (wt, error) => errors.push([wt.id, error]),
    }));

    const list = await s.list();
    expect(errors.map(([id]) => id)).toEqual(['stuck']);
    expect(errors[0][1]).toBeInstanceOf(Error);
    expect(list.find((w) => w.id === 'stuck')!.portable).toBe(false);
    expect(list.find((w) => w.id === 'fine')!.portable).toBe(true);
    expect(fs.readFileSync(path.join(repo, '.worktrees', 'stuck', '.git'), 'utf8')).toBe(stuckGitFile);
  });

  it('leaves worktrees alone when autoAdopt is off, and adopt() makes one portable', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    git(repo, 'worktree', 'add', '-b', 'in', path.join(repo, '.worktrees', 'in'));
    const s = service(repo, false);
    const wt = (await s.list()).find((w) => w.id === 'in')!;
    expect(wt.portable).toBe(false);
    await s.adopt(wt);
    expect((await s.list()).find((w) => w.id === 'in')!.portable).toBe(true);
  });
});

describe('WorktreeService leftovers', () => {
  it('removes a worktree whose ignored files have paths past 260 characters', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    writeFile(repo, '.gitignore', '.vscode-test/\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-q', '-m', 'ignore');
    const s = service(repo);
    const wt = await s.create({ kind: 'new', branch: 'feature/a-rather-long-branch-name-like-the-ones-tickets-get' });
    const deep = path.join(wt.path!, '.vscode-test', ...Array.from({ length: 12 }, (_, i) => `folder-number-${i}-of-a-deep-tree`));
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'file.txt'), 'x');
    expect(path.join(deep, 'file.txt').length).toBeGreaterThan(260);

    await s.remove(wt, { force: false });

    expect(fs.existsSync(wt.path!)).toBe(false);
    expect(await s.leftovers()).toEqual([]);
  });

  it('finds folders in .worktrees that are no worktree any more, and deletes them without following links', async () => {
    const repo = initRepo();
    const outside = makeTempDir();
    cleanup.push(repo, outside);
    writeFile(outside, 'node_modules/pkg/index.js', 'keep me');
    const s = service(repo);
    const live = await s.create({ kind: 'new', branch: 'live' });
    const left = path.join(repo, '.worktrees', 'half-removed');
    writeFile(left, '.vscode-test/big.bin', 'x');
    fs.mkdirSync(path.join(left, 'deep'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'node_modules'), path.join(left, 'deep', 'linked'), 'junction');
    const fresh = path.join(repo, '.worktrees', 'being-added');
    fs.mkdirSync(fresh);
    const later = Date.now() + 60 * 60_000;
    fs.utimesSync(fresh, new Date(later), new Date(later));

    const found = await s.leftovers(Date.now() + 11 * 60_000);
    expect(found.map((d) => path.basename(d))).toEqual(['half-removed']);
    expect(found.some((d) => path.basename(d) === path.basename(live.path!))).toBe(false);

    await expect(s.deleteLeftover(live.path!)).rejects.toThrow('not a leftover');
    fs.utimesSync(left, new Date(0), new Date(0));
    await s.deleteLeftover(left);

    expect(fs.existsSync(left)).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('keep me');
  });
});

describe('WorktreeService.remove', () => {
  it('removes an untracked link to a folder outside as a link, and keeps tracked links', async () => {
    const repo = initRepo();
    const outside = makeTempDir();
    cleanup.push(repo, outside);
    writeFile(outside, 'node_modules/pkg/index.js', 'keep me');
    const s = service(repo);
    const wt = await s.create({ kind: 'new', branch: 'feat' });
    fs.symlinkSync(path.join(outside, 'node_modules'), path.join(wt.path!, 'node_modules.bl6'), 'junction');

    expect((await s.removalRisks(wt)).changedFiles).toBe(0);
    writeFile(wt.path!, 'notes.txt', 'mine');
    expect((await s.removalRisks(wt)).changedFiles).toBe(1);

    await s.remove(wt, { force: true });

    expect(fs.existsSync(wt.path!)).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('keep me');
  });

  it('reports risks and refuses to remove a dirty worktree without force', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const s = service(repo);
    const wt = await s.create({ kind: 'new', branch: 'feat' });
    writeFile(wt.path!, 'README.md', 'changed\n');
    writeFile(wt.path!, 'new.txt', 'x\n');
    git(wt.path!, 'commit', '-q', '-am', 'branch-only commit');
    writeFile(wt.path!, 'README.md', 'dirty\n');

    expect(await s.removalRisks(wt)).toEqual({ changedFiles: 2, unmergedCommits: 1, halfRemoved: false });
    await expect(s.remove(wt, { force: false })).rejects.toBeInstanceOf(GitError);
    expect((await s.list()).find((w) => w.id === wt.id)!.locked).toBe(true);

    await s.remove(wt, { force: true });
    expect(fs.existsSync(wt.path!)).toBe(false);
    expect(fs.existsSync(wt.adminDir)).toBe(false);
    await s.deleteBranch('feat', true);
    expect(git(repo, 'branch', '--list', 'feat')).toBe('');
  });

  /** A worktree whose branch ignores node_modules/, with files in it, and some tracked files. */
  async function withNodeModules() {
    const repo = initRepo();
    cleanup.push(repo);
    writeFile(repo, '.gitignore', 'node_modules/\n.playground/\n');
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'src/d.ts']) writeFile(repo, name, `${name}\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'files');
    const s = service(repo);
    const wt = await s.create({ kind: 'new', branch: 'feat' });
    for (let i = 0; i < 20; i++) writeFile(wt.path!, `node_modules/pkg${i}/index.js`, 'x');
    writeFile(wt.path!, '.playground/state.json', '{}');
    return { repo, s, wt };
  }

  /** What a `git worktree remove` stopped partway leaves: the first files deleted, .gitignore among them. */
  const stopHalfway = (dir: string) => ['.gitignore', 'README.md', 'a.txt', 'b.txt'].forEach((f) => fs.rmSync(path.join(dir, f), { force: true }));

  it('deletes ignored folders before git, and deletes nothing when it refuses a worktree with changes', async () => {
    const { s, wt } = await withNodeModules();
    writeFile(wt.path!, 'a.txt', 'mine\n');
    await expect(s.remove(wt, { force: false })).rejects.toBeInstanceOf(GitError);
    expect(fs.existsSync(path.join(wt.path!, 'node_modules', 'pkg0', 'index.js'))).toBe(true);

    git(wt.path!, 'checkout', '--', 'a.txt');
    await s.remove(wt, { force: false });
    expect(fs.existsSync(wt.path!)).toBe(false);
  });

  it('finds a removal that stopped halfway and finishes it, ignoring as the branch does', async () => {
    const { s, wt } = await withNodeModules();
    stopHalfway(wt.path!);

    expect(await s.removalRisks(wt)).toMatchObject({ halfRemoved: true });
    await s.remove(wt, { force: true });
    expect(fs.existsSync(wt.path!)).toBe(false);
    expect(fs.existsSync(wt.adminDir)).toBe(false);
  });

  it('doesn’t take a half-deleted worktree with a real change for a removal that stopped halfway', async () => {
    const modified = await withNodeModules();
    stopHalfway(modified.wt.path!);
    writeFile(modified.wt.path!, 'c.txt', 'mine\n');
    expect(await modified.s.removalRisks(modified.wt)).toMatchObject({ halfRemoved: false });

    const added = await withNodeModules();
    stopHalfway(added.wt.path!);
    writeFile(added.wt.path!, 'notes.txt', 'mine\n');
    expect(await added.s.removalRisks(added.wt)).toMatchObject({ halfRemoved: false });

    const staged = await withNodeModules();
    stopHalfway(staged.wt.path!);
    writeFile(staged.wt.path!, 'src/e.ts', 'new\n');
    git(staged.wt.path!, 'add', 'src/e.ts');
    expect(await staged.s.removalRisks(staged.wt)).toMatchObject({ halfRemoved: false });
  });

  it('removes a worktree from the other environment', async () => {
    const repo = initRepo();
    const created = await service(repo).create({ kind: 'new', branch: 'feat' });
    expect(created.portable).toBe(true);
    const other = simulateOtherEnvironment(repo);
    cleanup.push(other, `${repo}-gone`);
    const s = service(other);
    const wt = (await s.list()).find((w) => w.branch === 'feat')!;
    expectSamePath(wt.path, path.join(other, '.worktrees', 'feat'));
    await s.remove(wt, { force: false });
    expect(fs.existsSync(path.join(other, '.worktrees', 'feat'))).toBe(false);
  });

  it('forgets an unreachable worktree whose folder was deleted by hand', async () => {
    const repo = initRepo();
    const outsideParent = makeTempDir();
    cleanup.push(repo, outsideParent);
    const dir = path.join(outsideParent, 'gone');
    git(repo, 'worktree', 'add', '-b', 'gone', dir);
    git(repo, 'worktree', 'lock', dir);
    removeDir(dir);
    const s = service(repo);
    const wt = (await s.list()).find((w) => w.branch === 'gone')!;
    expect(wt.path).toBeUndefined();
    await s.forget(wt);
    expect((await s.list()).some((w) => w.branch === 'gone')).toBe(false);
    await expect(s.forget((await s.list())[0])).rejects.toThrow(/unreachable/);
  });
});

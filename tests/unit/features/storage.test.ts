import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { runGit } from '../../../src/core/git/gitCli';
import {
  cleanUpInProgress,
  LOOSE_OBJECT_LIMIT,
  needsPacking,
  packRepository,
  parseLooseCount,
} from '../../../src/features/storage/packing';
import {
  fsTypeOf,
  medianMs,
  type MountEntry,
  parseMountInfo,
  probeReadMs,
  slowStorageText,
  storageReport,
} from '../../../src/features/storage/storage';
import {
  git,
  initRepo,
  removeDir,
  writeFile,
} from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

const mountinfo = [
  '25 1 0:22 / / rw,relatime shared:1 - overlay overlay rw,lowerdir=/var/lib/docker',
  '40 25 0:50 / /workspaces/worktree_extension rw,dirsync shared:2 - 9p C:\\ rw,aname=drvfs',
  '41 25 8:1 / /home/node/My\\040Files rw - ext4 /dev/sda1 rw',
  '42 25 0:51 / /workspaces/worktree_extension/node_modules rw - ext4 /dev/sdb1 rw',
].join('\n');

describe('parseMountInfo', () => {
  it('reads each mount point and filesystem type, undoing octal escapes', () => {
    const mounts = parseMountInfo(mountinfo);
    expect(mounts).toEqual([
      { mountPoint: '/', fsType: 'overlay' },
      { mountPoint: '/workspaces/worktree_extension', fsType: '9p' },
      { mountPoint: '/home/node/My Files', fsType: 'ext4' },
      { mountPoint: '/workspaces/worktree_extension/node_modules', fsType: 'ext4' },
    ]);
  });

  it('skips lines it cannot read', () => {
    expect(parseMountInfo('garbage\n\n12 3 4')).toEqual([]);
  });
});

describe('fsTypeOf', () => {
  const mounts: MountEntry[] = parseMountInfo(mountinfo);

  it('takes the longest mount point that holds the directory', () => {
    expect(fsTypeOf(mounts, '/workspaces/worktree_extension/.worktrees/x')).toBe('9p');
    expect(fsTypeOf(mounts, '/workspaces/worktree_extension/node_modules/vitest')).toBe('ext4');
    expect(fsTypeOf(mounts, '/srv/data')).toBe('overlay');
  });

  it('does not match a sibling that only shares a prefix', () => {
    expect(fsTypeOf(mounts, '/workspaces/worktree_extension2')).toBe('overlay');
  });

  it('is undefined with no mounts', () => {
    expect(fsTypeOf([], '/workspaces/x')).toBeUndefined();
  });
});

describe('storageReport', () => {
  const dir = '/workspaces/worktree_extension/.worktrees/feature-BL-48';
  const mounts = parseMountInfo(mountinfo);

  it('is slow on a share, by its filesystem type, without measuring', () => {
    const probe = vi.fn(() => 0.01);
    expect(storageReport({ dir, mounts, probe })).toEqual({ slow: true, fsType: '9p' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('is local on a local filesystem', () => {
    expect(storageReport({ dir: '/home/node/repo', mounts, probe: () => 50 })).toEqual({ slow: false, fsType: 'overlay' });
  });

  it('measures reads where the mount table can not say (no mounts)', () => {
    expect(storageReport({ dir, mounts: undefined, probe: () => 4.2 })).toEqual({ slow: true, readMs: 4.2 });
    expect(storageReport({ dir, mounts: undefined, probe: () => 0.05 })).toEqual({ slow: false, readMs: 0.05 });
    expect(storageReport({ dir, mounts: undefined, probe: () => undefined })).toEqual({ slow: false, readMs: undefined });
  });
});

describe('slowStorageText', () => {
  it('says why and how to fix it, and never includes a local path', () => {
    const text = slowStorageText({ slow: true, fsType: '9p' });
    expect(text.message).toContain('9p');
    expect(text.fix).toMatch(/container volume/);
    expect(`${text.message} ${text.fix}`).not.toMatch(/\/|C:\\/);
  });

  it('describes measured reads without a file system name', () => {
    const text = slowStorageText({ slow: true, readMs: 3.14 });
    expect(text.message).toContain('3.1 ms');
    expect(`${text.message} ${text.fix}`).not.toMatch(/\/home|\/workspaces|C:\\/);
  });
});

describe('medianMs', () => {
  it('is the middle sample, and undefined with none', () => {
    expect(medianMs([5, 1, 3])).toBe(3);
    expect(medianMs([])).toBeUndefined();
  });
});

describe('probeReadMs', () => {
  it('times the repository’s own files', () => {
    const repo = initRepo();
    cleanup.push(repo);
    const ms = probeReadMs(`${repo}/.git`);
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(probeReadMs(`${repo}/no-such-git-dir`)).toBeUndefined();
  });
});

describe('packing', () => {
  it('reads the loose object count from count-objects', () => {
    expect(parseLooseCount('count: 3241\nsize: 1024\nin-pack: 0\npacks: 0\n')).toBe(3241);
    expect(parseLooseCount('')).toBe(0);
  });

  it('packs only past the limit', () => {
    expect(needsPacking(LOOSE_OBJECT_LIMIT)).toBe(false);
    expect(needsPacking(LOOSE_OBJECT_LIMIT + 1)).toBe(true);
  });

  it('waits while a history clean-up is in progress', () => {
    expect(cleanUpInProgress([{}, {}])).toBe(false);
    expect(cleanUpInProgress([{}, { rewrite: { branch: 'b' } }])).toBe(true);
  });

  it('counts the loose objects of a real repository, and packs it', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    writeFile(repo, 'a.txt', 'one\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'one');
    expect(parseLooseCount(await runGit(['count-objects', '-v'], { cwd: repo }))).toBeGreaterThan(0);

    expect(await packRepository(repo)).toBe(0);
    expect(parseLooseCount(await runGit(['count-objects', '-v'], { cwd: repo }))).toBe(0);
  });
});

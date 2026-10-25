import * as os from 'node:os';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  GitError,
  gitProcesses,
  runGit,
  runGitBytes,
} from '../../../src/core/git/gitCli';
import { setSpawnOnMainThread, spawnProcess } from '../../../src/core/git/gitSpawner';

const options = { cwd: os.tmpdir(), encoding: 'utf8' as const };

afterEach(() => setSpawnOnMainThread(false));

describe.each([
  ['on the worker thread', false],
  ['on the main thread', true],
])('spawnProcess %s', (_, onMain) => {
  it('gives the output, the input and the exit code as execFile does', async () => {
    setSpawnOnMainThread(onMain);
    expect(await spawnProcess({ file: 'git', args: ['--version'], options })).toMatchObject({
      error: undefined,
      stdout: expect.stringMatching(/^git version/),
    });
    const hashed = await spawnProcess({ file: 'git', args: ['hash-object', '--stdin'], options, input: 'hello\n' });
    expect(hashed.stdout.toString().trim()).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    const failed = await spawnProcess({ file: 'git', args: ['no-such-command'], options });
    expect(failed.error?.code).toBe(1);
    expect(failed.stderr.toString()).toMatch(/not a git command/);
  });

  it('gives Buffers for binary output, and the error of a program that is missing', async () => {
    setSpawnOnMainThread(onMain);
    const bytes = await spawnProcess({ file: 'git', args: ['hash-object', '--stdin'], options: { ...options, encoding: 'buffer' }, input: 'x' });
    expect(Buffer.isBuffer(bytes.stdout)).toBe(true);
    expect((await spawnProcess({ file: 'no-such-program-bl165', args: [], options })).error?.code).toBe('ENOENT');
  });
});

describe('runGit on the worker thread', () => {
  it('runs many processes at once, counts them, and fails as before', async () => {
    gitProcesses.peak = 0;
    const outs = await Promise.all(Array.from({ length: 20 }, () => runGit(['--version'], { cwd: os.tmpdir() })));
    expect(outs.every((o) => o.startsWith('git version'))).toBe(true);
    expect(gitProcesses.peak).toBeGreaterThan(1);
    expect(gitProcesses.running).toBe(0);
    expect(Buffer.isBuffer(await runGitBytes(['--version'], { cwd: os.tmpdir() }))).toBe(true);
    await expect(runGit(['rev-parse', 'HEAD'], { cwd: os.tmpdir() })).rejects.toBeInstanceOf(GitError);
  });
});

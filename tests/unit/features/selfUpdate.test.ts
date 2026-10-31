import * as path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { runGit } from '../../../src/core/git/gitCli';
import {
  agentsPhrase,
  describeBuild,
  isFlotillaRepo,
  mergesLabel,
  mergesSince,
  parseBuildStamp,
} from '../../../src/features/selfUpdate';
import {
  outFile,
  SHIPPED,
  stagedManifest,
} from '../../../scripts/package.mjs';
import {
  git,
  initRepo,
  removeDir,
  writeFile,
} from '../../helpers/gitRepo';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(removeDir));

describe('parseBuildStamp', () => {
  it('reads the commit, whether it was dirty, and when it was built', () => {
    expect(parseBuildStamp('{"commit":"814b863a17bea13fdad3f27836dc4ec99cbaf033","dirty":true,"builtAt":"2026-10-20T16:15:00.000Z"}')).toEqual({
      commit: '814b863a17bea13fdad3f27836dc4ec99cbaf033',
      dirty: true,
      builtAt: '2026-10-20T16:15:00.000Z',
    });
  });
  it('has nothing without a commit, or for text that is not a stamp', () => {
    expect(parseBuildStamp(undefined)).toBeUndefined();
    expect(parseBuildStamp('{"builtAt":"2026-10-20T16:15:00.000Z"}')).toBeUndefined();
    expect(parseBuildStamp('{"commit":"--all"}')).toBeUndefined();
    expect(parseBuildStamp('not json')).toBeUndefined();
  });
});

describe('isFlotillaRepo', () => {
  it('is Flotilla only when package.json names it flotilla', () => {
    expect(isFlotillaRepo('{"name":"flotilla","version":"0.2.0"}')).toBe(true);
    expect(isFlotillaRepo('{"name":"my-app"}')).toBe(false);
    expect(isFlotillaRepo('{"name":"@scope/flotilla"}')).toBe(false);
    expect(isFlotillaRepo(undefined)).toBe(false);
    expect(isFlotillaRepo('{')).toBe(false);
  });
});

describe('mergesSince', () => {
  const gitIn = (repo: string) => (args: string[]) => runGit(args, { cwd: repo });

  it("counts main's merges after the build's commit, one per merge however many commits it brought", async () => {
    const repo = initRepo();
    dirs.push(repo);
    const built = git(repo, 'rev-parse', 'HEAD').trim();
    for (const ticket of ['a', 'b']) {
      git(repo, 'checkout', '-q', '-b', ticket);
      writeFile(repo, `${ticket}1.txt`, '1');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', `${ticket} 1`);
      writeFile(repo, `${ticket}2.txt`, '2');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', `${ticket} 2`);
      git(repo, 'checkout', '-q', 'main');
      git(repo, 'merge', '-q', '--no-ff', '-m', `Merge ${ticket}`, ticket);
    }
    expect(await mergesSince(gitIn(repo), built, 'main')).toBe(2);
    expect(await mergesSince(gitIn(repo), git(repo, 'rev-parse', 'HEAD').trim(), 'main')).toBe(0);
  });

  it("can't tell for a commit this repository doesn't have, or a base it doesn't", async () => {
    const repo = initRepo();
    dirs.push(repo);
    expect(await mergesSince(gitIn(repo), 'ffffffffffffffffffffffffffffffffffffffff', 'main')).toBeUndefined();
    expect(await mergesSince(gitIn(repo), git(repo, 'rev-parse', 'HEAD').trim(), 'trunk')).toBeUndefined();
  });
});

describe('labels', () => {
  it('says the merges, the build and the agents', () => {
    expect(mergesLabel(1)).toBe('1 merge');
    expect(mergesLabel(10)).toBe('10 merges');
    expect(describeBuild('0.2.0', { commit: '814b863a17bea13f', dirty: false, builtAt: 'x' }, () => 'Oct 20')).toBe(
      'Flotilla 0.2.0, built from 814b863 on Oct 20',
    );
    expect(describeBuild('0.2.0', { commit: '814b863a17bea13f', dirty: true })).toBe('Flotilla 0.2.0, built from 814b863 with uncommitted changes');
    expect(describeBuild('0.2.0', undefined)).toBe("Flotilla 0.2.0 (its commit isn't recorded)");
    expect(agentsPhrase(['Byte-7'])).toBe('Byte-7');
    expect(agentsPhrase(['Byte-7', 'Nova-2', 'Flux-1'])).toBe('Byte-7, Nova-2 and Flux-1');
    expect(agentsPhrase(['A', 'B', 'C', 'D', 'E'])).toBe('A, B and 3 more');
  });
});

describe('scripts/package.mjs', () => {
  it('packages a manifest without the prepublish build, which already ran', () => {
    const staged = stagedManifest({ name: 'flotilla', scripts: { build: 'node esbuild.mjs', 'vscode:prepublish': 'npm run build' } });
    expect(staged.scripts).toEqual({ build: 'node esbuild.mjs' });
    expect(SHIPPED).toEqual(expect.arrayContaining(['package.json', '.vscodeignore', 'dist', 'media']));
  });
  it('writes to --out, or <name>-<version>.vsix in the repository', () => {
    const m = { name: 'flotilla', version: '0.2.0' };
    expect(outFile(['--out', 'x.vsix'], '/repo', m, '/tmp')).toBe(path.resolve('/tmp', 'x.vsix'));
    expect(outFile([], '/repo', m)).toBe(path.join('/repo', 'flotilla-0.2.0.vsix'));
  });
});

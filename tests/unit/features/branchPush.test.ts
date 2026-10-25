import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  branchFilterWhy,
  isLocalUrl,
  pushBranch,
  pushHint,
  pushNote,
  pushOnApproval,
  pushTrigger,
  runsOnPush,
  withoutCredentials,
} from '../../../src/features/backlog/branchPush';
import {
  git,
  initRepo,
  makeTempDir,
  removeDir,
  writeFile,
} from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

const BRANCH = 'feature/BL-1-x';

describe('which workflows run on push', () => {
  it('reads the on: trigger, inline or as a block', () => {
    expect(runsOnPush('on: push\njobs: {}')).toBe(true);
    expect(runsOnPush('on: [pull_request, push]\n')).toBe(true);
    expect(runsOnPush('"on":\n  push:\n    branches: [main]\n  pull_request:\n')).toBe(true);
    expect(runsOnPush('on:\n  - push\n')).toBe(true);
    expect(runsOnPush('on:\n  pull_request:\n  workflow_dispatch:\njobs:\n  push:\n')).toBe(false);
    expect(runsOnPush('on: pull_request # push\n')).toBe(false);
    expect(runsOnPush('name: x\n')).toBe(false);
  });

  it("reads the push trigger's branch filters, as GitHub does", () => {
    const train = 'flotilla/merge-queue/BL-1';
    const on = (push: string) => `on:\n  pull_request:\n  push:\n${push}jobs:\n  build: {}\n`;
    expect(runsOnPush('on: [push]\n', train)).toBe(true);
    expect(runsOnPush(on(''), train)).toBe(true);
    expect(runsOnPush(on('    branches: [main, "feature/**"]\n'), train)).toBe(false);
    expect(runsOnPush(on('    branches: [main, "feature/**"]\n'), 'feature/BL-1-x')).toBe(true);
    expect(runsOnPush(on('    branches: [main, feature/*]\n'), 'feature/a/b')).toBe(false); // * stays within a /
    expect(runsOnPush(on('    branches:\n      - main\n      - flotilla/** # the train\n'), train)).toBe(true);
    expect(runsOnPush(on("    branches: ['**', '!flotilla/**']\n"), train)).toBe(false);
    expect(runsOnPush(on("    branches: ['**', '!flotilla/**', 'flotilla/merge-queue/*']\n"), train)).toBe(true);
    expect(runsOnPush(on('    branches-ignore: [flotilla/**]\n'), train)).toBe(false);
    expect(runsOnPush(on('    branches-ignore: [gh-pages]\n'), train)).toBe(true);
    expect(runsOnPush(on("    tags: ['v*']\n"), train)).toBe(false); // tags only: no branch runs it
    expect(runsOnPush(on("    tags: ['v*']\n    paths: [src/**]\n"), train)).toBe(false);
    expect(runsOnPush(on('    paths: [src/**]\n'), train)).toBe(true);
    expect(pushTrigger(on('    branches: [main]\n    tags-ignore: [x]\n'))).toEqual({ branches: ['main'], 'tags-ignore': ['x'] });
    expect(branchFilterWhy({ branches: ['main'] }, train)).toBe('branches: main');
  });
});

describe('pushing an approved branch to origin', () => {
  let repo: string;
  let origin: string;

  const commit = (content: string, ...config: string[]) => {
    writeFile(repo, 'a.txt', content);
    git(repo, 'add', '.');
    git(repo, ...config, 'commit', '-q', '-m', `BL-1: ${content}`);
    return git(repo, 'rev-parse', 'HEAD');
  };

  beforeEach(() => {
    repo = initRepo();
    origin = makeTempDir();
    cleanup.push(repo, origin);
    git(origin, 'init', '-q', '--bare');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'checkout', '-q', '-b', BRANCH);
  });

  it('pushes the branch and sets its upstream; then it is up to date', async () => {
    const tip = commit('one');
    const r = await pushBranch(repo, BRANCH);
    expect(r).toEqual({ kind: 'pushed', branch: BRANCH, commit: tip, count: 1 });
    expect(git(origin, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(tip);
    expect(git(repo, 'rev-parse', '--abbrev-ref', `${BRANCH}@{upstream}`)).toBe(`origin/${BRANCH}`);
    expect(pushNote(r)).toBe(`Pushed \`${BRANCH}\` to origin at \`${tip.slice(0, 7)}\` (1 new commit), so CI runs on it.`);
    expect(await pushBranch(repo, BRANCH)).toEqual({ kind: 'up-to-date', branch: BRANCH, commit: tip });
    expect(pushNote({ kind: 'up-to-date', branch: BRANCH, commit: tip })).toBeUndefined();
  });

  it('stops at a commit with another identity, and names it', async () => {
    commit('one');
    const stranger = commit('two', '-c', 'user.name=Someone', '-c', 'user.email=someone@example.com');
    const r = await pushBranch(repo, BRANCH);
    expect(r.kind).toBe('identity');
    expect(git(origin, 'branch', '--list', BRANCH)).toBe('');
    const note = pushNote(r)!;
    expect(note).toContain("another identity than the repository's (`Test <test@example.com>`)");
    expect(note).toContain(`\`${stranger.slice(0, 7)}\` BL-1: two: author \`Someone <someone@example.com>\``);
  });

  it('checks only the commits origin lacks, by author and committer', async () => {
    // Someone else's commit origin has already isn't Flotilla's to check.
    commit('one', '-c', 'user.name=Someone', '-c', 'user.email=someone@example.com');
    git(repo, 'push', '-q', 'origin', BRANCH);
    commit('two');
    expect((await pushBranch(repo, BRANCH)).kind).toBe('pushed');
    commit('three');
    git(repo, '-c', 'user.name=Other', '-c', 'user.email=o@example.com', 'commit', '-q', '--amend', '--no-edit');
    const r = await pushBranch(repo, BRANCH);
    expect(r).toMatchObject({
      kind: 'identity',
      strangers: [{ subject: 'BL-1: three', author: 'Test <test@example.com>', committer: 'Other <o@example.com>' }],
    });
    expect(pushNote(r)).toContain('author `Test <test@example.com>`, committer `Other <o@example.com>`');
  });

  it("never force-pushes: a branch that left origin's history isn't pushed", async () => {
    commit('one');
    git(repo, 'push', '-q', 'origin', BRANCH);
    const remote = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'reset', '-q', '--hard', 'main');
    commit('rewritten');
    const r = await pushBranch(repo, BRANCH);
    expect(r).toMatchObject({ kind: 'force', remoteCommit: remote });
    expect(git(origin, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(remote);
    expect(pushNote(r)).toContain('would take a force push, which Flotilla never does');
  });

  it('pushes a branch rewritten over its own last push with --force-with-lease (BL-181)', async () => {
    commit('one');
    const first = await pushBranch(repo, BRANCH);
    expect(first.kind).toBe('pushed');
    git(repo, 'reset', '-q', '--hard', 'main');
    commit('rewritten');
    const tip = git(repo, 'rev-parse', 'HEAD');
    const r = await pushBranch(repo, BRANCH, { leased: first.commit });
    expect(r).toMatchObject({ kind: 'pushed', rewritten: true, commit: tip });
    expect(git(origin, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(tip);
    expect(pushNote(r)).toContain('--force-with-lease');
    // Someone pushed over it since: not forced.
    git(repo, 'reset', '-q', '--hard', 'main');
    commit('again');
    expect((await pushBranch(repo, BRANCH, { leased: first.commit })).kind).toBe('force');
    expect(git(origin, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(tip);
  });

  it('notes a failed push with what to do', async () => {
    commit('one');
    git(repo, 'remote', 'set-url', 'origin', `${origin}-gone`);
    const r = await pushBranch(repo, BRANCH);
    expect(r.kind).toBe('failed');
    expect(pushNote(r)).toMatch(/^Couldn't push `feature\/BL-1-x` to origin: Fetching origin failed/);
    expect(pushNote(r)).toContain('Merge to main runs the checks locally.');
    git(repo, 'remote', 'remove', 'origin');
    expect(pushNote(await pushBranch(repo, BRANCH))).toContain('no `origin` remote');
  });

  it('tells a local origin from one on the network', () => {
    for (const u of [
      '/tmp/origin.git',
      '../origin',
      'C:\\repos\\app.git',
      'C:/repos/app.git',
      'file:///tmp/o.git',
      '/x/.git/origin/github.com/playground/app.git',
    ])
      expect(isLocalUrl(u), u).toBe(true);
    for (const u of ['', 'https://github.com/o/r.git', 'ssh://git@host/r.git', 'git@github.com:o/r.git', 'host:repo.git']) expect(isLocalUrl(u), u).toBe(false);
  });

  it('hints at signing in, the network or a rejection', () => {
    expect(pushHint("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toContain('Sign in');
    expect(pushHint('fatal: unable to access: Could not resolve host: github.com')).toContain('network');
    expect(pushHint('! [rejected] x -> x (fetch first)')).toContain('never force');
  });
});

describe('the pushOnApproval setting', () => {
  let repo: string;
  beforeEach(() => {
    repo = initRepo();
    cleanup.push(repo);
  });

  it('off never pushes; on pushes to any origin; auto wants GitHub and a workflow on push', async () => {
    expect(await pushOnApproval(repo, 'on')).toBe(false); // no origin
    git(repo, 'remote', 'add', 'origin', '/somewhere/else.git');
    expect(await pushOnApproval(repo, 'on')).toBe(true);
    expect(await pushOnApproval(repo, 'off')).toBe(false);
    expect(await pushOnApproval(repo, 'auto')).toBe(false);
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
    expect(await pushOnApproval(repo, 'auto')).toBe(false); // no workflow
    writeFile(repo, '.github/workflows/ci.yml', 'on:\n  pull_request:\n');
    expect(await pushOnApproval(repo, 'auto')).toBe(false);
    writeFile(repo, '.github/workflows/push.yaml', 'on: [push]\n');
    expect(await pushOnApproval(repo, 'auto')).toBe(true);
    expect(await pushOnApproval(repo, 'off')).toBe(false);
  });
});

describe("git's output, for the output channel and the ticket", () => {
  it('drops the user and password of URLs, and GitHub tokens', () => {
    expect(withoutCredentials("fatal: unable to access 'https://x-access-token:secret@github.com/o/r.git/'")).toBe(
      "fatal: unable to access 'https://***@github.com/o/r.git/'",
    );
    expect(withoutCredentials('remote: token ghp_0123456789abcdefghijABCDEFGHIJ rejected')).toBe('remote: token *** rejected');
    expect(withoutCredentials('github_pat_11AAAAAAA0123456789_abcdefghijklmnop')).toBe('***');
    expect(withoutCredentials('git@github.com:o/r.git and https://github.com/o/r')).toBe('git@github.com:o/r.git and https://github.com/o/r');
  });

  it("keeps a remote URL's credentials out of a failed push's reason", async () => {
    const repo = initRepo(makeTempDir('push-creds-'));
    cleanup.push(repo);
    git(repo, 'checkout', '-q', '-b', BRANCH);
    git(repo, 'remote', 'add', 'origin', 'https://user:ghp_0123456789abcdefghijABCDEFGHIJ@127.0.0.1:1/o/r.git');
    const r = await pushBranch(repo, BRANCH);
    expect(r.kind).toBe('failed');
    expect(JSON.stringify(r)).not.toContain('ghp_');
  });
});

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  deleteArgs,
  driverConfig,
  gitDirsOf,
  LAUNCH_FAILED,
  launcherScript,
  policySetArgs,
  PROVIDER,
  SANDBOX_CLAUDE_DIR,
  sandboxedCommand,
  sandboxMounts,
  sandboxName,
  stopArgs,
} from '../../../../src/features/sandbox/openshell';
import { makeTempDir } from '../../../helpers/gitRepo';

describe('OpenShell sandboxes (BL-270)', () => {
  it("names a worktree's sandbox after its folder, the same every time, and differently for another path", () => {
    const a = sandboxName('/repo/.worktrees/feature-BL-270-agents-run-inside');
    expect(a).toMatch(/^flotilla-feature-bl-270-agents-run-inside-[0-9a-f]{6}$/);
    expect(sandboxName('/repo/.worktrees/feature-BL-270-agents-run-inside')).toBe(a);
    expect(sandboxName('/other/.worktrees/feature-BL-270-agents-run-inside')).not.toBe(a);
    expect(sandboxName(`/repo/${'x'.repeat(200)}`).length).toBeLessThanOrEqual(63);
  });

  it("finds a linked worktree's git dir and common dir from its .git file", () => {
    const root = makeTempDir();
    const common = path.join(root, 'main', '.git');
    const gitDir = path.join(common, 'worktrees', 'wt');
    const wt = path.join(root, 'wt');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir}\n`);
    fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
    expect(gitDirsOf(wt)).toEqual([gitDir, common]);
    // A main checkout's .git folder is inside it: nothing more to mount.
    expect(gitDirsOf(path.join(root, 'main'))).toEqual([]);
  });

  it("mounts the worktree, the backlog, the git dirs, the agent files read only, and the transcripts at Claude's dir", () => {
    const mounts = sandboxMounts({
      cwd: '/repo/.worktrees/wt',
      dirs: ['/repo/.flotilla/backlog', '/repo/.worktrees/wt/inside'],
      gitDirs: ['/repo/.git/worktrees/wt', '/repo/.git'],
      agentFiles: '/tmp/flotilla',
      transcripts: '/home/u/.claude/projects/-repo--worktrees-wt',
    });
    expect(mounts).toEqual([
      { path: '/repo/.worktrees/wt' },
      { path: '/repo/.flotilla/backlog' },
      { path: '/repo/.git' },
      { path: '/tmp/flotilla', readOnly: true },
      { path: '/home/u/.claude/projects/-repo--worktrees-wt', target: `${SANDBOX_CLAUDE_DIR}/projects/-repo--worktrees-wt` },
    ]);
    expect(JSON.parse(driverConfig(mounts)).docker.mounts[3]).toEqual({ type: 'bind', source: '/tmp/flotilla', target: '/tmp/flotilla', read_only: true });
  });

  it("runs claude in the sandbox with sandbox exec: the worktree as working directory, Claude's config dir and the git identity", () => {
    const cmd = sandboxedCommand({
      launcher: '/tmp/flotilla/launch.sh',
      args: ['-p', 'Do it', '--session-id', 'abc'],
      cwd: '/repo/wt',
      name: 'flotilla-wt-123456',
      mounts: [{ path: '/repo/wt' }],
      policyFile: '/tmp/flotilla/policy.yaml',
      image: 'my-image',
      identity: { name: 'Archipelagic', email: 'a@b.c' },
    });
    expect(cmd.command).toBe('/tmp/flotilla/launch.sh');
    expect(cmd.args).toEqual([
      '--workdir',
      '/repo/wt',
      '--no-tty',
      '--env',
      `CLAUDE_CONFIG_DIR=${SANDBOX_CLAUDE_DIR}`,
      '--env',
      'GIT_AUTHOR_NAME=Archipelagic',
      '--env',
      'GIT_COMMITTER_NAME=Archipelagic',
      '--env',
      'GIT_AUTHOR_EMAIL=a@b.c',
      '--env',
      'GIT_COMMITTER_EMAIL=a@b.c',
      '--',
      'claude',
      '-p',
      'Do it',
      '--session-id',
      'abc',
    ]);
    expect(cmd.env).toMatchObject({
      FLOTILLA_SANDBOX: 'flotilla-wt-123456',
      FLOTILLA_SANDBOX_PROVIDER: PROVIDER,
      FLOTILLA_SANDBOX_POLICY: '/tmp/flotilla/policy.yaml',
      FLOTILLA_SANDBOX_FROM: 'my-image',
    });
    expect(JSON.parse(cmd.env.FLOTILLA_SANDBOX_MOUNTS).docker.mounts).toHaveLength(1);
    expect(sandboxedCommand({ launcher: 'l', args: [], cwd: '/w', name: 'n', mounts: [], policyFile: 'p', tty: true }).args).toContain('--tty');
  });

  it('stops a session in its sandbox, and removes a sandbox, with openshell', () => {
    expect(stopArgs('n', 'abc')).toEqual(['sandbox', 'exec', '-n', 'n', '--no-tty', '--', 'pkill', '-f', '--', 'abc']);
    expect(deleteArgs('n')).toEqual(['sandbox', 'delete', 'n']);
  });

  it('never falls back to running claude outside the sandbox: its only claude is in sandbox exec', () => {
    const script = launcherScript();
    expect(script).toContain(`exit ${LAUNCH_FAILED}`);
    expect(script.match(/^exec .*/m)?.[0]).toBe('exec openshell sandbox exec -n "$n" "$@"');
    expect(script).not.toMatch(/^\s*claude\b/m);
  });

  it('loads a policy into a running sandbox and waits for it (BL-271)', () => {
    expect(policySetArgs('flotilla-wt-123456', '/state/p.yaml')).toEqual(['policy', 'set', 'flotilla-wt-123456', '--policy', '/state/p.yaml', '--wait']);
  });
});

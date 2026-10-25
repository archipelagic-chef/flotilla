import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { installCommitHook, markWorktree, PREVIOUS_HOOK } from '../../../src/features/backlog/commitHook';
import { git, initRepo, removeDir } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

/** Commits in dir as an agent (CLAUDECODE set, as Claude Code sets it) or as a person; the error if it's refused. */
function commit(dir: string, message: string, agent: boolean): string | undefined {
  fs.writeFileSync(path.join(dir, `f${Math.random()}.txt`), 'x');
  git(dir, 'add', '.');
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  delete env.CLAUDECODE;
  if (agent) env.CLAUDECODE = '1';
  try {
    execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    return undefined;
  } catch (error) {
    return String((error as { stderr?: Buffer }).stderr ?? error);
  }
}

function setup(): { repo: string; wt: string; common: string } {
  const repo = initRepo();
  const wt = `${repo}-wt`;
  cleanup.push(repo, wt);
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'feature/BL-1-sso');
  return { repo, wt, common: path.join(repo, '.git') };
}

describe('commit prefix hook', () => {
  it("refuses an agent's commit without the ticket id in a worktree working on it", async () => {
    const { repo, wt, common } = setup();
    expect(await installCommitHook(repo, common, 'agents')).toBe('installed');
    await markWorktree(git(wt, 'rev-parse', '--absolute-git-dir'), 'BL-1');
    expect(commit(wt, 'Add SAML', true)).toMatch(/start the commit message with "BL-1: "/);
    expect(commit(wt, 'BL-1: Add SAML', true)).toBeUndefined();
    expect(commit(wt, 'fixup! BL-1: Add SAML', true)).toBeUndefined();
    // People's commits, and other worktrees, aren't checked.
    expect(commit(wt, 'Tidy up', false)).toBeUndefined();
    expect(commit(repo, 'On main', true)).toBeUndefined();
  });

  it('checks everyone, or no one, as set', async () => {
    const { repo, wt, common } = setup();
    await installCommitHook(repo, common, 'everyone');
    await markWorktree(git(wt, 'rev-parse', '--absolute-git-dir'), 'BL-1');
    expect(commit(wt, 'Tidy up', false)).toMatch(/BL-1/);
    await installCommitHook(repo, common, 'off');
    expect(commit(wt, 'Tidy up', true)).toBeUndefined();
  });

  it('keeps an existing commit-msg hook running, and leaves hooks in the repository alone', async () => {
    const { repo, wt, common } = setup();
    const hooks = path.join(common, 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'commit-msg'), '#!/bin/sh\necho previous >&2\nexit 1\n', { mode: 0o755 });
    await installCommitHook(repo, common, 'agents');
    expect(fs.existsSync(path.join(hooks, PREVIOUS_HOOK))).toBe(true);
    await markWorktree(git(wt, 'rev-parse', '--absolute-git-dir'), 'BL-1');
    expect(commit(wt, 'BL-1: ok for Flotilla', true)).toMatch(/previous/);

    const other = setup();
    git(other.repo, 'config', 'core.hooksPath', '.husky');
    expect(await installCommitHook(other.repo, other.common, 'agents')).toBe('tracked');
    expect(fs.existsSync(path.join(other.repo, '.husky', 'commit-msg'))).toBe(false);
  });
});

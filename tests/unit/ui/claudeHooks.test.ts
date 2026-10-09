import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_STATUS_FILE, parseAgentStatus } from '../../../src/features/workstreams/agentStatus';
import { claudeHookCommand, claudeHookConfig, HOOK_SCRIPT } from '../../../src/ui/claudeHooks';
import { git, initRepo, makeTempDir, removeDir } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

const readStatus = (gitDir: string) => parseAgentStatus(fs.readFileSync(path.join(gitDir, AGENT_STATUS_FILE), 'utf8'));

describe('Claude Code hook', () => {
  it('writes the state and the message from stdin', () => {
    const repo = initRepo();
    cleanup.push(repo);
    execFileSync(process.execPath, ['-e', HOOK_SCRIPT, 'waiting-for-input'], {
      cwd: repo,
      input: JSON.stringify({ message: 'Claude needs your permission to use Bash' }),
    });
    expect(readStatus(path.join(repo, '.git'))).toMatchObject({ state: 'waiting-for-input', message: 'Claude needs your permission to use Bash' });
  });

  it("writes into a linked worktree's own git dir", () => {
    const repo = initRepo();
    cleanup.push(repo);
    const wt = path.join(repo, '.worktrees', 'feat');
    git(repo, 'worktree', 'add', '-b', 'feat', wt);
    execFileSync(process.execPath, ['-e', HOOK_SCRIPT, 'working'], { cwd: wt, input: JSON.stringify({ prompt: 'fix the tests' }) });
    expect(readStatus(path.join(repo, '.git', 'worktrees', 'feat'))).toMatchObject({ state: 'working', message: 'fix the tests' });
  });

  it('runs through the platform shell', () => {
    const repo = initRepo();
    cleanup.push(repo);
    execSync(claudeHookCommand('done'), { cwd: repo, input: '{}' });
    expect(readStatus(path.join(repo, '.git'))?.state).toBe('done');
  });

  it('never fails outside a git repository or with bad input', () => {
    const dir = makeTempDir();
    cleanup.push(dir);
    expect(() => execFileSync(process.execPath, ['-e', HOOK_SCRIPT, 'done'], { cwd: dir, input: 'not json' })).not.toThrow();
  });

  it('contains no characters that cmd, PowerShell or sh would interpret inside double quotes', () => {
    expect(HOOK_SCRIPT).not.toMatch(/["$`!%^<>&]/);
  });

  it('maps hook events to states', () => {
    const config = JSON.parse(claudeHookConfig());
    expect(Object.keys(config.hooks)).toEqual(['UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop']);
    expect(config.hooks.Notification[0].hooks[0]).toEqual({ type: 'command', command: claudeHookCommand('waiting-for-input') });
    expect(config.hooks.Stop[0].hooks[0].command).toBe(claudeHookCommand('done'));
  });
});

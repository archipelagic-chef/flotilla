import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readChatRecords } from '../../../../src/features/chats/chats';
import { hasCurrentHooks, installHooks, withFlotillaHooks } from '../../../../src/features/chats/hookInstall';
import { HOOK_EVENTS, hookCommand, hookSource } from '../../../../src/features/chats/hookScript';
import { git, initRepo, removeDir } from '../../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

/** Runs the hook the way Claude Code does: event JSON on stdin, cwd = the chat's directory. */
function fire(cwd: string, event: Record<string, unknown>): void {
  execFileSync(process.execPath, ['-e', hookSource(), 'flotilla-hook'], { cwd, input: JSON.stringify({ cwd, ...event }) });
}

function setup(): { repo: string; wt: string; wtGitDir: string } {
  const repo = initRepo();
  cleanup.push(repo);
  const wt = path.join(repo, '.worktrees', 'feat');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat', wt);
  return { repo, wt, wtGitDir: path.join(repo, '.git', 'worktrees', 'feat') };
}

describe('hook script', () => {
  it('records one file per chat with its state, prompt and question', async () => {
    const { wt, wtGitDir } = setup();
    fire(wt, { session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: 'Add a login form' });
    fire(wt, { session_id: 's2', hook_event_name: 'SessionStart' });
    fire(wt, { session_id: 's1', hook_event_name: 'Notification', message: 'Approve the migration?' });
    const records = await readChatRecords(wtGitDir);
    const s1 = records.find((r) => r.sessionId === 's1')!;
    expect(s1).toMatchObject({ state: 'waiting-for-input', message: 'Approve the migration?', firstPrompt: 'Add a login form', linkedBy: 'cwd' });
    expect(records.find((r) => r.sessionId === 's2')).toMatchObject({ state: 'done' });

    fire(wt, { session_id: 's1', hook_event_name: 'Stop' });
    expect((await readChatRecords(wtGitDir)).find((r) => r.sessionId === 's1')).toMatchObject({ state: 'done', message: undefined });
    fire(wt, { session_id: 's1', hook_event_name: 'SessionEnd' });
    expect((await readChatRecords(wtGitDir)).find((r) => r.sessionId === 's1')?.state).toBe('ended');
  });

  it('links a chat to another worktree whose files it edits', async () => {
    const { repo, wt, wtGitDir } = setup();
    fire(repo, { session_id: 'm1', hook_event_name: 'UserPromptSubmit', prompt: 'Fix the login bug' });
    fire(repo, { session_id: 'm1', hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(wt, 'README.md') } });
    expect(await readChatRecords(path.join(repo, '.git'))).toMatchObject([{ sessionId: 'm1', linkedBy: 'cwd', state: 'working' }]);
    expect(await readChatRecords(wtGitDir)).toMatchObject([{ sessionId: 'm1', linkedBy: 'edit', state: 'working', cwd: repo }]);
    // Later events are mirrored too.
    fire(repo, { session_id: 'm1', hook_event_name: 'Stop' });
    expect((await readChatRecords(wtGitDir))[0].state).toBe('done');
  });

  it('does nothing outside a git repository or without a session id', () => {
    const { wt, wtGitDir } = setup();
    fire(path.dirname(path.dirname(path.dirname(wt))), { session_id: 'x', hook_event_name: 'Stop' });
    fire(wt, { hook_event_name: 'Stop' });
    expect(fs.existsSync(path.join(wtGitDir, 'flotilla'))).toBe(false);
  });

  it('survives shell quoting as a single command line', () => {
    const { wt, wtGitDir } = setup();
    execFileSync('sh', ['-c', hookCommand()], { cwd: wt, input: JSON.stringify({ session_id: 'q', hook_event_name: 'Stop', cwd: wt }) });
    expect(fs.existsSync(path.join(wtGitDir, 'flotilla', 'chats', 'q.json'))).toBe(true);
    // Only base64 inside the quotes: nothing sh, cmd or PowerShell would interpret.
    expect(hookCommand()).toMatch(/^node -e "eval\(Buffer\.from\('[A-Za-z0-9+/=]+','base64'\)\.toString\(\)\)" flotilla-hook$/);
  });
});

describe('hook installation', () => {
  it('merges into existing settings, replaces old Flotilla hooks and keeps others', () => {
    const settings = {
      permissions: { allow: ['Bash(npm test)'] },
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'node -e "...workstream.json..." done' }, { type: 'command', command: 'say done' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }],
      },
    };
    const merged = withFlotillaHooks(settings, 'CMD flotilla-hook');
    expect(merged.permissions).toEqual(settings.permissions);
    expect(merged.hooks!.PreToolUse).toEqual(settings.hooks.PreToolUse);
    expect(merged.hooks!.Stop).toEqual([{ hooks: [{ type: 'command', command: 'say done' }] }, { hooks: [{ type: 'command', command: 'CMD flotilla-hook' }] }]);
    for (const e of HOOK_EVENTS) expect(merged.hooks![e]).toContainEqual({ hooks: [{ type: 'command', command: 'CMD flotilla-hook' }] });
    expect(hasCurrentHooks(merged, 'CMD flotilla-hook')).toBe(true);
    // Reinstalling does not duplicate.
    expect(withFlotillaHooks(merged, 'CMD flotilla-hook')).toEqual(merged);
  });

  it('writes settings.local.json, excludes it from git, and refuses invalid JSON', async () => {
    const { repo, wt } = setup();
    expect(await installHooks(wt, path.join(repo, '.git'))).toBe('installed');
    expect(await installHooks(wt, path.join(repo, '.git'))).toBe('unchanged');
    expect(git(wt, 'status', '--porcelain')).toBe('');
    fs.writeFileSync(path.join(wt, '.claude', 'settings.local.json'), '{ broken');
    await expect(installHooks(wt, path.join(repo, '.git'))).rejects.toThrow();
    expect(fs.readFileSync(path.join(wt, '.claude', 'settings.local.json'), 'utf8')).toBe('{ broken');
  });
});

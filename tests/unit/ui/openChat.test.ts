import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ commands: [] as unknown[][], messages: [] as string[], answer: undefined as string | undefined, terminals: [] as unknown[] }));

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  extensions: { getExtension: () => ({ extensionPath: '/nowhere' }) },
  commands: { executeCommand: async (...args: unknown[]) => void calls.commands.push(args) },
  window: {
    showInformationMessage: async (m: string) => (calls.messages.push(m), calls.answer),
    showWarningMessage: async (m: string) => void calls.messages.push(m),
    createTerminal: (o: unknown) => (calls.terminals.push(o), { show: () => undefined }),
  },
  Uri: { from: (u: { scheme: string; path: string; query: string }) => ({ ...u, toString: () => `${u.scheme}:${u.path}?${u.query}` }) },
  ThemeIcon: class {},
  EventEmitter: class {
    listeners: ((u: unknown) => void)[] = [];
    event = (l: (u: unknown) => void) => this.listeners.push(l);
    fire = (u: unknown) => this.listeners.forEach((l) => l(u));
    dispose() {}
  },
}));

import { readChatRecords, transcriptPath } from '../../../src/features/chats/chats';
import { openChat, type ChatContext } from '../../../src/ui/chatCommands';
import { TranscriptViews } from '../../../src/ui/transcriptView';
import type { Workstream } from '../../../src/features/workstreams/workstream';

const ID = '3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
let tmp: string;
let home: string;
let ctx: ChatContext;
let focused: string[];

function transcript(cwd: string, entrypoint: string): string {
  const file = transcriptPath(cwd, ID, home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const user = { type: 'user', entrypoint, timestamp: '2026-10-20T06:00:00Z', message: { role: 'user', content: 'Fix the bug' } };
  const reply = { type: 'assistant', entrypoint, timestamp: '2026-10-20T06:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } };
  const raw = `${JSON.stringify(user)}\n${JSON.stringify(reply)}\n`;
  fs.writeFileSync(file, raw);
  return raw;
}

function workstream(name: string, o: { windowOpen?: boolean } = {}): Workstream {
  const root = path.join(tmp, name);
  const gitDir = path.join(tmp, 'git', name);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(gitDir, { recursive: true });
  const chat = { id: ID, source: 'claude-code', title: 'Fix the bug', state: 'done', linkedBy: 'cwd', updatedAt: new Date(), open: false };
  return { key: name, worktree: { path: root, adminDir: gitDir }, chats: [chat], windowOpen: !!o.windowOpen, heartbeat: o.windowOpen ? { env: 'local' } : undefined } as unknown as Workstream;
}

/** Every transcript file under Claude Code's projects. */
function transcripts(): string[] {
  const projects = path.join(home, 'projects');
  return fs.existsSync(projects) ? fs.readdirSync(projects).flatMap((d) => fs.readdirSync(path.join(projects, d)).map((f) => path.join(d, f))) : [];
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'open-chat-'));
  home = path.join(tmp, 'claude');
  vi.stubEnv('CLAUDE_CONFIG_DIR', home);
  calls.commands = [];
  calls.messages = [];
  calls.terminals = [];
  calls.answer = undefined;
  focused = [];
  const main = workstream('main');
  ctx = {
    currentRoot: main.worktree.path!,
    currentGitDir: main.worktree.adminDir,
    workstreams: () => [],
    refresh: async () => undefined,
    focusWindow: async (dir: string) => void focused.push(dir),
    env: 'local',
  } as unknown as ChatContext;
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('openChat', () => {
  it("shows an agent's chat read-only, copying, relinking and retitling nothing", async () => {
    const ws = workstream('bl-1');
    ctx.workstreams = () => [ws];
    const raw = transcript(ws.worktree.path!, 'sdk-cli');
    await openChat(ctx, ws, ID);
    expect(calls.commands).toHaveLength(1);
    expect(calls.commands[0]![0]).toBe('markdown.showPreview');
    expect(String((calls.commands[0]![1] as { query: string }).query)).toBe(transcriptPath(ws.worktree.path!, ID, home));
    expect(transcripts()).toHaveLength(1);
    expect(fs.readFileSync(transcriptPath(ws.worktree.path!, ID, home), 'utf8')).toBe(raw);
    expect(await readChatRecords(ws.worktree.adminDir)).toEqual([]);
    expect(await readChatRecords(ctx.currentGitDir)).toEqual([]);
  });

  it("continues an agent's chat in a terminal in its own folder", async () => {
    const ws = workstream('bl-1');
    ctx.workstreams = () => [ws];
    transcript(ws.worktree.path!, 'sdk-cli');
    calls.answer = 'Continue in Terminal';
    await openChat(ctx, ws, ID);
    const terminal = calls.terminals[0] as { cwd: string; shellArgs: string[] };
    expect(terminal.cwd).toBe(ws.worktree.path);
    expect(terminal.shellArgs).toContain('--resume');
    expect(terminal.shellArgs.at(-1)).not.toBe('');
    // Resumed under the title it has (--name sets it), so it isn't renamed.
    expect(terminal.shellArgs[terminal.shellArgs.indexOf('--name') + 1]).toBe('Fix the bug');
  });

  it("shows a running agent's chat from another worktree (as the ticket's agent card opens it), without offering to resume it", async () => {
    const ws = workstream('bl-1');
    Object.assign(ws.chats[0]!, { state: 'working', open: true });
    ctx.workstreams = () => [ws];
    transcript(ws.worktree.path!, 'sdk-cli');
    calls.answer = 'Continue in Terminal';
    await openChat(ctx, ws, ID);
    expect(calls.commands.map((c) => c[0])).toEqual(['markdown.showPreview']);
    expect(calls.messages[0]).toMatch(/is running/);
    expect(calls.terminals).toEqual([]);
    expect(transcripts()).toHaveLength(1);
  });

  it("opens your own chat from another worktree in that worktree's window, leaving it where it is", async () => {
    const ws = workstream('bl-2', { windowOpen: true });
    ctx.workstreams = () => [ws];
    transcript(ws.worktree.path!, 'claude-vscode');
    await openChat(ctx, ws, ID);
    expect(calls.commands).toEqual([]);
    expect(focused).toEqual([ws.worktree.path]);
    expect(fs.readdirSync(path.join(ws.worktree.adminDir, 'flotilla', 'requests'))).toHaveLength(1);
    expect(transcripts()).toHaveLength(1);
    expect(await readChatRecords(ws.worktree.adminDir)).toEqual([]);
    expect(await readChatRecords(ctx.currentGitDir)).toEqual([]);
  });

  it('opens a window on its worktree when there is none, once asked to', async () => {
    const ws = workstream('bl-2');
    ctx.workstreams = () => [ws];
    transcript(ws.worktree.path!, 'claude-vscode');
    await openChat(ctx, ws, ID);
    expect(focused).toEqual([]);
    calls.answer = 'Open Its Window';
    await openChat(ctx, ws, ID);
    expect(focused).toEqual([ws.worktree.path]);
    expect(transcripts()).toHaveLength(1);
  });

  it("opens a chat that ran in this window's folder in Claude Code's panel", async () => {
    const ws = { ...workstream('main'), chats: workstream('main').chats } as Workstream;
    ctx.workstreams = () => [ws];
    transcript(ctx.currentRoot, 'claude-vscode');
    await openChat(ctx, ws, ID, 'Go on');
    expect(calls.commands).toEqual([['claude-vscode.editor.open', ID, 'Go on']]);
  });
});

describe('the transcript view', () => {
  it('follows its transcript while open: re-rendered once for a burst of writes, and no more once closed', async () => {
    vi.useFakeTimers();
    try {
      const ws = workstream('bl-1');
      const file = transcriptPath(ws.worktree.path!, ID, home);
      const watchers: { changed: () => void; disposed: boolean }[] = [];
      const views = new TranscriptViews((_f, changed) => {
        const w = { changed, disposed: false };
        watchers.push(w);
        return { dispose: () => void (w.disposed = true) };
      });
      const fired: unknown[] = [];
      views.onDidChange((u) => fired.push(u));
      const uri = { scheme: 'flotilla-transcript', path: '/Nova-7.md', query: file, toString: () => `t:${file}` } as never;

      // Not written yet (an agent that has just started): an empty chat, followed until it is.
      expect(await views.provideTextDocumentContent(uri)).toContain('no messages yet');
      transcript(ws.worktree.path!, 'sdk-cli');
      watchers[0]!.changed();
      watchers[0]!.changed();
      await vi.advanceTimersByTimeAsync(1500);
      expect(fired).toEqual([uri]);
      expect(await views.provideTextDocumentContent(uri)).toContain('Done.');
      expect(watchers).toHaveLength(1);

      views.unfollow(uri);
      expect(watchers[0]!.disposed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isInside, samePath, toGitPath } from '../core/paths';
import { claudeHome, importTranscript, linkChat, readChatRecords, readTranscripts, tagTranscriptTitle, transcriptPath, unlinkChat } from '../features/chats/chats';
import { hooksPresent, installHooks } from '../features/chats/hookInstall';
import { PendingLinks } from '../features/chats/pendingLinks';
import type { Workstream } from '../features/workstreams/workstream';
import { workstreamLabel } from './format';
import type { AgentChoice } from '../features/backlog/backlog';
import { choiceArgs, claudeBinary, isRunningHeadless, leanStart } from './backlog/agentRunner';
import { sendWindowRequest, takeWindowRequests } from '../features/workstreams/windowRequests';
import type { WindowEnv } from '../features/workstreams/heartbeat';

const CLAUDE_EXTENSION = 'anthropic.claude-code';
const CLAUDE_OPEN = 'claude-vscode.editor.open';
const HOOKS_OFFERED_KEY = 'flotilla.hooksOffered';

export interface ChatContext {
  extension: vscode.ExtensionContext;
  /** Root of the worktree open in this window; chats started here run in it. */
  currentRoot: string;
  /** Git dir of that worktree, where this window's chats record their state. */
  currentGitDir: string;
  mainRoot: string;
  commonDir: string;
  workstreams(): readonly Workstream[];
  refresh(): Promise<void>;
  output: vscode.OutputChannel;
  /** Brings the window open on a folder to the front (VS Code focuses it rather than opening another). */
  focusWindow(dir: string): Promise<void>;
  /** This window's environment, as heartbeats name it: a window in another one can't be brought forward from here. */
  env: WindowEnv;
}

function claudeAvailable(): boolean {
  if (vscode.extensions.getExtension(CLAUDE_EXTENSION)) return true;
  void vscode.window
    .showWarningMessage('Starting chats needs the Claude Code extension.', 'Show Extension')
    .then((choice) => choice && vscode.commands.executeCommand('workbench.extensions.search', CLAUDE_EXTENSION));
  return false;
}

/** Opens a new Claude Code chat in this window with prompt in its message box (not sent: add to it, then send). */
export async function askClaude(prompt: string): Promise<void> {
  if (!claudeAvailable()) return;
  await vscode.commands.executeCommand(CLAUDE_OPEN, undefined, prompt);
}

/** Chats started for another worktree, waiting for Claude Code to create their session. */
const pendingLinks = new PendingLinks();
let linkTimer: ReturnType<typeof setInterval> | undefined;

/** Sessions of chats that run in this window's folder, from transcripts and hook records. */
async function sessionsHere(ctx: ChatContext): Promise<string[]> {
  const [transcripts, records] = await Promise.all([readTranscripts(ctx.currentRoot), readChatRecords(ctx.currentGitDir)]);
  return [...new Set([...transcripts.map((t) => t.sessionId), ...records.map((r) => r.sessionId)])];
}

/** Links new sessions to the worktrees they were started for. Runs on a timer while any chat is pending. */
export async function linkPendingChats(ctx: ChatContext): Promise<void> {
  if (!pendingLinks.size) return;
  const matches = pendingLinks.match(await sessionsHere(ctx), Date.now());
  for (const m of matches) {
    await linkChat({ sessionId: m.sessionId, ownerGitDir: ctx.currentGitDir, cwd: ctx.currentRoot, targetGitDir: m.targetGitDir });
  }
  if (!pendingLinks.size && linkTimer) {
    clearInterval(linkTimer);
    linkTimer = undefined;
  }
  if (matches.length) await ctx.refresh();
}

/** How the agent should find the worktree from this window's folder. */
function worktreeLocation(ctx: ChatContext, dir: string): string {
  return isInside(ctx.currentRoot, dir) ? toGitPath(path.relative(ctx.currentRoot, dir)) : dir;
}

/**
 * Starts a chat in this window. For another worktree, the message box is pre-filled with where to work, and the
 * chat is linked to that worktree as soon as Claude Code creates it (when the first message is sent).
 */
export async function newChat(ctx: ChatContext, ws: Workstream, task = '', lead = ''): Promise<void> {
  if (!claudeAvailable()) return;
  const dir = ws.worktree.path!;
  if (samePath(dir, ctx.currentRoot)) {
    await vscode.commands.executeCommand(CLAUDE_OPEN, undefined, [lead, task].filter(Boolean).join('\n\n') || undefined);
    return;
  }
  pendingLinks.add(ws.worktree.adminDir, await sessionsHere(ctx), Date.now());
  linkTimer ??= setInterval(() => void linkPendingChats(ctx).catch((e: unknown) => ctx.output.appendLine(`Linking chats failed: ${String(e)}`)), 3000);
  const branch = workstreamLabel(ws);
  const where = `Work in the git worktree at ${worktreeLocation(ctx, dir)} (branch ${branch}): run commands there and only change files under it.`;
  await vscode.commands.executeCommand(CLAUDE_OPEN, undefined, [lead, where, task].filter(Boolean).join('\n\n'));
}

/**
 * Starts an agent in a worktree, with its task: in Claude Code's panel (message filled in, sent by the user), or, when
 * a model or an effort is chosen (which the panel can't be started with), as an interactive Claude Code session in a
 * terminal in the worktree, the task sent at once.
 */
export async function startAgent(ctx: ChatContext, ws: Workstream, task: string, lead: string, o: { choice: AgentChoice; name: string }): Promise<'panel' | 'terminal'> {
  const args = choiceArgs(o.choice);
  if (!args.length || !ws.worktree.path) {
    await newChat(ctx, ws, task, lead);
    return 'panel';
  }
  // A lean start's tool list takes several values: the --name after it ends it, before the prompt.
  const lean = leanStart(ws.worktree.path);
  const terminal = vscode.window.createTerminal({
    name: o.name,
    cwd: ws.worktree.path,
    shellPath: claudeBinary(),
    shellArgs: [...args, ...(lean ? [...lean.flags, '--tools', lean.tools.join(',')] : []), '--name', o.name, [lead, task].filter(Boolean).join('\n\n')],
    iconPath: new vscode.ThemeIcon('hubot'),
  });
  terminal.show();
  return 'terminal';
}

/**
 * Opens a chat in Claude Code's panel in this window. The panel only lists chats recorded under this window's folder,
 * so a chat that ran in another worktree's folder is first copied there (its transcript; the original stays) and
 * linked to its worktree. It then continues in this window, like chats started here for a worktree.
 */
export async function openChat(ctx: ChatContext, ws: Workstream, chatId: string, prompt?: string): Promise<void> {
  const chat = ws.chats.find((c) => c.id === chatId);
  if (!chat) return;
  const dir = chat.cwd ?? ws.worktree.path;
  // An active chat is selected where it runs (another window can do that without Claude Code here); it's never copied.
  if (dir && !samePath(dir, ctx.currentRoot) && chat.open && (chat.state === 'working' || chat.state === 'waiting-for-input')) {
    await selectActiveChat(ctx, chat.id, chat.title, dir);
    return;
  }
  if (!claudeAvailable()) return;
  if (dir && !samePath(dir, ctx.currentRoot)) {
    const result = await importTranscript(dir, ctx.currentRoot, chat.id);
    if (result === 'missing') {
      void vscode.window.showWarningMessage(
        `Can't open '${chat.title}': its transcript isn't in this environment (it ran in ${dir}). Open it from a window in the environment it ran in.`,
      );
      return;
    }
    // From now on the chat runs in this window's folder, but belongs to its worktree.
    await linkChat({
      sessionId: chat.id,
      ownerGitDir: ctx.currentGitDir,
      cwd: ctx.currentRoot,
      targetGitDir: ws.worktree.adminDir,
      title: chat.title,
      state: chat.state,
    });
    void ctx.refresh();
  }
  await vscode.commands.executeCommand(CLAUDE_OPEN, chat.id, prompt);
}

/**
 * Selects a chat that's active in another folder: in the Flotilla window open on that folder (which brings it to the
 * front), or, running without a window, says so. Otherwise it's in this window's Claude Code (or a terminal), which is
 * asked to select it.
 */
async function selectActiveChat(ctx: ChatContext, chatId: string, title: string, dir: string): Promise<void> {
  if (isRunningHeadless(chatId)) {
    void vscode.window.showInformationMessage(`'${title}' is an agent running without a window; it reports in its ticket. Open it once it's done.`);
    return;
  }
  const owner = ctx.workstreams().find((w) => w.worktree.path && samePath(w.worktree.path, dir));
  if (owner?.windowOpen && !samePath(owner.worktree.adminDir, ctx.currentGitDir)) {
    await sendWindowRequest(owner.worktree.adminDir, { type: 'openChat', sessionId: chatId });
    if (owner.heartbeat?.env === ctx.env) await ctx.focusWindow(dir);
    else void vscode.window.showInformationMessage(`'${title}' is selected in the window on ${workstreamLabel(owner)}.`);
    return;
  }
  if (claudeAvailable()) await vscode.commands.executeCommand(CLAUDE_OPEN, chatId);
}

/** Handles what other windows ask of this one (select a chat that runs here). */
export async function handleWindowRequests(ctx: ChatContext): Promise<void> {
  for (const r of await takeWindowRequests(ctx.currentGitDir)) {
    if (r.type === 'openChat' && claudeAvailable()) await vscode.commands.executeCommand(CLAUDE_OPEN, r.sessionId);
  }
}

/** Shows each linked chat's worktree in Claude Code's own session list (setting flotilla.tagChatTitles). */
const tagged = new Set<string>();
export async function tagLinkedChatTitles(ctx: ChatContext): Promise<void> {
  if (!vscode.workspace.getConfiguration('flotilla').get<boolean>('tagChatTitles', true)) return;
  for (const ws of ctx.workstreams()) {
    for (const chat of ws.chats) {
      if (chat.linkedBy !== 'manual' || !chat.cwd || tagged.has(chat.id)) continue;
      const result = await tagTranscriptTitle(transcriptPath(chat.cwd, chat.id, claudeHome()), chat.id, workstreamLabel(ws));
      if (result === 'tagged' || result === 'hasCustomTitle') tagged.add(chat.id);
    }
  }
}

function ownerOf(ctx: ChatContext, cwd: string | undefined): Workstream | undefined {
  return cwd ? ctx.workstreams().find((w) => w.worktree.path && samePath(w.worktree.path, cwd)) : undefined;
}

export async function unlink(ctx: ChatContext, ws: Workstream, chatId: string): Promise<void> {
  const chat = ws.chats.find((c) => c.id === chatId);
  await unlinkChat(ws.worktree.adminDir, chatId, ownerOf(ctx, chat?.cwd)?.worktree.adminDir);
  await ctx.refresh();
}

/** Links a chat from another worktree (typically one started in this window's folder) to this one. */
export async function link(ctx: ChatContext, ws: Workstream): Promise<void> {
  type Item = vscode.QuickPickItem & { chat: Workstream['chats'][number]; from: Workstream };
  const here = new Set(ws.chats.map((c) => c.id));
  const items: Item[] = ctx
    .workstreams()
    .filter((w) => w.key !== ws.key && w.worktree.path)
    .flatMap((from) =>
      from.chats
        .filter((c) => !here.has(c.id) && c.linkedBy === 'cwd')
        .map((chat) => ({ label: chat.title, description: workstreamLabel(from), detail: chat.open ? chat.state : 'ended', chat, from })),
    );
  if (!items.length) {
    void vscode.window.showInformationMessage('There are no chats in other worktrees to link.');
    return;
  }
  const picked = await vscode.window.showQuickPick(items, { title: `Link a chat to '${workstreamLabel(ws)}'`, matchOnDescription: true });
  if (!picked) return;
  await linkChat({
    sessionId: picked.chat.id,
    ownerGitDir: picked.from.worktree.adminDir,
    cwd: picked.from.worktree.path!,
    targetGitDir: ws.worktree.adminDir,
    title: picked.chat.title,
    state: picked.chat.state,
  });
  await ctx.refresh();
}

function nodeAvailable(cwd: string): Promise<boolean> {
  return new Promise((resolve) => execFile('node', ['--version'], { cwd, windowsHide: true }, (error) => resolve(!error)));
}

/** Installs the hooks into the given worktrees (all reachable ones by default). */
export async function installChatHooks(ctx: ChatContext, only?: Workstream): Promise<void> {
  const targets = (only ? [only] : ctx.workstreams()).filter((w) => w.worktree.path);
  if (!(await nodeAvailable(ctx.mainRoot))) {
    void vscode.window.showWarningMessage("Flotilla's Claude Code hooks run with Node.js, which isn't on the PATH in this environment.");
    return;
  }
  const failed: string[] = [];
  let installed = 0;
  for (const ws of targets) {
    try {
      if ((await installHooks(ws.worktree.path!, ctx.commonDir)) === 'installed') installed++;
    } catch (error) {
      failed.push(workstreamLabel(ws));
      ctx.output.appendLine(`Could not install hooks in ${ws.worktree.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await ctx.refresh();
  if (failed.length) {
    const choice = await vscode.window.showWarningMessage(
      `Could not install the Claude Code hooks in ${failed.join(', ')}: .claude/settings.local.json is not valid JSON.`,
      'Show Output',
    );
    if (choice) ctx.output.show();
  } else {
    void vscode.window.showInformationMessage(
      installed ? `Installed the Claude Code hooks in ${installed} worktree(s). Chats started from now on report their state.` : 'The Claude Code hooks are already installed.',
    );
  }
}

/** Once per repository: offers the hooks when a worktree has chats but no hooks. */
const upgraded = new Set<string>();

/**
 * Brings Flotilla's hooks up to date (quietly) in worktrees where they were installed before: a new version adds
 * what chats get from them (the backlog's guide, agent names). Where they never were, nothing is installed.
 */
export async function upgradeHooks(ctx: ChatContext): Promise<void> {
  for (const ws of ctx.workstreams()) {
    const root = ws.worktree.path;
    if (!root || ws.hasHooks || upgraded.has(root)) continue;
    upgraded.add(root);
    if (!(await hooksPresent(root))) continue;
    try {
      await installHooks(root, ctx.commonDir);
      ctx.output.appendLine(`Updated the Claude Code hooks in ${root}.`);
    } catch (error) {
      ctx.output.appendLine(`Could not update the hooks in ${root}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export async function maybeOfferHooks(ctx: ChatContext): Promise<void> {
  const key = `${HOOKS_OFFERED_KEY}:${ctx.mainRoot}`;
  if (ctx.extension.globalState.get<boolean>(key)) return;
  const candidates = ctx.workstreams().filter((w) => w.worktree.path && !w.hasHooks && w.chats.length > 0);
  if (!candidates.length) return;
  await ctx.extension.globalState.update(key, true);
  const choice = await vscode.window.showInformationMessage(
    'Show whether each Claude Code chat is working, waiting for you or finished? Flotilla adds hooks to each worktree\'s .claude/settings.local.json (not committed).',
    'Install Hooks',
    'Not Now',
  );
  if (choice === 'Install Hooks') await installChatHooks(ctx);
}

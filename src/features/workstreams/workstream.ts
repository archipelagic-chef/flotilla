import { runGit } from '../../core/git/gitCli';
import { parseStatusV2, type FileChange, type StatusBranch } from '../../core/git/porcelain';
import { isInside, samePath } from '../../core/paths';
import { claudeHome, homedElsewhere, mergeChats, mostUrgent, readChatRecords, readTranscript, readTranscripts, readUnlinked, type Chat, type TranscriptInfo } from '../chats/chats';
import { hooksInstalled } from '../chats/hookInstall';
import type { ResolvedWorktree } from '../worktrees/resolver';
import type { WorktreeService } from '../worktrees/worktreeService';
import { classifyActivity, lastActivity, type ActivityLevel } from './activity';
import { readAgentStatus, type AgentStatus } from './agentStatus';
import { computeAttention, sortByAttention, type AttentionState } from './attention';
import { isAlive, readHeartbeat, type Heartbeat } from './heartbeat';
import { computeProgress, resolveBase, type Progress } from './progress';

export interface WorkstreamSettings {
  activeWindowMinutes: number;
  staleAfterDays: number;
  agentStatusStaleMinutes: number;
  defaultBase: string;
}

/** The branch's relation to its upstream. */
export interface SyncState {
  upstream: string | undefined;
  /** Commits to push. */
  ahead: number;
  /** Commits to pull. */
  behind: number;
  /** The repository has at least one remote, so an unpublished branch can be published. */
  hasRemote: boolean;
}

export interface Workstream {
  /** Stable id: the worktree's admin dir. */
  key: string;
  worktree: ResolvedWorktree;
  changes: FileChange[];
  staged: FileChange[];
  unstaged: FileChange[];
  sync: SyncState;
  /** Chats linked to this worktree, open ones first. */
  chats: Chat[];
  /** Flotilla's Claude Code hooks are installed in this worktree. */
  hasHooks: boolean;
  /** The most urgent open chat, or the legacy workstream.json report. */
  agent: AgentStatus | undefined;
  agentStale: boolean;
  heartbeat: Heartbeat | undefined;
  windowOpen: boolean;
  lastActivity: Date | undefined;
  activity: ActivityLevel;
  progress: Progress | undefined;
  attention: AttentionState;
  isCurrent: boolean;
}

export interface BuildOptions {
  currentWorktreeRoot: string | undefined;
  settings: WorkstreamSettings;
  now: Date;
  onInvalidStatus?: (file: string) => void;
  /** Claude Code's config dir (default ~/.claude); transcripts live under it. */
  claudeHome?: string;
}

/** A chat that reported nothing for this long no longer counts as open. */
export const CHAT_OPEN_HOURS = 8;

function agentFromChat(chat: Chat | undefined): AgentStatus | undefined {
  if (!chat || chat.state === 'ended') return undefined;
  return { state: chat.state, message: chat.message, updatedAt: chat.updatedAt };
}

export async function buildWorkstreams(service: WorktreeService, opts: BuildOptions): Promise<Workstream[]> {
  const worktrees = await service.list();
  const [base, hasRemote] = await Promise.all([resolveBase(service.roots.mainRoot, opts.settings.defaultBase), hasAnyRemote(service.roots.mainRoot)]);
  const items = await Promise.all(worktrees.map((wt) => buildOne(wt, base, hasRemote, opts)));
  return sortByAttention(items);
}

async function hasAnyRemote(cwd: string): Promise<boolean> {
  try {
    return (await runGit(['remote'], { cwd })).trim() !== '';
  } catch {
    return false;
  }
}

async function buildOne(wt: ResolvedWorktree, base: string | undefined, hasRemote: boolean, opts: BuildOptions): Promise<Workstream> {
  const gitDir = wt.adminDir;
  const [legacyAgent, heartbeat, records, unlinked, transcripts, hasHooks] = await Promise.all([
    readAgentStatus(gitDir, opts.onInvalidStatus),
    readHeartbeat(gitDir),
    readChatRecords(gitDir),
    readUnlinked(gitDir),
    wt.path ? readTranscripts(wt.path, opts.claudeHome ?? claudeHome()) : Promise.resolve([]),
    wt.path ? hooksInstalled(wt.path) : Promise.resolve(false),
  ]);
  // Chats linked here from elsewhere keep their transcript (title, activity) under the directory they run in.
  const home = opts.claudeHome ?? claudeHome();
  const known = new Set(transcripts.map((t) => t.sessionId));
  const linked = await Promise.all(
    records.filter((r) => r.cwd && !known.has(r.sessionId) && !(wt.path && samePath(r.cwd, wt.path))).map((r) => readTranscript(r.cwd!, r.sessionId, home)),
  );
  const allTranscripts = [...transcripts, ...linked.filter((t): t is TranscriptInfo => t !== undefined)];
  // Chats that run here but were linked to another worktree are listed there, not here.
  const hidden = new Set([...unlinked, ...homedElsewhere(records, gitDir)]);
  const chats = mergeChats(
    records.filter((r) => !hidden.has(r.sessionId)),
    allTranscripts,
    hidden,
    { now: opts.now, openHours: CHAT_OPEN_HOURS, staleMinutes: opts.settings.agentStatusStaleMinutes },
  );
  const agent = agentFromChat(mostUrgent(chats)) ?? legacyAgent;
  let changes: FileChange[] = [];
  let staged: FileChange[] = [];
  let unstaged: FileChange[] = [];
  let branch: StatusBranch = { ahead: 0, behind: 0 };
  let progress: Progress | undefined;
  let last: Date | undefined;
  if (wt.path) {
    try {
      ({ changes, staged, unstaged, branch } = await readStatus(wt.path));
    } catch {
      // treat as no changes; the error shows up when the user acts on the worktree
    }
    last = await lastActivity(wt.path, gitDir, changes.map((c) => c.path));
    progress = await computeProgress(wt.path, base);
  }
  const s = opts.settings;
  const activity = classifyActivity(last, opts.now, s.activeWindowMinutes, s.staleAfterDays);
  const { state, agentStale } = computeAttention({
    reachable: wt.path !== undefined,
    agent,
    activity,
    now: opts.now,
    agentStaleMinutes: s.agentStatusStaleMinutes,
  });
  return {
    key: wt.adminDir,
    worktree: wt,
    changes,
    staged,
    unstaged,
    sync: { upstream: branch.upstream, ahead: branch.ahead, behind: branch.behind, hasRemote },
    chats,
    hasHooks,
    agent,
    agentStale,
    heartbeat,
    windowOpen: isAlive(heartbeat, opts.now),
    lastActivity: last,
    activity,
    progress,
    attention: state,
    isCurrent: wt.path !== undefined && opts.currentWorktreeRoot !== undefined && samePath(wt.path, opts.currentWorktreeRoot),
  };
}

/** The workstream whose worktree contains p (or is p). The innermost wins: the main worktree contains `.worktrees/*`. */
export function findWorkstreamFor<T extends Pick<Workstream, 'worktree'>>(items: readonly T[], p: string): T | undefined {
  let best: T | undefined;
  for (const ws of items) {
    const root = ws.worktree.path;
    if (!root || !(samePath(root, p) || isInside(root, p))) continue;
    if (!best || best.worktree.path!.length < root.length) best = ws;
  }
  return best;
}

/** A worktree's git status: its changes, split into staged and unstaged, and its branch's upstream state. */
export async function readStatus(dir: string): Promise<ReturnType<typeof parseStatusV2>> {
  return parseStatusV2(await runGit(['status', '--porcelain=v2', '--branch', '-z'], { cwd: dir }));
}

/**
 * Refreshes only the git status of one workstream (after staging, committing, …), so the UI follows at once.
 * Progress, activity and chats keep their last values until the next full refresh.
 */
export async function withFreshStatus(ws: Workstream): Promise<Workstream> {
  if (!ws.worktree.path) return ws;
  const { changes, staged, unstaged, branch } = await readStatus(ws.worktree.path);
  return { ...ws, changes, staged, unstaged, sync: { ...ws.sync, upstream: branch.upstream, ahead: branch.ahead, behind: branch.behind } };
}

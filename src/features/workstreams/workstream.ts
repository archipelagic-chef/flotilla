import { runGit } from '../../core/git/gitCli';
import { parseStatusV2, summariseUntracked, type FileChange, type StatusBranch } from '../../core/git/porcelain';
import { isInside, samePath } from '../../core/paths';
import type { Scope } from '../../core/repository';
import { claudeHome, homedElsewhere, mergeChats, mostUrgent, readChatRecords, readTranscript, readTranscripts, readUnlinked, type Chat, type TranscriptInfo } from '../chats/chats';
import { hooksInstalled } from '../chats/hookInstall';
import type { ResolvedWorktree } from '../worktrees/resolver';
import type { WorktreeService } from '../worktrees/worktreeService';
import { classifyActivity, lastActivity, MAX_PATHS, type ActivityLevel } from './activity';
import { readAgentStatus, type AgentStatus } from './agentStatus';
import { computeAttention, sortByAttention, type AttentionState } from './attention';
import { isAlive, readHeartbeat, type Heartbeat } from './heartbeat';
import { computeProgress, resolveBase, resolveCommit, type Progress } from './progress';
import { isRebuildDue } from './refreshPlan';

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
  /** The commit checked out (undefined before the first commit). */
  head?: string;
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
  /** When this entry was built (ms since the epoch). */
  refreshedAt: number;
}

/** A refresh of a snapshot: only the worktrees the scope names, and those due by their schedule, are rebuilt. */
export interface RefreshOptions {
  scope: Scope;
  /** The snapshot being refreshed; worktrees not rebuilt keep their entries from it. */
  previous: readonly Workstream[];
  /** How often a live worktree is rebuilt (see refreshPlan.ts). */
  pollMs: number;
  /** The worktree picked in the sidebar. */
  activeKey?: string;
}

export interface BuildOptions {
  currentWorktreeRoot: string | undefined;
  settings: WorkstreamSettings;
  now: Date;
  onInvalidStatus?: (file: string) => void;
  /** Claude Code's config dir (default ~/.claude); transcripts live under it. */
  claudeHome?: string;
  /** Without it, every worktree is built. */
  refresh?: RefreshOptions;
}

/** A chat that reported nothing for this long no longer counts as open. */
export const CHAT_OPEN_HOURS = 8;

function agentFromChat(chat: Chat | undefined): AgentStatus | undefined {
  if (!chat || chat.state === 'ended') return undefined;
  return { state: chat.state, message: chat.message, updatedAt: chat.updatedAt };
}

export async function buildWorkstreams(service: WorktreeService, opts: BuildOptions): Promise<Workstream[]> {
  const worktrees = await service.list();
  const previous = new Map((opts.refresh?.previous ?? []).map((ws) => [ws.key, ws]));
  // The repository's facts are read once, and only if a worktree is rebuilt.
  let repo: Promise<RepoFacts> | undefined;
  const items = await Promise.all(
    worktrees.map(async (wt) => {
      const prev = previous.get(wt.adminDir);
      const refresh = opts.refresh;
      if (refresh && !isRebuildDue(prev, refresh.scope, opts.now.getTime(), refresh.pollMs, refresh.activeKey)) return { ...prev!, worktree: wt };
      repo ??= readRepoFacts(service.roots.mainRoot, opts.settings.defaultBase);
      return buildOne(wt, await repo, opts, prev);
    }),
  );
  return sortByAttention(items);
}

interface RepoFacts {
  base: string | undefined;
  baseHead: string | undefined;
  hasRemote: boolean;
}

async function readRepoFacts(mainRoot: string, defaultBase: string): Promise<RepoFacts> {
  const [base, hasRemote] = await Promise.all([resolveBase(mainRoot, defaultBase), hasAnyRemote(mainRoot)]);
  const baseHead = base ? await resolveCommit(mainRoot, base) : undefined;
  return { base, baseHead, hasRemote };
}

async function hasAnyRemote(cwd: string): Promise<boolean> {
  try {
    return (await runGit(['remote'], { cwd })).trim() !== '';
  } catch {
    return false;
  }
}

async function buildOne(
  wt: ResolvedWorktree,
  repo: RepoFacts,
  opts: BuildOptions,
  prev: Workstream | undefined,
): Promise<Workstream> {
  const { base, baseHead, hasRemote } = repo;
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
    const next = { head: branch.oid, base, baseHead, changes, last };
    progress = prev && canReuseProgress(prev, next) ? prev.progress : await computeProgress(wt.path, base, baseHead);
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
    sync: { upstream: branch.upstream, ahead: branch.ahead, behind: branch.behind, hasRemote, head: branch.oid },
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
    refreshedAt: opts.now.getTime(),
  };
}

/**
 * Progress (log, rev-list, merge-base, diff-index) only changes with HEAD, the base commit, the changed files or
 * their contents. Contents show in the newest mtime, which is only checked for the first MAX_PATHS changed files.
 */
export function canReuseProgress(
  prev: Workstream,
  next: { head: string | undefined; base: string | undefined; baseHead: string | undefined; changes: readonly FileChange[]; last: Date | undefined },
): boolean {
  return (
    prev.progress !== undefined &&
    prev.sync.head === next.head &&
    prev.progress.base === next.base &&
    prev.progress.baseHead === next.baseHead &&
    prev.lastActivity?.getTime() === next.last?.getTime() &&
    next.changes.length <= MAX_PATHS &&
    JSON.stringify(prev.changes) === JSON.stringify(next.changes)
  );
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
  return summariseUntracked(parseStatusV2(await runGit(['status', '--porcelain=v2', '--branch', '-z'], { cwd: dir })));
}

/**
 * Refreshes only the git status of one workstream (after staging, committing, …), so the UI follows at once.
 * Progress, activity and chats keep their last values until the next full refresh.
 */
export async function withFreshStatus(ws: Workstream): Promise<Workstream> {
  if (!ws.worktree.path) return ws;
  const { changes, staged, unstaged, branch } = await readStatus(ws.worktree.path);
  return { ...ws, changes, staged, unstaged, sync: { ...ws.sync, upstream: branch.upstream, ahead: branch.ahead, behind: branch.behind, head: branch.oid } };
}

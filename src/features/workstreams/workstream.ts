import { runGit } from '../../core/git/gitCli';
import { parseStatusV2, type FileChange } from '../../core/git/porcelain';
import { samePath } from '../../core/paths';
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

export interface Workstream {
  /** Stable id: the worktree's admin dir. */
  key: string;
  worktree: ResolvedWorktree;
  changes: FileChange[];
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
}

export async function buildWorkstreams(service: WorktreeService, opts: BuildOptions): Promise<Workstream[]> {
  const worktrees = await service.list();
  const base = await resolveBase(service.roots.mainRoot, opts.settings.defaultBase);
  const items = await Promise.all(worktrees.map((wt) => buildOne(wt, base, opts)));
  return sortByAttention(items);
}

async function buildOne(wt: ResolvedWorktree, base: string | undefined, opts: BuildOptions): Promise<Workstream> {
  const gitDir = wt.adminDir;
  const [agent, heartbeat] = await Promise.all([readAgentStatus(gitDir, opts.onInvalidStatus), readHeartbeat(gitDir)]);
  let changes: FileChange[] = [];
  let progress: Progress | undefined;
  let last: Date | undefined;
  if (wt.path) {
    try {
      changes = parseStatusV2(await runGit(['status', '--porcelain=v2', '-z'], { cwd: wt.path })).changes;
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

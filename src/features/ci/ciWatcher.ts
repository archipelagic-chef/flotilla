import { finished, isActive, overall, type CiRun, type CiStatus } from './githubActions';

/** How long a branch's runs are kept before they're read again: a minute, or 10 s while one is queued or running. */
export const CHECK_MS = 60_000;
export const ACTIVE_CHECK_MS = 10_000;

/** Which finished runs to tell the user about: the failures (default), every one, or none. */
export type CiNotify = 'failures' | 'all' | 'off';

/** A worktree's branch, as far as CI goes: where its runs are on GitHub, or why it has none. */
export interface CiTarget {
  key: string;
  /** Changes with HEAD or the upstream: a push is read at once. */
  revision: string;
  github?: { owner: string; repo: string; branch: string };
  /** Why there are no runs to read (not published, not on GitHub). */
  note?: string;
}

/** What the sidebar shows for a worktree's branch. */
export interface CiView {
  /** The worst of the branch's workflows' latest runs; undefined before any run. */
  state?: CiStatus;
  /** Workflows whose latest run failed. */
  failed: string[];
  /** The branch's runs on GitHub. */
  url?: string;
  /** Why there's no state, or what the API said when it couldn't be read. */
  note?: string;
}

/** The part of the GitHub Actions client the watcher reads runs with. */
export interface CiRuns {
  runs(branch: string, limit?: number): Promise<CiRun[]>;
}

export interface CiWatcherOptions {
  /** A client for a repository, or undefined when there's no GitHub sign-in to read it with. */
  clientFor(owner: string, repo: string): Promise<CiRuns | undefined>;
  now?: () => number;
}

export interface FinishedRun {
  key: string;
  run: CiRun;
}

interface Snapshot {
  revision: string;
  runs: CiRun[];
  checked: number;
  view: CiView;
}

/** The latest runs of every worktree's branch, read on a schedule (and at once when the branch moves). */
export class CiWatcher {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly now: () => number;

  constructor(private readonly options: CiWatcherOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Reads the targets that are due, and returns the runs that finished since they were last read while they were
   * running (a run that was already done when first read is not news).
   */
  async poll(targets: readonly CiTarget[]): Promise<FinishedRun[]> {
    const now = this.now();
    const keys = new Set(targets.map((t) => t.key));
    for (const key of this.snapshots.keys()) if (!keys.has(key)) this.snapshots.delete(key);
    const finishedRuns: FinishedRun[] = [];
    await Promise.all(
      targets.map(async (target) => {
        const before = this.snapshots.get(target.key);
        if (before && before.revision === target.revision && now - before.checked < intervalFor(before.runs)) return;
        const runs = before?.runs ?? [];
        if (!target.github) {
          this.snapshots.set(target.key, { revision: target.revision, runs: [], checked: now, view: { failed: [], note: target.note } });
          return;
        }
        const { owner, repo, branch } = target.github;
        const url = `https://github.com/${owner}/${repo}/actions?query=${encodeURIComponent(`branch:${branch}`)}`;
        try {
          const client = await this.options.clientFor(owner, repo);
          if (!client) {
            this.snapshots.set(target.key, { revision: target.revision, runs, checked: now, view: { ...ciView(runs, url), note: 'Sign in to GitHub to see its CI.' } });
            return;
          }
          const latest = await client.runs(branch);
          finishedRuns.push(...finished(runs, latest).map((run) => ({ key: target.key, run })));
          this.snapshots.set(target.key, { revision: target.revision, runs: latest, checked: now, view: ciView(latest, url) });
        } catch (error) {
          const note = error instanceof Error ? error.message : String(error);
          this.snapshots.set(target.key, { revision: target.revision, runs, checked: now, view: { ...ciView(runs, url), note } });
        }
      }),
    );
    return finishedRuns;
  }

  /** What each worktree (by key) shows, as last read. */
  views(): Record<string, CiView> {
    return Object.fromEntries([...this.snapshots].map(([key, s]) => [key, s.view]));
  }
}

/** A branch's view from its runs (newest first) and the page that lists them. */
export function ciView(runs: readonly CiRun[], url?: string): CiView {
  const latest = new Map<string, CiRun>();
  for (const r of runs) if (!latest.has(r.workflow)) latest.set(r.workflow, r);
  const failed = [...latest.values()].filter((r) => r.status === 'failure').map((r) => r.workflow);
  return { state: overall(runs), failed, ...(url ? { url } : {}) };
}

/** Whether a finished run is one to tell the user about under this setting. */
export function notifies(run: CiRun, mode: CiNotify): boolean {
  return mode === 'all' || (mode === 'failures' && run.status === 'failure');
}

function intervalFor(runs: readonly CiRun[]): number {
  return runs.some((r) => isActive(r.status)) ? ACTIVE_CHECK_MS : CHECK_MS;
}

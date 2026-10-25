import { runGit } from '../../core/git/gitCli';
import {
  type CiJob,
  type CiRun,
  type CiStatus,
  isActive,
} from '../ci/githubActions';
import { PUSH_REMOTE, runsOnPush } from './branchPush';

/**
 * Merge to main on CI's result (BL-105): when GitHub Actions ran on the branch's pushed tip, and the merge's tree is
 * that tip's (the branch has the base's tip in it), CI's result decides and nothing runs locally. Otherwise the local
 * checks run, and the ticket says why CI wasn't used.
 */

/** flotilla.merge.checks: CI's result (local checks when there's no CI), or always the local checks. */
export type MergeChecks = 'ci' | 'local';

/** What reads the repository's runs on GitHub (GitHubActions does). */
export interface CiReader {
  runs(branch: string, limit?: number): Promise<CiRun[]>;
  jobs(runId: number): Promise<CiJob[]>;
}

export interface FailedJob {
  run: CiRun;
  job: CiJob;
}

export type CiDecision =
  /** The local checks: the setting says so (no why), or there's no CI for the tip (why says what's missing). */
  | { kind: 'local'; why?: string }
  /** The base has moved on since the branch took it in: CI checked another tree than the merge's. */
  | { kind: 'moved'; tip: string }
  /** CI goes on (runs: none yet, just after the push): the merge waits for it. */
  | { kind: 'running'; tip: string; runs: CiRun[] }
  | { kind: 'passed'; tip: string; runs: CiRun[] }
  /** runs: the ones that failed or were cancelled; jobs: their jobs that did (with the logs' links). */
  | { kind: 'failed'; tip: string; runs: CiRun[]; jobs: FailedJob[] };

/** How long after a push its runs may not be on GitHub yet: the merge waits for them that long. */
export const RUNS_APPEAR_MS = 2 * 60_000;

const OK: readonly CiStatus[] = ['success', 'skipped', 'neutral'];

/**
 * The runs that decide a commit: the latest of each workflow on it (a later run of a workflow replaces an earlier one;
 * a re-run keeps its number, and its latest attempt is the one read).
 */
export function commitRuns(runs: readonly CiRun[], sha: string): CiRun[] {
  const latest = new Map<string, CiRun>();
  for (const r of runs) {
    if (r.sha !== sha) continue;
    const seen = latest.get(r.workflow);
    if (!seen || r.number > seen.number) latest.set(r.workflow, r);
  }
  return [...latest.values()].sort((a, b) => a.workflow.localeCompare(b.workflow));
}

/** Where a commit's runs are together: one failed or was cancelled (failed), one goes on (running), or all passed. */
export function runsVerdict(runs: readonly CiRun[]): 'passed' | 'running' | 'failed' {
  if (runs.some((r) => !OK.includes(r.status) && !isActive(r.status))) return 'failed';
  if (!runs.length || runs.some((r) => isActive(r.status))) return 'running';
  return 'passed';
}

const short = (sha: string) => sha.slice(0, 7);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Whether a workflow in the commit's .github/workflows runs on push. */
async function workflowsOnPush(cwd: string, commit: string): Promise<boolean> {
  const files = (await runGit(['ls-tree', '--name-only', `${commit}:.github/workflows`], { cwd }).catch(() => ''))
    .split('\n')
    .filter((f) => /\.ya?ml$/.test(f));
  for (const f of files) if (runsOnPush(await runGit(['show', `${commit}:.github/workflows/${f}`], { cwd }).catch(() => ''))) return true;
  return false;
}

/**
 * What Merge to main decides on, for branch (at tip) into base (at baseTip). reader: GitHub's runs of origin, or why
 * they can't be read (no GitHub origin, no sign-in). pushError: why the branch's last push failed, if it did.
 */
export async function decideCi(o: {
  cwd: string;
  setting: MergeChecks;
  branch: string;
  tip: string;
  baseTip: string;
  reader: CiReader | string;
  pushError?: string;
  now?: number;
}): Promise<CiDecision> {
  if (o.setting === 'local') return { kind: 'local' };
  const { cwd, branch, tip } = o;
  if (!(await workflowsOnPush(cwd, tip))) return { kind: 'local', why: `no workflow in \`${branch}\`'s \`.github/workflows\` runs on push.` };
  const remoteRef = `refs/remotes/${PUSH_REMOTE}/${branch}`;
  const onOrigin = (await runGit(['rev-parse', '--verify', '--quiet', `${remoteRef}^{commit}`], { cwd }).catch(() => '')).trim();
  if (onOrigin !== tip) {
    const why = o.pushError ? `its push failed (${o.pushError.trim()})` : onOrigin ? `origin has \`${short(onOrigin)}\`` : "it isn't on origin";
    return { kind: 'local', why: `\`${branch}\`'s tip \`${short(tip)}\` isn't pushed: ${why}.` };
  }
  if (typeof o.reader === 'string') return { kind: 'local', why: o.reader };
  const inBranch = await runGit(['merge-base', '--is-ancestor', o.baseTip, tip], { cwd }).then(
    () => true,
    () => false,
  );
  if (!inBranch) return { kind: 'moved', tip };
  let runs: CiRun[];
  try {
    runs = commitRuns(await o.reader.runs(branch, 30), tip);
  } catch (error) {
    return { kind: 'local', why: `GitHub's runs couldn't be read: ${message(error)}` };
  }
  if (!runs.length) {
    // Just pushed: GitHub may not have started its runs yet. The remote ref's reflog says when it moved here.
    const at = Number((await runGit(['log', '-g', '-1', '--format=%ct', remoteRef], { cwd }).catch(() => '')).trim()) * 1000;
    if (at && (o.now ?? Date.now()) - at < RUNS_APPEAR_MS) return { kind: 'running', tip, runs };
    return { kind: 'local', why: `no workflow ran on \`${short(tip)}\` on GitHub.` };
  }
  const verdict = runsVerdict(runs);
  if (verdict !== 'failed') return { kind: verdict, tip, runs };
  const failed = runs.filter((r) => !OK.includes(r.status) && !isActive(r.status));
  const jobs: FailedJob[] = [];
  for (const run of failed) {
    const read = await o.reader.jobs(run.id).catch(() => [] as CiJob[]);
    for (const job of read) if (job.status === 'failure' || job.status === 'cancelled') jobs.push({ run, job });
  }
  return { kind: 'failed', tip, runs: failed, jobs };
}

/** A run as a Markdown link: [CI #3](…). */
export const runLink = (r: CiRun): string => `[${r.workflow} #${r.number}](${r.url})`;

/** The runs Merge to main relied on, for the ticket. */
export function passedNote(d: { tip: string; runs: readonly CiRun[] }): string {
  return `CI passed on \`${short(d.tip)}\`: ${d.runs.map(runLink).join(', ')}; no checks ran locally.`;
}

/** Why nothing was merged on red CI, with the failed jobs' logs. */
export function failedNote(d: Extract<CiDecision, { kind: 'failed' }>, branch: string): string {
  const lines = d.jobs.length
    ? d.jobs.map((f) => `- ${f.job.status === 'cancelled' ? 'Cancelled' : 'Failed'}: [${f.job.name}](${f.job.url}) in ${runLink(f.run)}`)
    : d.runs.map((r) => `- ${r.status === 'cancelled' ? 'Cancelled' : 'Failed'}: ${runLink(r)}`);
  return [
    `Not merged: CI ${d.runs.every((r) => r.status === 'cancelled') ? 'was cancelled' : 'failed'} on \`${branch}\` at \`${short(d.tip)}\`. Nothing changed; there's no merging past red CI. Fix with Agent, or run it again.`,
    '',
    ...lines,
  ].join('\n');
}

/** The runs a merge waits for, for the ticket. */
export function waitingNote(d: { tip: string; runs: readonly CiRun[] }, branch: string): string {
  const runs = d.runs.length ? d.runs.map((r) => `${runLink(r)} (${r.status})`).join(', ') : "GitHub hasn't started its runs yet";
  return `Merges when CI passes: \`${branch}\` at \`${short(d.tip)}\`: ${runs}. Cancel it from the merge button.`;
}

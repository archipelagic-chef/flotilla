import * as vscode from 'vscode';
import { runGit } from '../../core/git/gitCli';
import type { Repository } from '../../core/repository';
import { gitHubRepo } from '../../features/backlog/sources/github';
import type { Fetch } from '../../features/backlog/sources/source';
import { CiWatcher, notifies, type CiTarget, type CiView, type FinishedRun } from '../../features/ci/ciWatcher';
import { GitHubActions, splitUpstream, type CiRun } from '../../features/ci/githubActions';
import type { Workstream } from '../../features/workstreams/workstream';
import { workstreamLabel } from '../format';
import { GITHUB_SCOPES } from '../backlog/integrations';
import { readSettings } from '../settings';

/** How often the monitor looks at which branches are due (each has its own interval). */
const TICK_MS = 10_000;

export interface CiMonitorDeps {
  repository: Repository<Workstream>;
  mainRoot: string;
  /** Only the leading window tells the user about finished runs, so several windows don't all notify. */
  isLeader(): boolean;
  /** The sidebar's view of each worktree's CI, as it changes. */
  onChange(views: Record<string, CiView>): void;
  output: vscode.OutputChannel;
}

/** Reads the CI of every worktree's branch while VS Code is open, and tells the user about finished runs. */
export class CiMonitor implements vscode.Disposable {
  private readonly watcher: CiWatcher;
  private readonly timer: NodeJS.Timeout;
  private readonly subscription: { dispose(): void };
  private ticking = false;
  private last = '';

  constructor(private readonly deps: CiMonitorDeps) {
    this.watcher = new CiWatcher({ clientFor: (owner, repo) => this.clientFor(owner, repo) });
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // A change to a worktree (a commit, a push, a checkout) may be a new run: look now rather than at the next tick.
    this.subscription = deps.repository.onDidChange(() => void this.tick());
    void this.tick();
  }

  private async clientFor(owner: string, repo: string): Promise<GitHubActions | undefined> {
    const session = await vscode.authentication.getSession('github', GITHUB_SCOPES, { silent: true });
    if (!session) return undefined;
    return new GitHubActions(owner, repo, async () => session.accessToken, globalThis.fetch as unknown as Fetch);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const finished = await this.watcher.poll(await this.targets());
      const views = this.watcher.views();
      const json = JSON.stringify(views);
      if (json !== this.last) {
        this.last = json;
        this.deps.onChange(views);
      }
      if (this.deps.isLeader()) for (const f of finished) this.notify(f);
    } catch (error) {
      this.deps.output.appendLine(`CI: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Each worktree with a branch: where its upstream's runs are, or why it has none. */
  private async targets(): Promise<CiTarget[]> {
    const remotes = await remoteUrls(this.deps.mainRoot);
    return this.deps.repository.current.flatMap((ws): CiTarget[] => {
      const branch = ws.worktree.branch;
      if (!branch) return [];
      const revision = `${ws.sync.head ?? ''} ${ws.sync.upstream ?? ''}`;
      if (!ws.sync.upstream) return [{ key: ws.key, revision, note: 'Publish this branch to run its CI.' }];
      const split = splitUpstream(ws.sync.upstream, [...remotes.keys()]);
      const github = split && gitHubRepo(remotes.get(split.remote) ?? '');
      if (!split || !github) return [{ key: ws.key, revision, note: 'CI/CD supports GitHub Actions only for now.' }];
      return [{ key: ws.key, revision, github: { ...github, branch: split.branch } }];
    });
  }

  private notify({ key, run }: FinishedRun): void {
    const mode = readSettings().ciNotify;
    if (!notifies(run, mode)) return;
    const ws = this.deps.repository.current.find((w) => w.key === key);
    const what = `${run.workflow} #${run.number} on ${ws ? workstreamLabel(ws) : run.sha.slice(0, 7)}`;
    const failed = run.status === 'failure';
    const text = failed ? `CI failed: ${what}.` : `CI ${run.status === 'success' ? 'passed' : run.status}: ${what}.`;
    const choice = failed ? vscode.window.showWarningMessage(text, 'Show') : vscode.window.showInformationMessage(text, 'Show');
    void choice.then((picked) => {
      if (picked === 'Show' && isGitHubUrl(run)) void vscode.env.openExternal(vscode.Uri.parse(run.url));
    });
  }

  dispose(): void {
    clearInterval(this.timer);
    this.subscription.dispose();
  }
}

/** The repository's remotes and their URLs (empty when there are none). */
async function remoteUrls(cwd: string): Promise<Map<string, string>> {
  const out = await runGit(['config', '--get-regexp', '^remote\\..*\\.url$'], { cwd }).catch(() => '');
  const urls = new Map<string, string>();
  for (const line of out.split('\n')) {
    const m = /^remote\.(.+)\.url (.*)$/.exec(line);
    if (m) urls.set(m[1], m[2]);
  }
  return urls;
}

/** Whether a run's link is a page on GitHub (the only thing the notice opens). */
function isGitHubUrl(run: CiRun): boolean {
  return /^https:\/\/github\.com\//.test(run.url);
}

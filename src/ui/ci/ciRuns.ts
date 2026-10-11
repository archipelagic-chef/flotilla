import * as vscode from 'vscode';
import { runGit } from '../../core/git/gitCli';
import { gitHubName, gitHubRepo } from '../../features/backlog/sources/github';
import type { Fetch } from '../../features/backlog/sources/source';
import { GitHubActions, splitUpstream, type CiRun } from '../../features/ci/githubActions';
import { anyRunActive, ciStamp, refreshDelay } from '../../features/ci/refresh';
import type { Workstream } from '../../features/workstreams/workstream';
import type { CiView } from '../../webview/protocol';

const SCOPES = ['repo'];

/** Where a worktree's runs are: its branch on a GitHub repository, or the view that says why there are none. */
type Where = { kind: 'github'; owner: string; repo: string; branch: string } | { kind: 'view'; view: CiView };

type Session = Pick<vscode.AuthenticationSession, 'accessToken'>;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The CI/CD view's data: the latest workflow runs of each worktree's branch on GitHub, read through the user's GitHub
 * sign-in. Read at once when the sidebar shows and when a worktree's commit or upstream moves (a push), then every
 * minute while it's shown (every 10 seconds while a run goes on); nothing while it's hidden.
 */
export class CiRuns implements vscode.Disposable {
  private views = new Map<string, CiView>();
  private workstreams: readonly Workstream[] = [];
  private stamps = new Map<string, string>();
  private visible = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** post sends the views of every worktree to the sidebar. */
  constructor(private readonly post: (views: Record<string, CiView>) => void) {}

  dispose(): void {
    clearTimeout(this.timer);
  }

  /** The worktrees changed: the ones whose commit or upstream moved are read again (while shown). */
  update(workstreams: readonly Workstream[]): void {
    const moved = workstreams.filter((ws) => this.stamps.get(ws.key) !== ciStamp(ws));
    this.workstreams = workstreams;
    for (const ws of workstreams) this.stamps.set(ws.key, ciStamp(ws));
    const gone = [...this.views.keys()].filter((key) => !workstreams.some((ws) => ws.key === key));
    for (const key of gone) this.views.delete(key);
    if (this.visible && moved.length) void this.load(moved.map((ws) => ws.key));
    else if (gone.length) this.post(this.snapshot());
  }

  /** The sidebar is shown (reads now, then regularly) or hidden (nothing is read). */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) void this.load();
    else clearTimeout(this.timer);
  }

  /** Reads every worktree's runs now. */
  refresh(): Promise<void> {
    return this.load();
  }

  /** Asks for the GitHub sign-in (a dialog, unlike the silent reads), then reads the runs. */
  async signIn(): Promise<void> {
    await vscode.authentication.getSession('github', SCOPES, { createIfNone: true });
    await this.load();
  }

  /** The views as last read, of the worktrees there are now (sent to a sidebar that has just loaded). */
  snapshot(): Record<string, CiView> {
    return Object.fromEntries([...this.views].filter(([key]) => this.workstreams.some((ws) => ws.key === key)));
  }

  private async load(keys?: string[]): Promise<void> {
    clearTimeout(this.timer);
    const targets = this.workstreams.filter((ws) => !keys || keys.includes(ws.key));
    const wheres = await Promise.all(targets.map(async (ws) => ({ ws, where: await this.where(ws) })));
    const github = wheres.some((w) => w.where?.kind === 'github');
    // Without a sign-in (or a provider to ask), the runs say so: they're not read.
    const session = github ? await vscode.authentication.getSession('github', SCOPES, { silent: true }).then((s) => s, () => undefined) : undefined;
    // Worktrees on the same branch share one read.
    const reads = new Map<string, Promise<CiRun[]>>();
    await Promise.all(
      wheres.map(async ({ ws, where }) => {
        if (where) this.views.set(ws.key, await this.viewOf(ws, where, session, reads));
      }),
    );
    this.post(this.snapshot());
    // The last load to finish sets the next one (a load that overlapped another doesn't leave a second timer running).
    const anyActive = anyRunActive([...this.views.values()].flatMap((v) => (v.kind === 'runs' ? v.runs : [])));
    const delay = refreshDelay(this.visible, anyActive);
    clearTimeout(this.timer);
    this.timer = delay === undefined ? undefined : setTimeout(() => void this.load(), delay);
  }

  /** Where a worktree's runs are; undefined when its folder isn't reachable here. */
  private async where(ws: Workstream): Promise<Where | undefined> {
    const cwd = ws.worktree.path;
    if (!cwd) return undefined;
    const upstream = ws.sync.upstream;
    if (!upstream) return { kind: 'view', view: { kind: 'unpublished' } };
    try {
      const remotes = (await runGit(['remote'], { cwd })).split('\n').filter(Boolean);
      const split = splitUpstream(upstream, remotes);
      if (!split) return { kind: 'view', view: { kind: 'error', error: `The upstream ${upstream} is not on a remote of this repository.` } };
      const gh = gitHubRepo((await runGit(['remote', 'get-url', split.remote], { cwd })).trim());
      if (!gh || !gitHubName(gh.owner) || !gitHubName(gh.repo)) return { kind: 'view', view: { kind: 'unsupported' } };
      return { kind: 'github', owner: gh.owner, repo: gh.repo, branch: split.branch };
    } catch (error) {
      return { kind: 'view', view: { kind: 'error', error: message(error) } };
    }
  }

  private async viewOf(ws: Workstream, where: Where, session: Session | undefined, reads: Map<string, Promise<CiRun[]>>): Promise<CiView> {
    if (where.kind === 'view') return where.view;
    if (!session) return { kind: 'signIn' };
    const { owner, repo, branch } = where;
    const token = session.accessToken;
    const id = `${owner}/${repo}@${branch}`;
    try {
      let read = reads.get(id);
      if (!read) {
        read = new GitHubActions(owner, repo, async () => token, globalThis.fetch as unknown as Fetch).runs(branch);
        reads.set(id, read);
      }
      const runs = await read;
      // The runs of the commit checked out here are marked.
      return { kind: 'runs', repo: `${owner}/${repo}`, branch, runs: runs.map((r) => ({ ...r, current: r.sha === ws.sync.head })) };
    } catch (error) {
      return { kind: 'error', error: message(error) };
    }
  }
}

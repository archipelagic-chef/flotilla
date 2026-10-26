import * as vscode from 'vscode';
import type { PushResult } from '../../features/backlog/branchPush';
import { latestCi } from '../../features/ci/summary';
import type { CiRuns } from '../ci/ciRuns';
import type { CiView } from '../../webview/protocol';
import type { TicketCiView, TicketHostMessage, TicketWebviewMessage } from '../../webview/ticketProtocol';

/** The key the tickets whose CI is kept open are remembered under, per repository. */
const OPEN_KEY = 'flotilla.ticket.ciOpen';

export interface TicketCiDeps {
  /** The CI/CD view's reader: the ticket shows the same views, and asks it for the same reads and actions. */
  ci: CiRuns;
  /** Shows a worktree's CI/CD view in the sidebar. */
  showCi(key: string): void;
  /** Where the open ones are remembered (across windows), and the repository they're of. */
  memento: vscode.Memento;
  mainRoot: string;
  /** Run CI's push (BL-222): pushes the ticket's branch to origin, noting it in the ticket; undefined when it can't. */
  push?(id: string, branch: string): Promise<PushResult | undefined>;
  /** Run Workflow… (BL-222): its dialogs and dispatch on a worktree's branch; true when a run was started. */
  runWorkflow?(key: string): Promise<boolean>;
}

/** GitHub lists a new run a few seconds after it's started: the runs are read again then. */
const RUN_LISTED_MS = 5_000;

interface Shown {
  panel: vscode.WebviewPanel;
  worktrees: Array<{ key: string; branch: string; ahead?: number; upstream?: string }>;
  /** What was last sent, to send only a change. */
  sent?: string;
}

/**
 * A ticket's CI (BL-106): the runs of its worktrees' branches, as the CI/CD view reads them. A ticket watches its
 * worktrees while its tab is visible, so they're read when it shows and, while a run goes on, every 10 seconds.
 */
export class TicketCi implements vscode.Disposable {
  private readonly shown = new Map<string, Shown>();
  private readonly subscription: vscode.Disposable;

  constructor(private readonly deps: TicketCiDeps) {
    this.subscription = deps.ci.onDidChange((views) => {
      for (const id of this.shown.keys()) this.send(id, views);
    });
  }

  dispose(): void {
    this.subscription.dispose();
    for (const id of this.shown.keys()) this.deps.ci.unwatch(id);
    this.shown.clear();
  }

  /** A ticket's tab opened: it watches its worktrees while it's visible, and stops when it's closed. */
  open(id: string, panel: vscode.WebviewPanel): vscode.Disposable {
    this.shown.set(id, { panel, worktrees: [] });
    const visibility = panel.onDidChangeViewState(() => this.watch(id));
    return {
      dispose: () => {
        visibility.dispose();
        if (this.shown.get(id)?.panel !== panel) return;
        this.shown.delete(id);
        this.deps.ci.unwatch(id);
      },
    };
  }

  /** The ticket's worktrees, as its view shows them: their CI is what it shows. */
  setWorktrees(id: string, worktrees: Shown['worktrees']): void {
    const shown = this.shown.get(id);
    if (!shown || JSON.stringify(shown.worktrees) === JSON.stringify(worktrees)) return;
    shown.worktrees = worktrees;
    this.watch(id);
    this.send(id, this.deps.ci.snapshot());
  }

  /** The webview loaded again: it gets the CI once more. */
  resend(id: string): void {
    const shown = this.shown.get(id);
    if (!shown) return;
    shown.sent = undefined;
    this.send(id, this.deps.ci.snapshot());
  }

  /** What the ticket's CI asks: to open or close it (remembered), to show the CI/CD view, or the CI/CD view's requests. */
  async handle(id: string, m: Extract<TicketWebviewMessage, { type: 'ci' | 'ciOpen' | 'ciShow' }>): Promise<void> {
    const ci = this.deps.ci;
    if (m.type === 'ciOpen') {
      await this.keepOpen(id, m.open);
      this.resend(id);
      return;
    }
    if (m.type === 'ciShow') return this.deps.showCi(m.key);
    // Only the ticket's own worktrees: a message can't reach another's runs.
    if ('key' in m && !this.shown.get(id)?.worktrees.some((w) => w.key === m.key)) return;
    switch (m.op) {
      case 'signIn':
        return ci.signIn();
      case 'refresh':
        return ci.refresh();
      case 'expand':
      case 'collapse':
        return ci.expand(m.key, m.runId, m.op === 'expand', id);
      case 'showLog':
        return ci.showLog(m.key, m.jobId, m.jobName);
      case 'act':
        return ci.act(m.key, m.run, m.action);
      case 'fix':
        return ci.fix(m.key, m.run, m.job);
      case 'runCi':
        return this.runCi(id, m.key);
      case 'runWorkflow': {
        const run = this.deps.runWorkflow;
        if (run && (await ci.runWorkflow(m.key, () => run(m.key)))) this.listedSoon();
        return;
      }
    }
  }

  /**
   * Run CI (BL-222): pushes the branch when origin lacks its head (which starts the workflows that run on push), and
   * re-runs its latest run otherwise. A push that's refused is noted in the ticket, as on approval.
   */
  private async runCi(id: string, key: string): Promise<void> {
    const ci = this.deps.ci;
    const branch = this.shown.get(id)?.worktrees.find((w) => w.key === key)?.branch;
    const push = this.deps.push;
    if (!branch || !push) return;
    let refused: PushResult | undefined;
    const pushed = await ci.runWorkflow(
      key,
      async () => {
        const result = await push(id, branch);
        if (!result) return false;
        if (result.kind === 'pushed') return true;
        if (result.kind !== 'up-to-date') {
          refused = result;
          return false;
        }
        // Origin has it: its latest run goes again.
        const latest = latestCi(ci.snapshot()[key]);
        if (!latest) {
          void vscode.window.showInformationMessage(`Origin has ${branch}'s latest commit, and no run of it is listed yet. Run Workflow… starts one by hand.`);
        } else if (latest.run.status === 'queued' || latest.run.status === 'running') {
          void vscode.window.showInformationMessage(`${latest.run.workflow} #${latest.run.number} is already running on ${branch}.`);
        } else await ci.act(key, latest.run.id, 'rerun');
        return false;
      },
      'runCi',
    );
    if (pushed) this.listedSoon();
    if (refused) void vscode.window.showWarningMessage(`Didn't push ${branch} to origin: the ticket says why.`);
  }

  /** The runs are read again once GitHub lists the new one. */
  private listedSoon(): void {
    setTimeout(() => void this.deps.ci.refresh(true), RUN_LISTED_MS);
  }

  /** Watches the ticket's worktrees while its tab is visible; a hidden tab reads nothing. */
  private watch(id: string): void {
    const shown = this.shown.get(id);
    if (!shown) return;
    this.deps.ci.watch(id, shown.panel.visible ? shown.worktrees.map((w) => w.key) : []);
  }

  private isOpen(id: string): boolean {
    return this.deps.memento.get<string[]>(OPEN_KEY, []).includes(`${this.deps.mainRoot}#${id}`);
  }

  private keepOpen(id: string, open: boolean): Thenable<void> {
    const entry = `${this.deps.mainRoot}#${id}`;
    const rest = this.deps.memento.get<string[]>(OPEN_KEY, []).filter((e) => e !== entry);
    return this.deps.memento.update(OPEN_KEY, open ? [...rest, entry] : rest);
  }

  private send(id: string, views: Record<string, CiView>): void {
    const shown = this.shown.get(id);
    if (!shown) return;
    const ci: TicketCiView = { open: this.isOpen(id), worktrees: shown.worktrees.map((w) => ({ ...w, view: views[w.key] })) };
    const text = JSON.stringify(ci);
    if (text === shown.sent) return;
    shown.sent = text;
    void shown.panel.webview.postMessage({ type: 'ci', ci } satisfies TicketHostMessage);
  }
}

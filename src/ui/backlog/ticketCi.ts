import * as vscode from 'vscode';
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
}

interface Shown {
  panel: vscode.WebviewPanel;
  worktrees: Array<{ key: string; branch: string }>;
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
  setWorktrees(id: string, worktrees: Array<{ key: string; branch: string }>): void {
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
    }
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

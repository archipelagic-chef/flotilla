import * as vscode from 'vscode';
import { runGit } from '../../core/git/gitCli';
import type { Repository } from '../../core/repository';
import { itemBranches, type BacklogItem } from '../../features/backlog/backlog';
import { pushBranch, pushedInfo, pushNote, pushOnApproval, type PushSetting } from '../../features/backlog/branchPush';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import { entryDate } from '../../features/backlog/ticket';
import type { Workstream } from '../../features/workstreams/workstream';

export interface BranchPushDeps {
  backlog: LocalBacklog;
  repository: Repository<Workstream>;
  mainRoot: string;
  /** Only the leading window pushes (and notes it in the tickets). */
  isLeader: () => boolean;
  output: vscode.OutputChannel;
}

/** An approved ticket, not merged yet: its branches are pushed. */
export const pushable = (i: BacklogItem): boolean => i.status === 'review' && i.review?.state === 'approved' && !i.proposed && !i.merged;

/**
 * Pushes approved tickets' branches to origin so CI runs on them before Merge to main (BL-104): when a ticket is
 * approved, and again when its branch gets new commits while it's approved. Each tip is pushed (or refused) once: the
 * last one is kept on the item, and the ticket notes it. flotilla.ci.pushOnApproval turns it off.
 */
export class BranchPush implements vscode.Disposable {
  private readonly subscriptions: Array<{ dispose(): void }> = [];
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  /** Approved since their last push: pushed again even at the same tip (after a failure, say). */
  private readonly fresh = new Set<string>();

  constructor(private readonly deps: BranchPushDeps) {
    // The repository's refresh sees new commits on the branches.
    this.subscriptions.push(deps.repository.onDidChange(() => this.schedule()));
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.subscriptions.forEach((s) => s.dispose());
  }

  /** An item was approved: its branches are pushed now. */
  approved(id: string): void {
    this.fresh.add(id);
    this.schedule(0);
  }

  /** A push soon: a burst of changes pushes once. */
  schedule(delayMs = 5000): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.check(), delayMs);
  }

  async check(): Promise<void> {
    if (!this.deps.isLeader()) return;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.checkNow()
      .catch((e: unknown) => this.deps.output.appendLine(`Pushing approved branches: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        this.running = undefined;
        if (this.again) {
          this.again = false;
          this.schedule(0);
        }
      });
    return this.running;
  }

  private async checkNow(): Promise<void> {
    const cwd = this.deps.mainRoot;
    const items = (await this.deps.backlog.read()).items.filter(pushable);
    const fresh = new Set(this.fresh);
    this.fresh.clear();
    if (!items.length) return;
    const setting = vscode.workspace.getConfiguration('flotilla').get<PushSetting>('ci.pushOnApproval', 'auto');
    if (!(await pushOnApproval(cwd, setting))) return;
    for (const item of items) {
      for (const branch of itemBranches(item)) {
        const tip = (await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], { cwd }).catch(() => '')).trim();
        if (!tip) continue;
        const last = item.pushed?.find((p) => p.branch === branch);
        if (last?.commit === tip && !fresh.has(item.id)) continue;
        this.deps.output.appendLine(`Push: ${branch} (${item.id}) to origin.`);
        const result = await pushBranch(cwd, branch);
        this.deps.output.appendLine(`Push: ${branch}: ${result.kind}${result.kind === 'failed' ? `: ${result.reason}` : ''}`);
        await this.deps.backlog.change(
          (d) => ({
            ...d,
            items: d.items.map((i) =>
              i.id === item.id ? { ...i, pushed: [...(i.pushed ?? []).filter((p) => p.branch !== branch), pushedInfo(result)] } : i,
            ),
          }),
          { by: 'Flotilla' },
        );
        const note = pushNote(result);
        if (note) await this.deps.backlog.appendActivity(item, { date: entryDate(new Date()), author: 'Flotilla', body: note });
      }
    }
  }
}

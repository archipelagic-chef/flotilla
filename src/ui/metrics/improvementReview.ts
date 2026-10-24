import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import { agentChatItem, agentName } from '../../features/backlog/backlog';
import { INBOX } from '../../features/backlog/inbox';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import { eventsDir, readEvents } from '../../features/metrics/events';
import { checkFix, fixesMarkdown, readImproves, type FixCheck } from '../../features/metrics/improves';
import { listReviews, reviewBlocked, reviewDay, reviewDue, reviewPrompt, reviewsDir, reviewTools } from '../../features/metrics/review';
import { metricsSummary, summaryMarkdown } from '../../features/metrics/summary';
import type { Workstream } from '../../features/workstreams/workstream';
import type { AutopilotView } from '../backlog/autopilot';
import { agentChoice, runAgentHeadless, type AgentRun } from '../backlog/agentRunner';
import { trackProgress } from '../progress';

export interface ImprovementReviewDeps {
  backlog: LocalBacklog;
  repository: Repository<Workstream>;
  /** A slot of the agents limit (ReviewLoop.admitNew), given back when the review is done. */
  admit(id: string): number | undefined;
  giveBack(slot: number): void;
  autopilot(): AutopilotView;
  isLeader(): boolean;
  commonDir: string;
  mainRoot: string;
  output: vscode.OutputChannel;
}

/** The id its slot is taken under. */
const SLOT_ID = 'improvement-review';
const CHECK_MS = 60 * 60_000;

function every(): number {
  return Math.max(0, vscode.workspace.getConfiguration('flotilla').get<number>('metrics.reviewEvery', 7));
}

/**
 * The improvement review (BL-159): every flotilla.metrics.reviewEvery days (or Review Now), in the leading window, when
 * no agent works or waits, an agent reads the metrics and the code and writes reviews/YYYY-MM-DD.md, with proposed
 * tickets through the inbox. It takes a slot of the agents limit while it runs.
 */
export class ImprovementReview implements vscode.Disposable {
  private run: AgentRun | undefined;
  private starting = false;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly deps: ImprovementReviewDeps) {
    this.timer = setInterval(() => void this.tick().catch(() => undefined), CHECK_MS);
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  get running(): boolean {
    return !!this.run || this.starting;
  }

  /** Starts the review when one is due and nothing keeps it (see reviewBlocked). */
  async tick(now = new Date()): Promise<void> {
    if (this.running || !this.deps.isLeader()) return;
    if (!reviewDue({ last: (await listReviews(this.deps.backlog.dir))[0], every: every(), now })) return;
    const blocked = reviewBlocked(this.deps.autopilot());
    if (blocked) return;
    await this.start(now);
  }

  /** Review Now: starts one at once (a second one the same day replaces that day's), if a slot is free. */
  async reviewNow(): Promise<void> {
    if (this.running) {
      void vscode.window.showInformationMessage('An improvement review is running already.');
      return;
    }
    const why = await this.start(new Date());
    if (why) void vscode.window.showWarningMessage(`Flotilla can't start the improvement review now: ${why}.`);
  }

  /** Opens the newest review. */
  async openLatest(): Promise<void> {
    const day = (await listReviews(this.deps.backlog.dir))[0];
    if (!day) {
      void vscode.window.showInformationMessage('No improvement review yet. Review Now writes one.');
      return;
    }
    await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path.join(reviewsDir(this.deps.backlog.dir), `${day}.md`)));
  }

  /** Starts the review's agent; what kept it from starting, if anything did. */
  private async start(now: Date): Promise<string | undefined> {
    this.starting = true;
    const slot = this.deps.admit(SLOT_ID);
    if (slot === undefined) {
      this.starting = false;
      const v = this.deps.autopilot();
      return `${v.running} of ${v.max} agents are running${v.waiting ? `, ${v.waiting} waiting` : ''}`;
    }
    let run: AgentRun | undefined;
    try {
      const day = reviewDay(now);
      const dir = this.deps.backlog.dir;
      const reviewFile = path.join(reviewsDir(dir), `${day}.md`);
      const inboxDir = path.join(dir, INBOX);
      await fs.promises.mkdir(reviewsDir(dir), { recursive: true });
      const last = (await listReviews(dir)).find((d) => d !== day);
      const agent = agentName(this.takenNames());
      const prompt = reviewPrompt({
        agent,
        day,
        ...(await this.inputs(now)),
        reviewFile,
        inboxDir,
        eventsDir: eventsDir(this.deps.commonDir),
        mainRoot: this.deps.mainRoot,
        backlogDir: dir,
        ...(last ? { lastReview: path.join(reviewsDir(dir), `${last}.md`) } : {}),
      });
      const started = Date.now();
      run = runAgentHeadless({
        cwd: this.deps.mainRoot,
        prompt,
        name: `${agent} · improvement review ${day}`,
        track: { agent, role: 'improve' },
        choice: agentChoice(undefined),
        output: this.deps.output,
        slot,
        ...reviewTools({ reviewFile, inboxDir }),
      });
      this.run = run;
      void trackProgress('backlog', `${agent} is writing the improvement review`, () => run!.done);
      void run.done.then(async (result) => {
        this.run = undefined;
        this.deps.giveBack(slot);
        const written = await fs.promises.stat(reviewFile).then((s) => s.mtimeMs >= started, () => false);
        if (written) return;
        // No page: the reply (or why it stopped) is the page, so the review isn't due again at once.
        const body = result.reply?.trim() || `${agent} stopped without a review (${result.limit ? `a ${result.limit.kind} limit` : (result.error?.slice(0, 200) ?? `exit code ${result.code}`)}).`;
        await fs.promises.writeFile(reviewFile, `# Improvement review ${day}\n\n${body}\n`).catch(() => undefined);
      });
      return undefined;
    } catch (e) {
      if (!run) this.deps.giveBack(slot);
      throw e;
    } finally {
      this.starting = false;
    }
  }

  /** What the review is given: the summary, the merged fixes' before and after, and the open tickets. */
  private async inputs(now: Date): Promise<{ summary: string; fixes: string; openTickets: string[] }> {
    const events = await readEvents(this.deps.commonDir);
    const data = await this.deps.backlog.read();
    const checks: FixCheck[] = [];
    for (const item of data.items.filter((i) => i.status === 'done')) {
      const { description } = await this.deps.backlog.readTicketCached(item).catch(() => ({ description: '' }));
      for (const improves of readImproves(description)) {
        const c = checkFix(events, { ticket: item.id, title: item.title, improves, now });
        if (c.landed) checks.push(c);
      }
    }
    return {
      summary: summaryMarkdown(metricsSummary(events, { to: now, days: every() || 7 })),
      fixes: fixesMarkdown(checks),
      openTickets: data.items.filter((i) => i.status !== 'done').map((i) => `${i.id} (${i.status}${i.proposed ? ', proposed' : ''}): ${i.title}`),
    };
  }

  private takenNames(): string[] {
    return this.deps.repository.current.flatMap((w) => w.chats.map((c) => agentChatItem(c.firstPrompt)?.agent ?? '')).filter(Boolean);
  }
}

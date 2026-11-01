import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import {
  agentChatItem,
  agentName,
} from '../../features/backlog/backlog';
import { INBOX } from '../../features/backlog/inbox';
import { criteriaCount } from '../../features/metrics/productivity';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import {
  eventsDir,
  readEvents,
} from '../../features/metrics/events';
import {
  checkFix,
  type FixCheck,
  fixesMarkdown,
  readImproves,
} from '../../features/metrics/improves';
import {
  listReviews,
  nextReviewDay,
  reviewBlocked,
  reviewDay,
  reviewDue,
  reviewPrompt,
  reviewsDir,
  reviewTitle,
  reviewTools,
} from '../../features/metrics/review';
import {
  metricsSummary,
  summaryMarkdown,
} from '../../features/metrics/summary';
import type { Workstream } from '../../features/workstreams/workstream';
import type { AutopilotView } from '../backlog/autopilot';
import {
  agentChoice,
  type AgentRun,
  runAgentHeadless,
} from '../backlog/agentRunner';
import { trackProgress } from '../progress';
import type { MetricsReviews } from '../../webview/metricsProtocol';
import { openReviewPanel } from './reviewPanel';

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
  /** For the review's tab (BL-177). */
  extensionUri: vscode.Uri;
  reference: vscode.Uri;
}

/** The id its slot is taken under. */
const SLOT_ID = 'improvement-review';
const CHECK_MS = 60 * 60_000;
/** How long the view says why Review Now couldn't start one (BL-177). */
const REFUSED_MS = 5 * 60_000;

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
  /** The agent writing the review now. */
  private writer: string | undefined;
  private starting = false;
  private readonly timer: NodeJS.Timeout;
  /** Why Review Now last couldn't start one, and when. */
  private refused: { why: string; at: number } | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires as a review starts, ends or is refused (BL-177): the Metrics view shows it. */
  readonly onDidChange = this.changed.event;

  constructor(private readonly deps: ImprovementReviewDeps) {
    this.timer = setInterval(() => void this.tick().catch(() => undefined), CHECK_MS);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.changed.dispose();
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
    this.refused = why ? { why, at: Date.now() } : undefined;
    this.changed.fire();
    if (why) void vscode.window.showWarningMessage(`Flotilla can't start the improvement review now: ${why}.`);
  }

  /** Opens the newest review. */
  async openLatest(): Promise<void> {
    const day = (await listReviews(this.deps.backlog.dir))[0];
    if (!day) {
      void vscode.window.showInformationMessage('No improvement review yet. Review Now writes one.');
      return;
    }
    this.open(day);
  }

  /** Opens a review in its tab, rendered as a ticket is (BL-177). */
  open(day: string): void {
    openReviewPanel(
      { extensionUri: this.deps.extensionUri, backlogDir: this.deps.backlog.dir, mainRoot: this.deps.mainRoot, reference: this.deps.reference },
      day,
    );
  }

  /** The reviews, as the Metrics view lists them (BL-177): the reviews written, who writes one now, when the next is due and what holds it. */
  async status(now = new Date()): Promise<MetricsReviews> {
    const dir = reviewsDir(this.deps.backlog.dir);
    const days = await listReviews(this.deps.backlog.dir);
    const list = await Promise.all(days.map(async (day) => ({ day, title: reviewTitle(await readHead(path.join(dir, `${day}.md`)), day) })));
    const nextDue = nextReviewDay({ last: days[0], every: every(), now });
    const due = reviewDue({ last: days[0], every: every(), now });
    const waiting = due && !this.running ? (this.deps.isLeader() ? reviewBlocked(this.deps.autopilot()) : 'another window runs the autopilot') : undefined;
    if (this.refused && now.getTime() - this.refused.at > REFUSED_MS) this.refused = undefined;
    return {
      list,
      ...(this.running ? { running: this.writer ?? 'An agent' } : {}),
      ...(nextDue ? { nextDue } : {}),
      ...(waiting ? { waiting } : {}),
      ...(this.refused && !this.running ? { refused: this.refused.why } : {}),
    };
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
      this.writer = agent;
      this.changed.fire();
      void trackProgress('backlog', `${agent} is writing the improvement review`, () => run!.done);
      void run.done.then(async (result) => {
        this.run = undefined;
        this.writer = undefined;
        this.deps.giveBack(slot);
        const written = await fs.promises.stat(reviewFile).then(
          (s) => s.mtimeMs >= started,
          () => false,
        );
        this.changed.fire();
        if (written) return;
        // No page: the reply (or why it stopped) is the page, so the review isn't due again at once.
        const body =
          result.reply?.trim() ||
          `${agent} stopped without a review (${result.limit ? `a ${result.limit.kind} limit` : (result.error?.slice(0, 200) ?? `exit code ${result.code}`)}).`;
        await fs.promises.writeFile(reviewFile, `# Improvement review ${day}\n\n${body}\n`).catch(() => undefined);
        this.changed.fire();
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
    const criteria = new Map<string, number>();
    for (const item of data.items.filter((i) => i.status === 'done')) {
      const { description } = await this.deps.backlog.readTicketCached(item).catch(() => ({ description: '' }));
      criteria.set(item.id, criteriaCount(description));
      for (const improves of readImproves(description)) {
        const c = checkFix(events, { ticket: item.id, title: item.title, improves, now });
        if (c.landed) checks.push(c);
      }
    }
    return {
      summary: summaryMarkdown(metricsSummary(events, { to: now, days: every() || 7, criteria })),
      fixes: fixesMarkdown(checks),
      openTickets: data.items.filter((i) => i.status !== 'done').map((i) => `${i.id} (${i.status}${i.proposed ? ', proposed' : ''}): ${i.title}`),
    };
  }

  private takenNames(): string[] {
    return this.deps.repository.current.flatMap((w) => w.chats.map((c) => agentChatItem(c.firstPrompt)?.agent ?? '')).filter(Boolean);
  }
}

/** The start of a review's file (its heading is near the top): none when it can't be read. */
async function readHead(file: string): Promise<string> {
  const handle = await fs.promises.open(file, 'r').catch(() => undefined);
  if (!handle) return '';
  try {
    const buf = Buffer.alloc(2048);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

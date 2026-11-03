import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
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
  moveReviews,
  REVIEW_TASK,
  reviewContext,
  reviewTitle,
  writeReviewTask,
} from '../../features/metrics/review';
import {
  type Schedule,
  taskDay,
  taskDir,
} from '../../features/schedules/schedule';
import {
  metricsSummary,
  summaryMarkdown,
} from '../../features/metrics/summary';
import type { MetricsReviews } from '../../webview/metricsProtocol';
import type { Scheduler } from '../schedules/scheduler';

export interface ImprovementReviewDeps {
  backlog: LocalBacklog;
  scheduler: Scheduler;
  commonDir: string;
  /** Where it notes that flotilla.metrics.reviewEvery was read into the task's file (once: an edit or a delete then stays). */
  state: vscode.Memento;
  output: vscode.OutputChannel;
}

/** The workspace state's key: the task's file was written from the setting. */
const WRITTEN_KEY = 'flotilla.improvementReview.taskWritten';
/** How long the view says why Review Now couldn't start one (BL-177). */
const REFUSED_MS = 5 * 60_000;

/** flotilla.metrics.reviewEvery (deprecated, BL-263): read only to write the task's schedule. */
function every(): number {
  return Math.max(0, vscode.workspace.getConfiguration('flotilla').get<number>('metrics.reviewEvery', 7));
}

/**
 * The improvement review (BL-159) as the Metrics view and its commands see it: since BL-263 a scheduled task,
 * schedules/improvement-review.md, that the Scheduler runs and whose reports it keeps. This gives its agent the metrics
 * (its context: metrics), writes its file once from flotilla.metrics.reviewEvery, moves the reviews written before
 * into its folder, and shows its reports, its next run and Review Now in the Metrics view.
 */
export class ImprovementReview implements vscode.Disposable {
  /** Why Review Now last couldn't start one, and when. */
  private refused: { why: string; at: number } | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires as a review starts, ends or is refused (BL-177): the Metrics view shows it. */
  readonly onDidChange = this.changed.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly deps: ImprovementReviewDeps) {
    this.sub = deps.scheduler.onDidChange(() => this.changed.fire());
  }

  dispose(): void {
    this.sub.dispose();
    this.changed.dispose();
  }

  /**
   * Makes it a scheduled task (BL-263), in the leading window: its file, once, from the setting; and the reviews of
   * reviews/ moved to its folder. None is lost: one whose day is in the folder already stays where it is.
   */
  async setUp(): Promise<void> {
    const dir = this.deps.backlog.dir;
    if (!this.deps.state.get<boolean>(WRITTEN_KEY)) {
      if (await writeReviewTask(dir, every()))
        this.deps.output.appendLine(`The improvement review is a scheduled task now: ${path.join(dir, 'schedules', `${REVIEW_TASK}.md`)}.`);
      await this.deps.state.update(WRITTEN_KEY, true);
    }
    const moved = await moveReviews(dir);
    if (moved.length) this.deps.output.appendLine(`Moved the improvement reviews of ${moved.join(', ')} to ${taskDir(dir, REVIEW_TASK)}.`);
  }

  /** Review Now: runs the task at once, if a slot is free. */
  async reviewNow(): Promise<void> {
    const why = await this.deps.scheduler.runNow(REVIEW_TASK);
    this.refused = why ? { why, at: Date.now() } : undefined;
    this.changed.fire();
    // The view counts again once it's past, so the line goes in a view nothing else changes.
    if (why) setTimeout(() => this.changed.fire(), REFUSED_MS + 1000).unref?.();
  }

  /** Opens the newest review. */
  async openLatest(): Promise<void> {
    await this.deps.scheduler.openReport(REVIEW_TASK, (await this.task())?.reports[0]);
  }

  /** Opens a review as a page (BL-260's, rendered as a ticket is). */
  open(day: string): void {
    void this.deps.scheduler.openReport(REVIEW_TASK, day).catch(() => undefined);
  }

  /** The reviews, as the Metrics view lists them (BL-177): the reports, who writes one now, when the next runs and what holds it. */
  async status(now = new Date()): Promise<MetricsReviews> {
    const task = await this.task(now);
    const dir = taskDir(this.deps.backlog.dir, REVIEW_TASK);
    const days = task?.reports ?? [];
    const list = await Promise.all(days.map(async (day) => ({ day, title: reviewTitle(await readHead(path.join(dir, `${day}.md`)), day) })));
    if (this.refused && now.getTime() - this.refused.at > REFUSED_MS) this.refused = undefined;
    const running = task?.running ? (this.deps.scheduler.runner(REVIEW_TASK) ?? 'An agent') : undefined;
    const nextDue = task?.next && !task.paused ? taskDay(new Date(Math.max(new Date(task.next).getTime(), now.getTime()))) : undefined;
    return {
      list,
      ...(running ? { running } : {}),
      ...(nextDue ? { nextDue } : {}),
      ...(task?.due && task.waits ? { waiting: task.waits } : {}),
      ...(this.refused && !running ? { refused: this.refused.why } : {}),
    };
  }

  private async task(now = new Date()) {
    return (await this.deps.scheduler.view(now)).tasks.find((t) => t.name === REVIEW_TASK);
  }

  /** What the review is given (its context: metrics): the summary, the merged fixes' before and after, the open tickets and the events. */
  async context({ task, now }: { task: { schedule: Schedule }; now: Date }): Promise<string> {
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
    // The period its numbers cover: as long as it's apart (a week for a weekly one).
    const days = task.schedule.kind === 'days' ? task.schedule.days : 7;
    return reviewContext({
      summary: summaryMarkdown(metricsSummary(events, { to: now, days, criteria })),
      fixes: fixesMarkdown(checks),
      openTickets: data.items.filter((i) => i.status !== 'done').map((i) => `${i.id} (${i.status}${i.proposed ? ', proposed' : ''}): ${i.title}`),
      eventsDir: eventsDir(this.deps.commonDir),
    });
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

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import {
  agentChatItem,
  agentName,
} from '../../features/backlog/backlog';
import { INBOX } from '../../features/backlog/inbox';
import { writeAtomic } from '../../features/backlog/localBacklog';
import {
  acceptedTask,
  listTaskReports,
  nextRun,
  parseTask,
  type ScheduledTask,
  schedulesDir,
  scheduleText,
  taskBlocked,
  taskDay,
  taskDir,
  taskDue,
  taskPrompt,
  taskTools,
  validTaskName,
} from '../../features/schedules/schedule';
import type { Workstream } from '../../features/workstreams/workstream';
import type {
  ScheduledTaskView,
  ScheduledView,
} from '../../webview/scheduledProtocol';
import type { AutopilotView } from '../backlog/autopilot';
import {
  agentChoice,
  type AgentRun,
  runAgentHeadless,
  validModel,
} from '../backlog/agentRunner';
import {
  type Commands,
  showError,
} from '../commandSet';
import { trackProgress } from '../progress';

export interface SchedulerDeps {
  backlogDir: string;
  repository: Repository<Workstream>;
  /** A slot of the agents limit (ReviewLoop.admitNew), given back when the run is done. */
  admit(id: string): number | undefined;
  giveBack(slot: number): void;
  autopilot(): AutopilotView;
  isLeader(): boolean;
  mainRoot: string;
  output: vscode.OutputChannel;
  /** Opens a report as a page (openPagePanel). */
  openPage(file: string, title: string): void;
}

/** A task's file as read: the task, or what's wrong with its file. */
export type TaskFile = { name: string; file: string } & ({ task: ScheduledTask; created: Date } | { error: string });

const CHECK_MS = 5 * 60_000;

/**
 * Runs the scheduled tasks (BL-260): checks every few minutes, in the leading window, which of the tasks in
 * schedules/ are due and may run (taskBlocked), and starts each on a slot of the agents limit, without a window. Its
 * agent writes schedules/<task>/YYYY-MM-DD.md and proposes tickets through the inbox. A file that can't be read says
 * why in <task>.error next to it.
 */
export class Scheduler implements vscode.Disposable {
  /** The runs going, by task. */
  private readonly runs = new Map<string, AgentRun | 'starting'>();
  private readonly timer: NodeJS.Timeout;
  private readonly changed = new vscode.EventEmitter<void>();
  /** A run started or ended, or a task's file or report changed: the Scheduled tool shows it again. */
  readonly onDidChange = this.changed.event;

  constructor(private readonly deps: SchedulerDeps) {
    this.timer = setInterval(() => void this.tick().catch(() => undefined), CHECK_MS);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.changed.dispose();
  }

  /** Watches the tasks' files and reports, for onDidChange. */
  watch(): vscode.Disposable {
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(schedulesDir(this.deps.backlogDir)), '**/*'));
    const fire = () => this.changed.fire();
    w.onDidCreate(fire);
    w.onDidChange(fire);
    w.onDidDelete(fire);
    return w;
  }

  /** The Scheduled tool's view (BL-260): each task, when it runs next, what a due one waits for, its reports. */
  async view(now = new Date()): Promise<ScheduledView> {
    const v = this.deps.autopilot();
    const tasks: ScheduledTaskView[] = [];
    for (const t of await this.tasks()) {
      const reports = await listTaskReports(this.deps.backlogDir, t.name);
      if (!('task' in t)) {
        tasks.push({ name: t.name, title: t.name, error: t.error, reports });
        continue;
      }
      const { task } = t;
      const next = nextRun(task.schedule, { ...(reports[0] ? { last: reports[0] } : {}), created: t.created });
      const running = this.running(t.name);
      const due = !!next && next.getTime() <= now.getTime() && !running && !task.proposed;
      const waits = due ? (taskBlocked(v, task.when) ?? (v.running >= v.max ? `all ${v.max} agent slots are taken` : undefined)) : undefined;
      tasks.push({
        name: t.name,
        title: task.title,
        schedule: `${scheduleText(task.schedule)}${task.when === 'any' ? '' : ', when idle'}`,
        ...(next ? { next: next.toISOString() } : {}),
        ...(due ? { due } : {}),
        ...(waits ? { waits } : {}),
        ...(running ? { running } : {}),
        ...(task.proposed ? { proposed: task.proposed } : {}),
        reports,
      });
    }
    return { tasks, dir: schedulesDir(this.deps.backlogDir) };
  }

  /** Accept a proposed task: it runs on its schedule from now. */
  async accept(name: string): Promise<void> {
    const file = this.fileOf(name);
    await fs.promises.writeFile(file, acceptedTask(await fs.promises.readFile(file, 'utf8')));
    this.changed.fire();
  }

  /** Dismiss a proposed task: its file is deleted. */
  async dismiss(name: string): Promise<void> {
    await fs.promises.rm(this.fileOf(name), { force: true });
    await fs.promises.rm(path.join(schedulesDir(this.deps.backlogDir), `${name}.error`), { force: true });
    this.changed.fire();
  }

  /** Edit: the task's file in an editor. */
  async edit(name: string): Promise<void> {
    await vscode.window.showTextDocument(vscode.Uri.file(this.fileOf(name)));
  }

  /** The tasks' folder, in the Explorer (made if it isn't there yet). */
  async openFolder(): Promise<void> {
    await fs.promises.mkdir(schedulesDir(this.deps.backlogDir), { recursive: true });
    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(schedulesDir(this.deps.backlogDir)));
  }

  private fileOf(name: string): string {
    if (!validTaskName(name)) throw new Error(`Not a scheduled task: ${name}`);
    return path.join(schedulesDir(this.deps.backlogDir), `${name}.md`);
  }

  running(name: string): boolean {
    return this.runs.has(name);
  }

  /** The tasks' files, by name; a wrong file's problem goes to its .error (and away once it's fixed). */
  async tasks(): Promise<TaskFile[]> {
    const dir = schedulesDir(this.deps.backlogDir);
    const names = (await fs.promises.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort();
    const out: TaskFile[] = [];
    for (const n of names) {
      const name = n.slice(0, -'.md'.length);
      const file = path.join(dir, n);
      const errorFile = path.join(dir, `${name}.error`);
      const [text, stat] = await Promise.all([fs.promises.readFile(file, 'utf8').catch(() => undefined), fs.promises.stat(file).catch(() => undefined)]);
      if (text === undefined || !stat) continue;
      const task = parseTask(name, text);
      const had = await fs.promises.readFile(errorFile, 'utf8').catch(() => undefined);
      if ('error' in task) {
        if (had !== `${task.error}\n`) await writeAtomic(errorFile, `${task.error}\n`).catch(() => undefined);
        out.push({ name, file, error: task.error });
        continue;
      }
      if (had !== undefined) await fs.promises.rm(errorFile, { force: true });
      out.push({ name, file, task, created: new Date(stat.birthtimeMs || stat.mtimeMs) });
    }
    return out;
  }

  /** Starts the tasks that are due and may run now: one at a time for those that wait for idle. */
  async tick(now = new Date()): Promise<void> {
    if (!this.deps.isLeader()) return;
    for (const t of await this.tasks()) {
      if (!('task' in t) || t.task.proposed || this.running(t.name)) continue;
      const last = (await listTaskReports(this.deps.backlogDir, t.name))[0];
      if (!taskDue(t.task.schedule, { ...(last ? { last } : {}), created: t.created, now })) continue;
      if (taskBlocked(this.deps.autopilot(), t.task.when)) continue;
      await this.start(t.task, now);
    }
  }

  /** Run Now: starts a task at once (a second run the same day replaces that day's report), if a slot is free. */
  async runNow(name?: string): Promise<void> {
    const t = await this.pick(name, 'Run which scheduled task now?');
    if (!t) return;
    if (!('task' in t)) return void vscode.window.showWarningMessage(`${t.name} can't run: ${t.error}`);
    if (this.running(t.name)) return void vscode.window.showInformationMessage(`${t.task.title} is running already.`);
    const why = await this.start(t.task, new Date());
    if (why) void vscode.window.showWarningMessage(`Flotilla can't start ${t.task.title} now: ${why}.`);
  }

  /** Opens one of a task's reports (the newest, unless asked). */
  async openReport(name?: string, day?: string): Promise<void> {
    const t = await this.pick(name, "Open which scheduled task's report?");
    if (!t) return;
    const days = await listTaskReports(this.deps.backlogDir, t.name);
    const title = 'task' in t ? t.task.title : t.name;
    const chosen = day ?? (days.length > 1 ? await vscode.window.showQuickPick(days, { title: `${title}: which report?` }) : days[0]);
    if (!days.length) return void vscode.window.showInformationMessage(`${title} has no report yet. Run Now writes one.`);
    if (!chosen) return;
    this.deps.openPage(path.join(taskDir(this.deps.backlogDir, t.name), `${chosen}.md`), `${title} ${chosen}`);
  }

  /** A task an agent proposed (BL-260): Accept lets it run, Dismiss deletes it. */
  async offerProposed(name: string): Promise<void> {
    const t = (await this.tasks()).find((f) => f.name === name);
    if (!t || !('task' in t) || !t.task.proposed) return;
    const choice = await vscode.window.showInformationMessage(
      `Agent ${t.task.proposed} proposes a scheduled task, ${t.task.title} (${scheduleText(t.task.schedule)})${t.task.tools?.length ? `. Its agent may also use: ${t.task.tools.join(', ')}` : ''}.`,
      'Accept',
      'Open',
      'Dismiss',
    );
    if (choice === 'Accept') await this.accept(name);
    else if (choice === 'Dismiss') await this.dismiss(name);
    else if (choice === 'Open') await this.edit(name);
  }

  private async pick(name: string | undefined, title: string): Promise<TaskFile | undefined> {
    const tasks = await this.tasks();
    if (name) return tasks.find((t) => t.name === name);
    if (!tasks.length) {
      void vscode.window.showInformationMessage(`No scheduled tasks: add one as a Markdown file in ${schedulesDir(this.deps.backlogDir)}.`);
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      tasks.map((t) => ({ label: 'task' in t ? t.task.title : t.name, description: 'task' in t ? scheduleText(t.task.schedule) : t.error, t })),
      { title },
    );
    return picked?.t;
  }

  /** Starts a task's agent; what kept it from starting, if anything did. */
  private async start(task: ScheduledTask, now: Date): Promise<string | undefined> {
    this.runs.set(task.name, 'starting');
    this.changed.fire();
    const slot = this.deps.admit(`scheduled-${task.name}`);
    if (slot === undefined) {
      this.runs.delete(task.name);
      this.changed.fire();
      const v = this.deps.autopilot();
      return `${v.running} of ${v.max} agents are running${v.waiting ? `, ${v.waiting} waiting` : ''}`;
    }
    let run: AgentRun | undefined;
    try {
      const day = taskDay(now);
      const dir = taskDir(this.deps.backlogDir, task.name);
      const reportFile = path.join(dir, `${day}.md`);
      const inboxDir = path.join(this.deps.backlogDir, INBOX);
      await fs.promises.mkdir(dir, { recursive: true });
      const earlier = (await listTaskReports(this.deps.backlogDir, task.name)).filter((d) => d !== day).map((d) => path.join(dir, `${d}.md`));
      const agent = agentName(this.takenNames());
      const prompt = taskPrompt({ agent, task, day, reportFile, earlier, inboxDir, mainRoot: this.deps.mainRoot, backlogDir: this.deps.backlogDir });
      const model = validModel(task.model);
      const started = Date.now();
      run = runAgentHeadless({
        cwd: this.deps.mainRoot,
        prompt,
        name: `${agent} · ${task.title} ${day}`,
        track: { agent, role: 'scheduled' },
        choice: { ...agentChoice(undefined), ...(model ? { model } : {}), ...(task.effort ? { effort: task.effort } : {}) },
        output: this.deps.output,
        slot,
        ...taskTools({ reportFile, inboxDir, name: task.name, more: task.tools }),
      });
      const going = run;
      this.runs.set(task.name, going);
      this.changed.fire();
      void trackProgress('backlog', `${agent} is running ${task.title}`, () => going.done);
      void going.done.then(async (result) => {
        this.runs.delete(task.name);
        this.changed.fire();
        this.deps.giveBack(slot);
        const written = await fs.promises.stat(reportFile).then(
          (s) => s.mtimeMs >= started,
          () => false,
        );
        // No report: the reply (or why it stopped) is the report, so the task isn't due again at once.
        if (!written) {
          const body =
            result.reply?.trim() ||
            `${agent} stopped without a report (${result.limit ? `a ${result.limit.kind} limit` : (result.error?.slice(0, 200) ?? `exit code ${result.code}`)}).`;
          await fs.promises.writeFile(reportFile, `# ${task.title} ${day}\n\n${body}\n`).catch(() => undefined);
        }
        this.changed.fire();
        const open = await vscode.window.showInformationMessage(`${task.title} ran: its report of ${day} is written.`, 'Open Report');
        if (open) this.deps.openPage(reportFile, `${task.title} ${day}`);
      });
      return undefined;
    } catch (e) {
      if (!run) {
        this.deps.giveBack(slot);
        this.runs.delete(task.name);
        this.changed.fire();
      }
      throw e;
    }
  }

  private takenNames(): string[] {
    return this.deps.repository.current.flatMap((w) => w.chats.map((c) => agentChatItem(c.firstPrompt)?.agent ?? '')).filter(Boolean);
  }
}

/** The scheduled tasks' commands (until the Scheduled view, BL-262, has their buttons). */
export function scheduleCommands({ scheduler }: { scheduler: Scheduler }): Commands {
  return {
    'flotilla.runScheduledTaskNow': () => scheduler.runNow().catch(showError),
    'flotilla.openScheduledTaskReport': () => scheduler.openReport().catch(showError),
  };
}

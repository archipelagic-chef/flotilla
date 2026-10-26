import type { Merger } from '../backlog/merge';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Autopilot } from '../backlog/autopilot';
import type { StorageMonitor } from '../storage';
import type { Repository } from '../../core/repository';
import { openChangeDiff, openChangesEditor } from '../../core/diff/openDiff';
import { resolveInside } from '../../core/paths';
import { toWorkspaceUri } from '../../core/uris';
import { compareRefs, listRefs } from '../../features/diffs/compare';
import {
  acceptItem,
  type BacklogItem,
  childrenOf,
  moveItem,
  removeItem,
  updateItem,
} from '../../features/backlog/backlog';
import { discussable, findDiscussionChat, isDiscussionChat } from '../../features/backlog/shaping';
import { needOf, queuedNeed, resumeAsk } from '../../features/backlog/needs';
import { gatherAttachments } from '../../features/backlog/attachments';
import { fraction } from '../../features/backlog/checksProgress';
import type { ReviewLoop } from '../backlog/reviewLoop';
import { cardSummaryOf } from '../../features/backlog/ticket';
import { pickRunBlock, placedRunBlocks } from '../../features/backlog/runBlocks';
import { LocalBacklog } from '../../features/backlog/localBacklog';
import type { BacklogIntegrations } from '../backlog/integrations';
import type { Merges } from '../backlog/merges';
import type { NoteAgents } from '../backlog/notes';
import { freeMemoryMB, minFreeMemoryMB } from '../backlog/agentRunner';
import { commitChanges, readLog } from '../../features/history/log';
import { resolveBase } from '../../features/workstreams/progress';
import type { Workstream } from '../../features/workstreams/workstream';
import { searchWorktree } from '../../features/search/gitGrep';
import { matcher, replacementFor, type SearchOptions } from '../../features/search/matcher';
import { needsYou, standing } from '../../features/backlog/autopilotIdle';
import { baseLabel, dependsOn, waitingFor } from '../../features/backlog/mainDrift';
import {
  ALL,
  type BacklogItemView,
  type HostMessage,
  type MachineState,
  type RefComparison,
  type SearchGroup,
  type TicketVcView,
  type Tool,
  type VcView,
  type WebviewMessage,
} from '../../webview/protocol';
import type { FinishedRun } from '../../features/ci/notify';
import type { FileChange } from '../../core/git/porcelain';
import type { ActiveWorktree } from '../activeWorktree';
import { FileOps } from './fileOps';
import { iconThemeRoot, loadIconTheme } from './iconTheme';
import { excludeMatcher, listDirectory, markIgnored } from './files';
import { isInWorktreesFolder } from '../../features/worktrees/exclusions';
import { ShownFolders } from './shownFolders';
import { currentMissingExclusions } from '../hygiene';
import { changedViews, tabOrder, toWorkstreamView } from './viewModel';
import { stuckRules } from '../settings';
import { changeMarks, ListedFolders } from './changeMarks';
import { openCommit } from '../openCommit';
import { onDidChangeProgress, progressByTool } from '../progress';
import { CiRuns } from '../ci/ciRuns';
import { runWorkflowByHand } from '../ci/runWorkflow';
import { webUrl } from '../../features/ci/githubDeployments';
import { creatingWorktrees } from '../../features/backlog/creatingWorktrees';
import { removingWorktrees } from '../../features/workstreams/removingWorktrees';
import { recordClickWait } from '../../features/metrics/record';
import type { MetricsPeriod } from '../../webview/metricsProtocol';
import type { Metrics } from '../metrics/metrics';

/** How long after a dispatch the CI/CD view reads the runs again (GitHub takes a moment to list a new one). */
const RUN_LISTED_MS = 5_000;

/** Commits per page of a worktree's history. */
const LOG_PAGE = 50;

/** What Version Control's ticket views ask of the tickets (BL-171). */
export interface TicketVc {
  ticketVc(id: string): Promise<TicketVcView | undefined>;
  openTicketChange(id: string, group: number, path: string): Promise<void>;
  /** Back to the ticket, its Changes at that file. */
  showChange(o: { id: string; path?: string }): Promise<void>;
}

export interface SidebarDeps {
  extensionUri: vscode.Uri;
  repository: Repository<Workstream>;
  /** URI of this window's workspace folder; keeps scheme and remote authority. */
  reference: vscode.Uri;
  /** The main checkout's folder (worktrees inside it are the ones VS Code's watcher and search would see). */
  mainRoot: string;
  inWorkspace: (ws: Workstream) => boolean;
  active: ActiveWorktree;
  backlog: LocalBacklog;
  integrations: BacklogIntegrations;
  /** Commits with the message from the webview's message box; true when a commit was made. */
  commit: (ws: Workstream, message: string, opts: { amend?: boolean; then?: 'push' | 'sync' }) => Promise<boolean>;
  output: vscode.OutputChannel;
  /** The fake GitHub's address, in the debug window only (see devGitHubApi). */
  githubApi?: string;
  /** Runs that finished on a worktree's branch while they were read (for the notices). */
  onCiFinished?: (items: FinishedRun[]) => void;
  /** The Metrics tool's numbers (BL-158). */
  metrics?: Metrics;
}

export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'flotilla.sidebar';
  private view: vscode.WebviewView | undefined;
  /** The page has loaded and listens; until then actions wait in pending. */
  private ready = false;
  private pending: HostMessage[] = [];
  private readonly visibility = new vscode.EventEmitter<boolean>();
  readonly onDidChangeVisibility = this.visibility.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  /** The view of each worktree as the webview last got it (JSON, by key): only changed ones are sent. */
  private readonly sent = new Map<string, string>();
  /** The folders the Files tab has listed, so that their entries' change marks can be sent. */
  private readonly listed = new ListedFolders();
  readonly files: FileOps;
  /** The folders the Files tab lists, watched directly: VS Code's watcher skips the worktrees (files.watcherExclude). */
  private readonly shown = new ShownFolders((key, rel) => this.dirsChanged(key, [rel]));
  /** The CI/CD view's runs, read while the sidebar is visible. */
  readonly ci: CiRuns;

  /** The open discussion chats the backlog was last posted with (see openDiscussions). */
  private discussionsShown = '';

  /** The open discussion chats (BL-188), as a key: when it changes, the cards change. */
  private openDiscussions(): string {
    return this.deps.repository.current
      .flatMap((w) => w.chats.filter((c) => c.open && isDiscussionChat(c.firstPrompt)).map((c) => c.id))
      .sort()
      .join(',');
  }

  /** Whether an item's discussion chat is open now. */
  private discussing(item: BacklogItem): boolean {
    const shaping = item.shaping;
    if (!shaping?.chat || !discussable(item)) return false;
    return this.deps.repository.current.some((w) => !!findDiscussionChat(w.chats, { id: item.id, agent: shaping.agent, session: shaping.session })?.open);
  }

  constructor(private readonly deps: SidebarDeps) {
    this.ci = new CiRuns(
      (views) => this.post({ type: 'ci', views }),
      deps.githubApi,
      (items) => this.deps.onCiFinished?.(items),
    );
    this.files = new FileOps({
      reference: deps.reference,
      find: (key) => this.find(key),
      post: (message) => this.post(message),
      dirsChanged: (key, dirs) => this.dirsChanged(key, [...new Set(dirs)]),
    });
    this.subscriptions.push(
      { dispose: deps.repository.onDidChange(() => this.postState()).dispose },
      // A discussion's chat opened or closed: its card says so (BL-188).
      {
        dispose: deps.repository.onDidChange(() => {
          const open = this.openDiscussions();
          if (open === this.discussionsShown) return;
          this.discussionsShown = open;
          void this.postBacklog();
        }).dispose,
      },
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('files.watcherExclude') ||
          e.affectsConfiguration('search.exclude') ||
          e.affectsConfiguration('git.repositoryScanIgnoredFolders')
        )
          this.postExclusions();
        if (e.affectsConfiguration('flotilla.backlog.cards')) void this.postBacklog();
      }),
      deps.active.onDidChange((key) => this.post({ type: 'active', key })),
      deps.active.onDidChangeTabs((closed) => this.post({ type: 'tabs', closed: [...closed] })),
      deps.backlog.watch(() => void this.backlogChanged()),
      deps.integrations.onDidChange(() => void this.postBacklog()),
      creatingWorktrees.onDidChange(() => void this.postBacklog()),
      removingWorktrees.onDidChange(() => this.postState()),
      onDidChangeProgress(() => this.post({ type: 'progress', tools: progressByTool() })),
      this.visibility.event((visible) => this.ci.setVisible(visible)),
      this.ci,
      ...(deps.metrics ? [deps.metrics.onDidChange(() => void this.postMetrics())] : []),
    );
  }

  /** A ticket's heading may have been edited (by hand or by an agent): that renames the item. */
  private async backlogChanged(): Promise<void> {
    await this.deps.backlog.syncTitles().catch(() => false);
    await this.postBacklog();
  }

  private autopilot: Autopilot | undefined;
  private storage: StorageMonitor | undefined;

  /** Whether the repository is on a slow drive, shown in the Overview (created after the sidebar). */
  useStorage(storage: StorageMonitor): void {
    this.storage = storage;
    this.subscriptions.push(storage.onDidChange(() => this.postStorage()));
    this.postStorage();
  }

  private postStorage(): void {
    this.post({ type: 'storage', ...(this.storage?.slow ? { slow: this.storage.slow } : {}) });
  }

  private queue: ReviewLoop | undefined;

  /** The agents' queue: a user's reply waiting for one is a "Needs you" row, with Prioritize. */
  useQueue(queue: ReviewLoop): void {
    this.queue = queue;
    this.subscriptions.push(queue.onDidChange(() => void this.postBacklog()));
    void this.postBacklog();
  }

  /** The autopilot, shown (and switched) in the backlog's title (created after the sidebar). */
  useAutopilot(autopilot: Autopilot): void {
    this.autopilot = autopilot;
    this.subscriptions.push(
      autopilot.onDidChange(() => void this.postBacklog()),
      // The limit, changed in its details or in the settings, shows at once.
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('flotilla.agents.maxRunning') || e.affectsConfiguration('flotilla.autopilot.maxAgents')) void this.postBacklog();
      }),
    );
    void this.postBacklog();
  }

  private merger: Merger | undefined;

  /** The merge queue (BL-140), shown as a bar above the board. */
  useMerger(merger: Merger): void {
    this.merger = merger;
    this.subscriptions.push(merger.onDidChange(() => void this.postBacklog()));
    // The cards' "checks 58%" (BL-169): every few seconds at most, the board being the larger post.
    let checksTimer: ReturnType<typeof setTimeout> | undefined;
    this.subscriptions.push(
      merger.onDidChecks(() => {
        checksTimer ??= setTimeout(() => {
          checksTimer = undefined;
          void this.postBacklog();
        }, 3000);
      }),
      { dispose: () => clearTimeout(checksTimer) },
    );
    void this.postBacklog();
  }

  private notes: NoteAgents | undefined;

  /** The notes (BL-182): the Notes box and lane at the top of the backlog. */
  useNotes(notes: NoteAgents): void {
    this.notes = notes;
    this.subscriptions.push(notes.onDidChange(() => void this.postNotes()));
    void this.postNotes();
  }

  private async postNotes(): Promise<void> {
    if (this.notes) this.post({ type: 'notes', notes: await this.notes.views() });
  }

  private tickets: TicketVc | undefined;

  /** The tickets, for Version Control's ticket views (BL-171): their header, Changes and Commits. */
  useTickets(tickets: TicketVc): void {
    this.tickets = tickets;
  }

  private merges: Merges | undefined;

  /** Whether the items' work is merged (shown on the cards; they move to Done by themselves when it is). */
  useMerges(merges: Merges): void {
    this.merges = merges;
    this.subscriptions.push(merges.watch(() => void this.postBacklog()));
    void this.postBacklog();
  }

  private async postBacklog(): Promise<void> {
    const store = this.deps.backlog;
    const data = await store.read();
    const sources = this.deps.integrations.current;
    const issues = this.deps.integrations.issues();
    const items = await Promise.all(
      data.items.map(async (item): Promise<BacklogItemView> => {
        const ticket = await store.readTicketCached(item);
        const linked = item.links?.map((l) => {
          const now = issues.find((i) => i.id === l.id);
          return {
            id: l.id,
            kind: l.source.startsWith('github:') ? ('github' as const) : ('jira' as const),
            title: now?.title ?? l.title,
            url: l.url,
            statusName: now?.statusName,
          };
        });
        const merge = this.merges?.get(item.id);
        const queued = this.queue?.queuedFor(item.id);
        const need = needOf(item, ticket.activity) ?? (queued?.kind === 'reply' ? queuedNeed(queued) : undefined);
        // The ticket's run: its last run block (the one its Run button runs).
        const last = pickRunBlock(placedRunBlocks(ticket.activity, (e) => LocalBacklog.entryKey(item.id, e)));
        const run = last && { kind: last.block.kind, title: last.block.title, lines: last.block.lines };
        // What it waits for, and how its branches merge with main (BL-55).
        const waitsFor = item.status === 'done' ? [] : waitingFor(data, dependsOn(ticket.description, item.id)).map((d) => d.id);
        // Where each stands, and an epic's parts (BL-205): why the autopilot passes it over.
        const waitsOn = waitsFor.flatMap((id) => {
          const dep = data.items.find((i) => i.id === id);
          return dep ? [{ id, standing: needsYou(dep) ?? standing(dep) }] : [];
        });
        const children = childrenOf(data, item.id);
        const parts = children.length ? { done: children.filter((c) => c.status === 'done').length, total: children.length } : undefined;
        // Its agent stopped to be resumed (BL-198): what it waits for, merged or not.
        const asks = resumeAsk(item, ticket.activity);
        const after = asks?.waits.flatMap((id) => data.items.find((i) => i.id.toUpperCase() === id) ?? []) ?? [];
        const isMerged = (i: (typeof after)[number]) => i.status === 'done' || !!i.merged;
        const resume = asks && { waits: after.filter((i) => !isMerged(i)).map((i) => i.id), merged: after.filter(isMerged).map((i) => i.id) };
        const base = item.mainCheck && baseLabel(item.mainCheck.base);
        // A ticket in review that shows a demo: its card has the demo mark (BL-135).
        const checks = this.merger?.checksView(item.id);
        const part = checks && fraction(checks.progress);
        const percent = part === undefined ? undefined : Math.round(part * 100);
        const demo = item.status === 'review' && gatherAttachments(ticket.description, ticket.activity).some((a) => a.demo);
        return {
          ...item,
          summary: cardSummaryOf(ticket.description),
          activity: ticket.activity.length,
          ...(linked?.length ? { linked } : {}),
          ...(merge ? { merge } : {}),
          ...(need ? { need } : {}),
          ...(run ? { run } : {}),
          ...(waitsFor.length ? { waitsFor, waitsOn } : {}),
          ...(parts ? { parts } : {}),
          ...(resume ? { resume } : {}),
          ...(this.autopilot?.clashOf(item.id) ? { clash: this.autopilot.clashOf(item.id) } : {}),
          ...(base ? { base } : {}),
          ...(demo ? { demo } : {}),
          ...(this.discussing(item) ? { discussing: true } : {}),
          ...(creatingWorktrees.has(item.id) ? { creating: true } : {}),
          ...(checks ? { checks: { ...(checks.progress.step ? { step: checks.progress.step } : {}), ...(percent !== undefined ? { percent } : {}) } } : {}),
        };
      }),
    );
    // Issues from integrations follow the local items, in their tracker's order; linked ones show with their item.
    const linkedIds = new Set(data.items.flatMap((i) => (i.links ?? []).map((l) => l.id)));
    const remote: BacklogItemView[] = sources.flatMap((s) =>
      s.issues
        .filter((i) => !linkedIds.has(i.id))
        .map((i) => ({
          id: i.id,
          title: i.title,
          status: i.status,
          priority: i.priority,
          created: '',
          activity: 0,
          source: { kind: s.config.kind, label: s.label, url: i.url, statusName: i.statusName },
        })),
    );
    const problems = sources.filter((s) => s.error).map((s) => ({ label: s.label, error: s.error! }));
    const queue = this.merger?.queueView();
    this.post({
      type: 'backlog',
      items: [...items, ...remote],
      problems,
      integrations: sources.length,
      detailedCards: vscode.workspace.getConfiguration('flotilla').get<string>('backlog.cards') === 'detailed',
      ...(this.autopilot ? { autopilot: this.autopilot.view() } : {}),
      ...(queue?.entries.length ? { mergeQueue: queue } : {}),
    });
  }

  private async onBacklog(m: Extract<WebviewMessage, { type: 'backlog' }>): Promise<void> {
    const store = this.deps.backlog;
    switch (m.op) {
      case 'new':
        await vscode.commands.executeCommand('flotilla.addBacklogItem');
        return;
      case 'update':
        await store.change((d) =>
          updateItem(d, m.id, {
            ...(m.title?.trim() ? { title: m.title.trim() } : {}),
            ...(m.notes !== undefined ? { notes: m.notes.trim() || undefined } : {}),
            ...(m.status ? { status: m.status } : {}),
            ...(m.priority !== undefined ? { priority: m.priority } : {}),
          }),
        );
        break;
      case 'move':
        // Dragging a proposal into a lane accepts it.
        await store.change((d) => acceptItem(moveItem(d, m.id, m.status, m.before), m.id));
        break;
      case 'delete':
        await vscode.commands.executeCommand('flotilla.deleteBacklogItem', m.id);
        return;
      case 'discard':
        await vscode.commands.executeCommand('flotilla.discardBacklogItem', m.id);
        return;
      case 'reopen':
        await vscode.commands.executeCommand('flotilla.reopenBacklogItem', m.id);
        return;
      case 'start':
        await vscode.commands.executeCommand('flotilla.startBacklogItem', m.id, { agent: true });
        return;
      case 'createWorktree':
        await vscode.commands.executeCommand(m.named ? 'flotilla.createBacklogWorktreeNamed' : 'flotilla.createBacklogWorktree', m.id);
        return;
      case 'comment':
        await vscode.commands.executeCommand('flotilla.openBacklogItem', m.id, { focus: 'comment' });
        return;
      case 'demo':
        await vscode.commands.executeCommand('flotilla.openBacklogItem', m.id, { focus: 'demo' });
        return;
      case 'approve':
        await vscode.commands.executeCommand('flotilla.reviewBacklogItem', m.id, 'approved', '');
        break;
      case 'fix':
        await vscode.commands.executeCommand('flotilla.fixBacklogReview', m.id, m.fix);
        break;
      case 'prioritize':
        await vscode.commands.executeCommand('flotilla.prioritizeBacklogItem', m.id);
        break;
      case 'open':
        await vscode.commands.executeCommand('flotilla.openBacklogItem', m.id);
        return;
      case 'discuss':
        await vscode.commands.executeCommand('flotilla.discussBacklogItem', m.id);
        return;
      case 'link':
        await vscode.commands.executeCommand('flotilla.linkBacklogItem', m.id);
        return;
      case 'run':
        await vscode.commands.executeCommand('flotilla.runBacklogItem', m.id);
        return;
      case 'accept':
        await store.change((d) => acceptItem(d, m.id));
        break;
      case 'acceptAll':
        await store.change((d) => d.items.filter((i) => i.proposed).reduce((acc, i) => acceptItem(acc, i.id), d));
        break;
      case 'dismiss': {
        // A proposal goes without asking (it's the agent's suggestion, not the user's work).
        const item = (await store.read()).items.find((i) => i.id === m.id);
        if (!item?.proposed) return;
        await store.change((d) => removeItem(d, m.id));
        await store.deleteDocument(m.id);
        break;
      }
      case 'plan':
        await vscode.commands.executeCommand('flotilla.planBacklog');
        return;
      case 'autopilot':
        await vscode.commands.executeCommand('flotilla.toggleAutopilot');
        return;
      case 'checkAll':
        await vscode.commands.executeCommand('flotilla.checkAll');
        return;
      case 'tryNow':
        await vscode.commands.executeCommand('flotilla.tryPausedNow');
        return;
      case 'pauseAll':
        await vscode.commands.executeCommand('flotilla.pauseAllAgents');
        return;
      case 'resumeAll':
        await vscode.commands.executeCommand('flotilla.resumeAllAgents');
        return;
      case 'maxAgents':
        await setAgentLimit(m.max);
        return;
      case 'landAll':
        await vscode.commands.executeCommand('flotilla.mergeAllReady');
        return;
      case 'queueOrder':
        await this.merger?.reorderQueue(m.ids);
        return;
      case 'mergeNext':
        await this.merger?.mergeNext(m.id);
        return;
      case 'updateAndMerge':
        await this.merger?.updateAndMerge(m.id);
        return;
      case 'resume':
        await vscode.commands.executeCommand('flotilla.resumeAgent', m.id);
        return;
      case 'merge':
        await vscode.commands.executeCommand('flotilla.mergeBacklogItem', m.id);
        return;
      case 'cards':
        await vscode.workspace.getConfiguration('flotilla').update('backlog.cards', m.detailed ? 'detailed' : 'compact', vscode.ConfigurationTarget.Global);
        return;
      case 'integrations':
        await this.deps.integrations.manage();
        return;
      case 'refresh':
        await this.deps.integrations.refresh();
        break;
    }
    await this.postBacklog();
  }

  /** Folds or unfolds every worktree on the All tab (the view title's Fold All / Unfold All). */
  fold(folded: boolean): void {
    this.post({ type: 'fold', folded });
  }

  get visible(): boolean {
    return this.view?.visible ?? false;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const dist = vscode.Uri.joinPath(this.deps.extensionUri, 'dist');
    const iconRoot = iconThemeRoot(this.deps.extensionUri);
    view.webview.options = { enableScripts: true, localResourceRoots: iconRoot ? [dist, iconRoot] : [dist] };
    view.webview.html = this.html(view.webview, dist);
    view.webview.onDidReceiveMessage((m: WebviewMessage) => this.onMessage(m).catch((e: unknown) => this.report(e)));
    view.onDidChangeVisibility(() => this.visibility.fire(view.visible));
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
      this.visibility.fire(false);
    });
    this.visibility.fire(view.visible);
    // A new icon theme may live in another extension's folder: allow it (this reloads the webview), then send it.
    view.onDidDispose(
      vscode.Disposable.from(
        vscode.workspace.onDidChangeConfiguration((e) => {
          if (!e.affectsConfiguration('workbench.iconTheme')) return;
          const root = iconThemeRoot(this.deps.extensionUri);
          this.ready = false;
          view.webview.options = { enableScripts: true, localResourceRoots: root ? [dist, root] : [dist] };
          void this.postIconTheme();
        }),
        vscode.window.onDidChangeActiveColorTheme(() => void this.postIconTheme()),
      ).dispose,
    );
  }

  private async postIconTheme(): Promise<void> {
    if (!this.view) return;
    try {
      const theme = await loadIconTheme(this.view.webview, this.deps.extensionUri);
      this.post({ type: 'iconTheme', theme: theme && { css: theme.css, map: theme.map } });
    } catch (error) {
      this.deps.output.appendLine(`Could not load the file icon theme: ${error instanceof Error ? error.message : String(error)}`);
      this.post({ type: 'iconTheme', theme: undefined });
    }
  }

  /** Sends the worktrees whose view changed since the last state (all of them after the page loads). */
  postState(): void {
    const now = new Date();
    const all = this.deps.repository.current;
    const config = vscode.workspace.getConfiguration('flotilla');
    const pattern = config.get<string>('tabLabelPattern') || undefined;
    const limit = config.get<number>('changes.limit', 5000);
    const rules = stuckRules();
    const views = tabOrder(all).map((ws) => ({
      ...toWorkstreamView(ws, all, now, this.deps.inWorkspace(ws), pattern, limit, bigContext(), rules),
      ...(removingWorktrees.has(ws.key) ? { removing: true } : {}),
    }));
    const { changed, keys } = changedViews(views, this.sent);
    const machine: MachineState = {
      freeMB: freeMemoryMB(),
      minFreeMB: minFreeMemoryMB(),
      agents: all.reduce((n, ws) => n + ws.chats.filter((c) => c.state === 'working').length, 0),
      windows: all.filter((ws) => ws.windowOpen).length,
    };
    this.post({ type: 'state', workstreams: changed, keys, machine });
    this.shown.retain(new Set(all.map((ws) => ws.key)));
    this.listed.retain(new Set(all.map((ws) => ws.key)));
    for (const ws of all) this.postMarks(ws);
    this.postExclusions();
    this.ci.update(all);
  }

  /** The Overview says what still lets VS Code see the worktrees folder, when there are worktrees in it. */
  private postExclusions(): void {
    const inFolder = this.deps.repository.current.some((ws) => ws.worktree.path && isInWorktreesFolder(this.deps.mainRoot, ws.worktree.path));
    this.post({ type: 'exclusions', missing: inFolder ? currentMissingExclusions() : [] });
  }

  /** Shows a workstream; with path, also expands to and highlights that file in the Files tool. */
  reveal(key: string, relPath?: string, tool?: Tool, vcView?: VcView): void {
    this.act({ type: 'reveal', key, path: relPath, tool, vcView });
  }

  /** Shows a worktree's CI/CD view (Version Control › CI/CD). */
  showCi(key: string): void {
    this.reveal(key, undefined, 'vc', 'ci');
  }

  /** Whether the CI/CD view keeps reading while the sidebar is hidden (for the notices of the leading window). */
  setKeepReading(on: boolean): void {
    this.ci.setKeepReading(on);
  }

  /**
   * Shows a worktree's history with a ticket's commits highlighted, keeping the focus where it is (the ticket): the
   * sidebar is only brought into view.
   */
  async showCommits(key: string, ticket: string, hashes: string[], selected: string): Promise<void> {
    await this.showKeepingFocus();
    this.act({ type: 'showCommits', key, ticket, hashes, selected });
  }

  /** Shows a worktree's Version Control on its ticket's Changes, that file selected (Expand in the ticket, BL-171). */
  async showTicketChanges(key: string, ticket: string, path: string): Promise<void> {
    await this.showKeepingFocus();
    this.act({ type: 'showTicketChanges', key, ticket, path });
  }

  /** Brings the sidebar into view, the focus staying in the editor (the ticket). */
  private async showKeepingFocus(): Promise<void> {
    if (this.view) this.view.show(true);
    else {
      // Not created yet: opening it takes the focus; give it back to the editor.
      await vscode.commands.executeCommand(`${SidebarProvider.viewId}.focus`);
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    }
  }

  /** Sends an action (reveal, show a tool, …) now, or once the page is ready, so it isn't lost while it loads. */
  private act(message: HostMessage): void {
    if (this.view && this.ready) this.post(message);
    else this.pending.push(message);
  }

  /** Shows the sidebar on the given tool. */
  async showTool(tool: Tool): Promise<void> {
    await vscode.commands.executeCommand(`${SidebarProvider.viewId}.focus`);
    this.act({ type: 'tool', tool });
  }

  /** Shows the backlog with the note's card (where its question is answered), as its "Needs you" row does. */
  async showNote(id: string): Promise<void> {
    await this.showTool('backlog');
    this.act({ type: 'showNote', id });
  }

  /** The Files tab's change marks of a worktree, when they differ from the ones it has. */
  private postMarks(ws: Workstream): void {
    const marks = changeMarks(ws.staged, ws.unstaged, this.listed.of(ws.key));
    if (this.listed.changed(ws.key, marks)) this.post({ type: 'marks', key: ws.key, marks });
  }

  dirsChanged(key: string, paths: string[]): void {
    this.post({ type: 'dirsChanged', key, paths });
  }

  dispose(): void {
    this.subscriptions.forEach((d) => d.dispose());
    this.shown.dispose();
    this.visibility.dispose();
  }

  private post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  /** The worktree folder of a workstream, when reachable. */
  root(key: string): string | undefined {
    return this.find(key)?.worktree.path;
  }

  private find(key: string): Workstream | undefined {
    return this.deps.repository.current.find((w) => w.key === key);
  }

  /** The period the Metrics tool shows, while it's shown: it's counted again as events come in. */
  private metricsPeriod: MetricsPeriod | undefined;

  private async postMetrics(): Promise<void> {
    const period = this.metricsPeriod;
    if (!period || !this.deps.metrics) return;
    const message = await this.deps.metrics.message(period);
    if (this.metricsPeriod === period) this.post(message);
  }

  private async onMessage(m: WebviewMessage): Promise<void> {
    switch (m.type) {
      case 'metrics':
        this.metricsPeriod = m.period;
        await this.postMetrics();
        return;
      case 'metricsClosed':
        this.metricsPeriod = undefined;
        return;
      case 'metricsOpen':
        await vscode.commands.executeCommand('flotilla.openBacklogItem', m.ticket);
        return;
      case 'metricsOpenChat':
        this.deps.metrics?.openChat(m.session, m.cwd);
        return;
      case 'metricsEditor':
        this.deps.metrics?.openEditor(m.period);
        return;
      case 'ready':
        void this.postIconTheme();
        // A page that has just loaded has none of the views: send them all.
        this.sent.clear();
        this.listed.clear();
        this.postState();
        this.post({ type: 'active', key: this.deps.active.key });
        this.post({ type: 'tabs', closed: [...this.deps.active.closedTabs] });
        void this.postBacklog();
        void this.postNotes();
        this.post({ type: 'progress', tools: progressByTool() });
        this.post({ type: 'ci', views: this.ci.snapshot() });
        this.postStorage();
        this.ready = true;
        this.pending.splice(0).forEach((message) => this.post(message));
        return;
      case 'listDir': {
        const ws = this.find(m.key);
        if (!ws?.worktree.path) return;
        this.listed.add(m.key, m.path);
        const exclude = vscode.workspace.getConfiguration('files', this.deps.reference).get<Record<string, unknown>>('exclude') ?? {};
        let entries: Awaited<ReturnType<typeof listDirectory>> = [];
        try {
          entries = await listDirectory(ws.worktree.path, m.path, { hideWorktrees: ws.worktree.isMain, isExcluded: excludeMatcher(exclude) });
          entries = await markIgnored(ws.worktree.path, m.path, entries);
        } catch {
          // deleted meanwhile: show it empty
        }
        this.shown.watch(m.key, ws.worktree.path, m.path);
        this.post({ type: 'dir', key: m.key, path: m.path, entries });
        const current = this.find(m.key);
        if (current) this.postMarks(current);
        return;
      }
      case 'openFile': {
        const ws = this.find(m.key);
        if (!ws?.worktree.path) return;
        const uri = toWorkspaceUri(this.deps.reference, resolveInside(ws.worktree.path, m.path));
        const selection = m.line ? new vscode.Range(m.line - 1, m.range?.[0] ?? 0, m.line - 1, m.range?.[1] ?? 0) : undefined;
        await vscode.window.showTextDocument(uri, { preview: m.preview, preserveFocus: m.preview && !selection, selection });
        return;
      }
      case 'active':
        this.deps.active.set(m.key);
        return;
      case 'search':
        await this.search(m.id, m.scope, m.query, m.options, m.limit);
        return;
      case 'replace':
        await this.replace(m.scope, m.query, m.options, m.replacement, m.key, m.path);
        return;
      case 'openView':
        await vscode.commands.executeCommand(m.view === 'debug' ? 'workbench.view.debug' : 'workbench.view.extensions');
        return;
      case 'commit': {
        const ws = this.find(m.key);
        if (ws && (await this.deps.commit(ws, m.message, { amend: m.amend, then: m.then }))) this.post({ type: 'committed', key: m.key });
        return;
      }
      case 'create':
        this.post({ type: 'editResult', ...(await this.editResult(() => this.files.create(m.key, m.kind, m.dir, m.name))) });
        return;
      case 'rename':
        this.post({ type: 'editResult', ...(await this.editResult(() => this.files.rename(m.key, m.path, m.name))) });
        return;
      case 'move':
        await this.files.move(m.from, m.to);
        return;
      case 'command':
        if (!m.command.startsWith('flotilla.')) return;
        await vscode.commands.executeCommand(m.command, m.target);
        return;
      case 'log':
        await this.postLog(m.key, m.skip);
        return;
      case 'backlog': {
        // The card's button shows it's working until this says it's done (BL-117), whether it posted, failed or returned early.
        let failed = false;
        const clicked = Date.now();
        try {
          await this.onBacklog(m);
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          this.post({ type: 'backlogDone', message: m, ...(failed ? { failed } : {}) });
          recordClickWait(`backlog:${m.op}`, clicked, 'id' in m ? m.id : undefined);
        }
        return;
      }
      case 'note': {
        let failed = false;
        try {
          await this.notes?.onMessage(m);
          await this.postNotes();
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          this.post({ type: 'noteDone', message: m, ...(failed ? { failed } : {}) });
        }
        return;
      }
      case 'folding':
        await vscode.commands.executeCommand('setContext', 'flotilla.canFold', m.canFold);
        await vscode.commands.executeCommand('setContext', 'flotilla.allFolded', m.allFolded);
        return;
      case 'openCommit': {
        const ws = this.find(m.key);
        if (ws?.worktree.path) await openCommit(this.deps.reference, ws.worktree.path, m.hash, m.path);
        return;
      }
      case 'commitFiles': {
        const dir = this.root(m.key);
        if (!dir || !/^[0-9a-f]{4,64}$/.test(m.hash)) return;
        try {
          const { changes } = await commitChanges(dir, m.hash);
          this.post({ type: 'commitFiles', key: m.key, hash: m.hash, files: changes });
        } catch (error) {
          this.post({ type: 'commitFiles', key: m.key, hash: m.hash, files: [], error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      case 'ticketVc':
        this.post({ type: 'ticketVc', id: m.id, view: await this.tickets?.ticketVc(m.id) });
        return;
      case 'openTicketChange':
        await this.tickets?.openTicketChange(m.id, m.group, m.path);
        return;
      case 'backToTicket':
        await this.tickets?.showChange({ id: m.id, ...(m.path ? { path: m.path } : {}) });
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        return;
      case 'openUrl':
        // Only GitHub pages (a workflow run) open from the sidebar.
        if (/^https:\/\/github\.com\//.test(m.url)) await vscode.env.openExternal(vscode.Uri.parse(m.url));
        return;
      case 'openSite': {
        // A deployed site (its URL comes from GitHub's deployment status): http or https only.
        const url = webUrl(m.url);
        if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }
      case 'ci':
        if (m.op === 'signIn') await this.ci.signIn().catch((e: unknown) => this.report(e));
        else if (m.op === 'expand' || m.op === 'collapse') await this.ci.expand(m.key, m.runId, m.op === 'expand');
        else if (m.op === 'showLog') await this.ci.showLog(m.key, m.jobId, m.jobName);
        else if (m.op === 'act') await this.ci.act(m.key, m.run, m.action).catch((e: unknown) => this.report(e));
        else if (m.op === 'fix') await this.ci.fix(m.key, m.run, m.job).catch((e: unknown) => this.report(e));
        else await this.ci.refresh();
        return;
      case 'runWorkflow': {
        const folder = this.root(m.key);
        if (!folder) throw new Error("This worktree's folder isn't reachable from this environment.");
        // A run shows at once, and again a few seconds on, when GitHub lists it.
        if (await this.ci.runWorkflow(m.key, () => runWorkflowByHand(folder, this.deps.githubApi))) {
          setTimeout(() => void this.ci.refresh(true), RUN_LISTED_MS);
        }
        return;
      }
      case 'refs': {
        const dir = this.compareDir();
        if (!dir) return;
        const [refs, defaultBase] = await Promise.all([
          listRefs(dir).catch(() => ({ local: [], remote: [], tags: [] })),
          resolveBase(dir, vscode.workspace.getConfiguration('flotilla').get<string>('defaultBase', '')),
        ]);
        this.post({ type: 'refs', defaultBase, ...refs });
        return;
      }
      case 'compare': {
        try {
          const { files } = await this.compareRefs(m);
          this.post({ type: 'compared', id: m.id, files });
        } catch (error) {
          this.post({ type: 'compared', id: m.id, files: [], error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      case 'openCompare': {
        const { dir, result } = await this.compareRefs(m);
        const title = `${m.base} ↔ ${m.head}${m.worktree ? ' (working tree)' : ''}`;
        if (m.path === undefined) {
          if (result.files.length) await openChangesEditor(this.deps.reference, dir, result.files, result.leftRef, result.rightRef, title);
          return;
        }
        const change = result.files.find((f) => f.path === m.path);
        if (change) await openChangeDiff(this.deps.reference, dir, change, result.leftRef, result.rightRef, title);
        return;
      }
    }
  }

  /** Where refs are compared: any reachable worktree (they share refs), the main one first. */
  private compareDir(): string | undefined {
    const reachable = this.deps.repository.current.filter((w) => w.worktree.path);
    return (reachable.find((w) => w.worktree.isMain) ?? reachable[0])?.worktree.path;
  }

  private async compareRefs(m: RefComparison): Promise<{ dir: string; result: Awaited<ReturnType<typeof compareRefs>> } & { files: FileChange[] }> {
    const dir = m.worktree ? this.root(m.worktree) : this.compareDir();
    if (!dir) throw new Error('That worktree is not reachable from this environment.');
    const result = await compareRefs(dir, m.base, m.head, 'twoDot', m.worktree !== undefined);
    return { dir, result, files: result.files };
  }

  private async postLog(key: string, skip: number): Promise<void> {
    const ws = this.find(key);
    const head = ws?.sync.head;
    if (!ws?.worktree.path || !head) {
      this.post({ type: 'log', key, head, skip, commits: [], more: false });
      return;
    }
    try {
      const page = await readLog(ws.worktree.path, { skip, limit: LOG_PAGE, upstream: ws.sync.upstream, hasRemote: ws.sync.hasRemote });
      this.post({ type: 'log', key, head, skip, ...page });
    } catch (error) {
      this.post({ type: 'log', key, head, skip, commits: [], more: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async search(id: number, scope: string, query: string, options: SearchOptions, requested?: number): Promise<void> {
    const limit = requested ?? vscode.workspace.getConfiguration('flotilla').get<number>('search.maxResults', 2000);
    const targets = this.deps.repository.current.filter((w) => w.worktree.path && (scope === ALL || w.key === scope));
    try {
      const results = await Promise.all(targets.map(async (w) => ({ key: w.key, result: await searchWorktree(w.worktree.path!, query, options, limit) })));
      const groups: SearchGroup[] = tabOrder(targets)
        .map((w) => results.find((r) => r.key === w.key)!)
        .filter((r) => r.result.files.length)
        .map((r) => ({ key: r.key, files: r.result.files }));
      this.post({ type: 'searchResults', id, groups, truncated: results.some((r) => r.result.truncated), limit });
    } catch (error) {
      this.post({ type: 'searchResults', id, groups: [], truncated: false, limit, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Replaces the matches in the scope (or one file) as one undoable edit; asks first when more than one file changes. */
  private async replace(scope: string, query: string, options: SearchOptions, replacement: string, key?: string, relPath?: string): Promise<void> {
    const re = matcher(query, options);
    if (!re || !query) return;
    const targets = this.deps.repository.current.filter((w) => w.worktree.path && (key ? w.key === key : scope === ALL || w.key === scope));
    const files: vscode.Uri[] = [];
    for (const w of targets) {
      const paths = relPath ? [relPath] : (await searchWorktree(w.worktree.path!, query, options, Number.MAX_SAFE_INTEGER)).files.map((f) => f.path);
      files.push(...paths.map((p) => toWorkspaceUri(this.deps.reference, resolveInside(w.worktree.path!, p))));
    }
    const edit = new vscode.WorkspaceEdit();
    const documents: vscode.TextDocument[] = [];
    let count = 0;
    for (const uri of files) {
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      let changed = false;
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        if (m[0] === '') {
          re.lastIndex++;
          continue;
        }
        edit.replace(uri, new vscode.Range(doc.positionAt(m.index), doc.positionAt(m.index + m[0].length)), replacementFor(m[0], re, replacement, options));
        changed = true;
        count++;
      }
      if (changed) documents.push(doc);
    }
    if (!count) {
      this.post({ type: 'replaced', count: 0 });
      return;
    }
    if (documents.length > 1) {
      const choice = await vscode.window.showWarningMessage(
        `Replace ${count} occurrence${count === 1 ? '' : 's'} across ${documents.length} files with '${replacement}'?`,
        { modal: true, detail: 'You can undo this in each file (Ctrl+Z).' },
        'Replace',
      );
      if (!choice) return;
    }
    const wasDirty = new Set(documents.filter((d) => d.isDirty).map((d) => d.uri.toString()));
    await vscode.workspace.applyEdit(edit);
    // Files that had no unsaved changes are saved, like a replace on disk; others keep the user's unsaved work open.
    await Promise.all(documents.filter((d) => !wasDirty.has(d.uri.toString())).map((d) => d.save()));
    this.post({ type: 'replaced', count });
  }

  private async editResult(run: () => Promise<string | undefined>): Promise<{ ok: boolean; error?: string }> {
    try {
      const error = await run();
      return error ? { ok: false, error } : { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.deps.output.appendLine(message);
    void vscode.window.showErrorMessage(message);
  }

  private html(webview: vscode.Webview, dist: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(dist, ...p)).toString();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('codicons', 'codicon.css')}">
<link rel="stylesheet" href="${uri('webview.css')}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${uri('webview.js')}"></script>
</body>
</html>`;
  }
}

/** Past this context a chat is marked as big (flotilla.chats.bigContext; 0: never). */
function bigContext(): number {
  return vscode.workspace.getConfiguration('flotilla').get<number>('chats.bigContext', 200_000);
}

/**
 * Sets the agent limit where it's set now: flotilla.autopilot.maxAgents (its older name) if the user set that, else
 * flotilla.agents.maxRunning; in the workspace if it's set there, else for the user.
 */
async function setAgentLimit(max: number): Promise<void> {
  if (!Number.isInteger(max) || max < 1) return;
  const config = vscode.workspace.getConfiguration('flotilla');
  const older = config.inspect<number>('autopilot.maxAgents');
  const key = (older?.workspaceFolderValue ?? older?.workspaceValue ?? older?.globalValue) !== undefined ? 'autopilot.maxAgents' : 'agents.maxRunning';
  const set = config.inspect<number>(key);
  const target =
    set?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : set?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
  await config.update(key, max, target);
}

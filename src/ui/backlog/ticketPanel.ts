import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import { acceptItem, agentChatItem, branchMatches, childrenOf, removeItem, entryAgent, sameAgent, linkIssue, linkedItem, unlinkIssue, updateItem, type AgentChoice, type BacklogItem } from '../../features/backlog/backlog';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import { markdownToJira } from '../../features/backlog/sources/jiraMarkup';
import type { IssueSource, RemoteDetails, RemoteEditOptions, RemoteIssue } from '../../features/backlog/sources/source';
import type { BacklogIntegrations } from './integrations';
import { entryDate, type Ticket, type TicketEntry } from '../../features/backlog/ticket';
import { LocalBacklog as Store } from '../../features/backlog/localBacklog';
import type { Workstream } from '../../features/workstreams/workstream';
import type { AgentChatView, TicketHostMessage, TicketView, TicketWebviewMessage } from '../../webview/ticketProtocol';
import { ATTENTION_LABEL, workstreamLabel } from '../format';
import { runGit } from '../../core/git/gitCli';
import { toWorkspaceUri } from '../../core/uris';
import { parseFileLink } from '../../features/backlog/ticket';
import { compareRewrite } from '../../features/backlog/history';
import { ticketCommits, versionCommits } from '../../features/history/log';
import { resolveBase } from '../../features/workstreams/progress';
import { readSettings } from '../settings';
import { openCommit } from '../openCommit';
import type { ReviewLoop } from './reviewLoop';
import { agentChoice, validModel } from './agentRunner';

export interface TicketDeps {
  extensionUri: vscode.Uri;
  /** The main worktree, where branches and commits are read. */
  mainRoot: string;
  /** This window's folder, for opening diffs. */
  reference: vscode.Uri;
  backlog: LocalBacklog;
  integrations: BacklogIntegrations;
  repository: Repository<Workstream>;
  /** Shows a worktree's tab in the sidebar. */
  revealWorktree(key: string): void;
  /** Shows a worktree's history in the sidebar, a ticket's commits highlighted, without taking the focus. */
  showCommits(key: string, ticket: string, hashes: string[], selected: string): Promise<void>;
  /** What's remembered for the user (across windows): "Show activity" is kept open or shut. */
  memento: vscode.Memento;
}

/** The key the "Show activity" choice is kept under in the memento. */
const SHOW_ACTIVITY_KEY = 'flotilla.ticket.showActivity';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Renders Markdown with VS Code's own renderer (the built-in Markdown extension); plain text if it's unavailable. */
async function renderMarkdown(text: string, webview: vscode.Webview, dir: string, roots: readonly string[] = []): Promise<string> {
  if (!text.trim()) return '';
  let html: string;
  try {
    html = await vscode.commands.executeCommand<string>('markdown.api.render', text);
  } catch {
    html = `<pre>${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</pre>`;
  }
  // Images next to the tickets (BL-3/shot.png) load through the webview.
  // Task list items ("- [ ] …") as checkboxes, like GitHub shows them.
  html = html.replace(/(<li\b[^>]*>)\s*\[([ xX])\]\s+/g, (_m, li: string, mark: string) => `${li}<span class="task${mark === ' ' ? '' : ' checked'}"></span>`);
  // Others, in the repository (from its root: the ticket's worktrees, then the main one) or anywhere on disk, are
  // embedded.
  return replaceImages(html, async (src) => {
    if (/^(https?|data):/i.test(src) || src.startsWith('//')) return undefined;
    let rel = src;
    try {
      rel = /^file:/i.test(src) ? vscode.Uri.parse(src).fsPath : decodeURIComponent(src);
    } catch {
      // As written.
    }
    const besideTicket = path.resolve(dir, rel);
    if (besideTicket.startsWith(dir + path.sep) && fs.existsSync(besideTicket)) return webview.asWebviewUri(vscode.Uri.file(besideTicket)).toString();
    const candidates = path.isAbsolute(rel) ? [rel] : roots.map((r) => path.join(r, rel));
    for (const file of candidates) {
      const uri = await imageDataUri(file);
      if (uri) return uri;
    }
    return undefined;
  });
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

/** An image file as a data: URI (at most MAX_IMAGE_BYTES); undefined if it isn't one, or isn't there. */
async function imageDataUri(file: string): Promise<string | undefined> {
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!type) return undefined;
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return undefined;
    return `data:${type};base64,${(await fs.promises.readFile(file)).toString('base64')}`;
  } catch {
    return undefined;
  }
}

/** Replaces the images' sources in html (src: the new one, or undefined to keep it). */
export async function replaceImages(html: string, src: (current: string) => Promise<string | undefined>): Promise<string> {
  const pattern = /(<img\b[^>]*?\ssrc=")([^"]+)(")/g;
  const found = [...new Set([...html.matchAll(pattern)].map((m) => m[2].replace(/&amp;/g, '&')))];
  const replaced = new Map(await Promise.all(found.map(async (s) => [s, await src(s).catch(() => undefined)] as const)));
  return html.replace(pattern, (m, a: string, s: string, c: string) => {
    const next = replaced.get(s.replace(/&amp;/g, '&'));
    return next ? `${a}${next}${c}` : m;
  });
}

/** An item with its agent choice (none, when both are the defaults). */
function withAgent(item: BacklogItem, agent: AgentChoice): BacklogItem {
  const { agent: _old, ...rest } = item;
  const clean: AgentChoice = { ...(agent.model ? { model: agent.model } : {}), ...(agent.effort ? { effort: agent.effort } : {}) };
  return clean.model || clean.effort ? { ...rest, agent: clean } : rest;
}

/** Markdown (as comments and reports are written here) in a tracker's markup. */
function inMarkup(source: IssueSource, markdown: string): string {
  return source.markup === 'jira' ? markdownToJira(markdown.trim()) : markdown.trim();
}

/** An issue as read from its tracker: its details, and what can be changed (unknown if asking failed). */
interface RemoteRead {
  details: RemoteDetails;
  edit?: RemoteEditOptions;
}

/** Ticket editor tabs: one per backlog item, kept up to date with the ticket file and the item's worktree. */
export class TicketPanels implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly subscriptions: vscode.Disposable[] = [];

  private reviews: ReviewLoop | undefined;

  /** The review loop, for the tickets' review panel (created after the tickets). */
  useReviews(reviews: ReviewLoop): void {
    this.reviews = reviews;
    this.subscriptions.push(reviews.onDidChange(() => this.refreshAll()));
  }

  constructor(private readonly deps: TicketDeps) {
    this.subscriptions.push(
      { dispose: deps.repository.onDidChange(() => this.refreshAll()).dispose },
      deps.backlog.watch(() => this.refreshAll()),
      // Refreshed issues: read their details again too.
      deps.integrations.onDidChange(() => {
        this.details.clear();
        this.refreshAll();
      }),
    );
  }

  dispose(): void {
    this.subscriptions.forEach((d) => d.dispose());
    this.panels.forEach((p) => p.dispose());
  }

  async open(id: string): Promise<void> {
    // An issue linked to a local item is part of it.
    id = linkedItem(await this.deps.backlog.read(), id)?.id ?? id;
    const existing = this.panels.get(id);
    if (existing) {
      existing.reveal();
      return;
    }
    const item = await this.item(id);
    if (!item) return;
    const dist = vscode.Uri.joinPath(this.deps.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel('flotilla.ticket', `${item.id} ${item.title}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [dist, vscode.Uri.file(this.deps.backlog.dir)],
    });
    panel.iconPath = vscode.Uri.joinPath(this.deps.extensionUri, 'media', 'flotilla.svg');
    panel.webview.html = this.html(panel.webview, dist);
    this.panels.set(id, panel);
    panel.onDidDispose(() => this.panels.delete(id));
    panel.webview.onDidReceiveMessage((m: TicketWebviewMessage) =>
      this.onMessage(id, panel, m).catch((e: unknown) => void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))),
    );
  }

  /**
   * The user reviews an item's work (Flotilla: Review Ticket…): asks for what isn't given. Approve, or request changes
   * that an agent then picks up.
   */
  async review(id?: string, verdict?: 'approved' | 'changes', text?: string): Promise<void> {
    if (!this.reviews) return;
    const items = (await this.deps.backlog.read()).items.filter((i) => !i.proposed && i.status !== 'done' && this.worktreesOf(i).length > 0);
    if (!id) {
      const order = (i: BacklogItem) => (i.status === 'review' ? 0 : 1);
      const picked = await vscode.window.showQuickPick(
        [...items].sort((a, b) => order(a) - order(b)).map((i) => ({ label: i.id, description: i.title, detail: i.status === 'review' ? 'In review' : undefined })),
        { title: 'Review a Ticket', placeHolder: 'The ticket whose work to review' },
      );
      if (!picked) return;
      id = picked.label;
    }
    if (!items.some((i) => i.id === id)) {
      void vscode.window.showWarningMessage(`${id} has no work to review: it needs a worktree.`);
      return;
    }
    if (!verdict) {
      const picked = await vscode.window.showQuickPick(
        [
          { label: '$(check) Approve', verdict: 'approved' as const },
          { label: '$(request-changes) Request Changes', verdict: 'changes' as const, detail: 'An agent picks them up, and asks you first if it needs more context' },
        ],
        { title: `Review ${id}` },
      );
      if (!picked) return;
      verdict = picked.verdict;
    }
    if (text === undefined) {
      text = await vscode.window.showInputBox({
        title: `${verdict === 'approved' ? 'Approve' : 'Request changes on'} ${id}`,
        prompt: verdict === 'approved' ? 'A comment (optional)' : 'What should change (Markdown; leave it empty and the agent asks you)',
      });
      if (text === undefined) return;
    }
    await this.reviews.userReview(id, verdict, text);
  }

  /** The worktrees working on an item: those started for it, or whose branch carries its id. */
  worktreesOf(item: BacklogItem): Workstream[] {
    return this.deps.repository.current.filter((w) => !w.worktree.isMain && w.worktree.branch && branchMatches(item, w.worktree.branch));
  }

  /** A local item, or an issue from an integration (as an item, with remote set). */
  private async item(id: string): Promise<(BacklogItem & { remote?: RemoteIssue }) | undefined> {
    const local = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    if (local) return local;
    const remote = this.deps.integrations.issues().find((i) => i.id === id);
    return remote && { id, title: remote.title, status: remote.status, priority: remote.priority, created: '', remote };
  }

  /** Issues read from their trackers, for a minute: views refresh often (worktrees change), trackers can be slow. */
  private readonly details = new Map<string, { at: number; settled: boolean; value: Promise<RemoteRead> }>();

  /** An issue's details, cached (fresh: read again, e.g. after commenting); refreshes while it's read share the read. */
  private remoteDetails(id: string, fresh = false): Promise<RemoteRead> {
    const cached = this.details.get(id);
    if (cached && !fresh && Date.now() - cached.at < 60_000) return cached.value;
    const entry = {
      at: Date.now(),
      settled: false,
      value: (async () => {
        const source = await this.source(id);
        // What can be changed is asked of the tracker too (its workflow, its fields); without it, the issue just shows.
        const [details, edit] = await Promise.all([source.details(id), source.editOptions(id).catch(() => undefined)]);
        return { details, edit };
      })(),
    };
    this.details.set(id, entry);
    entry.value.then(
      () => (entry.settled = true),
      () => this.details.get(id) === entry && this.details.delete(id),
    );
    return entry.value;
  }

  /** The integration an issue is in (a listed one, or one linked to a local item). */
  private async source(issue: string): Promise<IssueSource> {
    const link = (await this.deps.backlog.read()).items.flatMap((i) => i.links ?? []).find((l) => l.id === issue);
    const source = await this.deps.integrations.sourceOf(issue, link?.source);
    if (!source) throw new Error(`The integration of ${issue} is no longer connected.`);
    return source;
  }

  /**
   * A ticket's local activity entries, rendered, with their keys, where they were posted, and their agent's chat: for
   * an agent's report, the chat that wrote it; for "Opened a chat for agent …", the chat it opened.
   */
  private async localEntries(item: BacklogItem, entries: TicketEntry[], webview: vscode.Webview): Promise<TicketView['activity']> {
    const posted = await this.deps.backlog.posted();
    const agents = new Map(this.agentChats(item, entries).map((c) => [c.agent.toLowerCase(), c]));
    return Promise.all(
      entries.map(async (e) => {
        const key = Store.entryKey(item.id, e);
        const opened = e.author === 'Flotilla' ? /chat for agent ([A-Za-z0-9-]+)/.exec(e.body)?.[1] : undefined;
        const agent = opened ?? entryAgent(e.author);
        const found = agent ? agents.get(agent.toLowerCase()) : undefined;
        const at = new Date(e.date.replace(' ', 'T')).getTime();
        // An agent opened in the last hours whose chat isn't there yet: its first message waits to be sent.
        const chat: AgentChatView | undefined = found ?? (opened && Date.now() - at < 12 * 3_600_000 ? { pending: true, agent: opened, headless: /^Review round/.test(e.body) } : undefined);
        return {
          ...e,
          html: await renderMarkdown(e.body, webview, this.deps.backlog.dir, this.roots(item)),
          key,
          ...(posted[key] ? { posted: posted[key] } : {}),
          ...(chat ? { chat } : {}),
        };
      }),
    );
  }

  /** The chats of agents started for an item (their first message names it), in its worktrees, oldest first. */
  /**
   * The chats of agents that worked on an item, oldest first: those started for it (their first message names it),
   * and any chat (in any worktree) whose agent signed one of its entries or that an entry says was opened for it.
   */
  private agentChats(item: BacklogItem, entries: TicketEntry[]): Array<Exclude<AgentChatView, { pending: true }>> {
    const named = new Set(
      entries
        .map((e) => entryAgent(e.author) ?? (e.author === 'Flotilla' ? /chat for agent ([A-Za-z0-9-]+)/.exec(e.body)?.[1] : undefined))
        .filter((n): n is string => !!n)
        .map((n) => n.toLowerCase()),
    );
    // What Flotilla started each agent with ("chat for agent Nova-7 (opus, high effort)"), until its chat says.
    const startedWith = new Map<string, { model?: string; effort?: string }>();
    for (const e of entries) {
      const m = e.author === 'Flotilla' ? /chat for agent ([A-Za-z0-9-]+) \(([^)]*)\)/.exec(e.body) : undefined;
      if (!m) continue;
      const parts = m[2].split(', ');
      const effort = parts.find((p) => p.endsWith(' effort'))?.replace(/ effort$/, '');
      const model = parts.find((p) => !p.endsWith(' effort'));
      startedWith.set(m[1].toLowerCase(), { ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
    }
    const seen = new Set<string>();
    return this.deps.repository.current
      .flatMap((ws) =>
        ws.chats.flatMap((c) => {
          const started = agentChatItem(c.firstPrompt);
          const agent = started?.agent ?? c.agent;
          if (!agent || seen.has(c.id)) return [];
          if (started?.item !== item.id && !named.has(agent.toLowerCase())) return [];
          seen.add(c.id);
          return [
            {
              key: ws.key,
              id: c.id,
              agent,
              title: agentChatItem(c.title) ? item.title : c.title,
              state: c.state,
              message: c.message,
              branch: workstreamLabel(ws),
              started: (c.startedAt ?? c.updatedAt).toISOString(),
              updated: c.updatedAt.toISOString(),
              ...((c.model ?? startedWith.get(agent.toLowerCase())?.model) ? { model: c.model ?? startedWith.get(agent.toLowerCase())?.model } : {}),
              ...((c.effort ?? startedWith.get(agent.toLowerCase())?.effort) ? { effort: c.effort ?? startedWith.get(agent.toLowerCase())?.effort } : {}),
            },
          ];
        }),
      )
      .sort((a, b) => a.started.localeCompare(b.started));
  }


  /** Where a ticket's images and links are looked for: its worktrees, then the main one. */
  private roots(item: BacklogItem): string[] {
    return [...this.worktreesOf(item).flatMap((w) => (w.worktree.path ? [w.worktree.path] : [])), this.deps.mainRoot];
  }

  /** Images in a tracker's HTML that need its login (Jira's attachments), fetched with it and embedded; cached. */
  private readonly trackerImageCache = new Map<string, Promise<string | undefined>>();

  private async trackerImages(issue: string, html: string): Promise<string> {
    if (!html.includes('<img')) return html;
    const source = await this.source(issue).catch(() => undefined);
    if (!source?.image) return html;
    return replaceImages(html, (src) => {
      let cached = this.trackerImageCache.get(src);
      if (!cached) {
        cached = source.image!(src).then((img) => img && `data:${img.type};base64,${img.data.toString('base64')}`);
        // A failure is tried again next time.
        cached.catch(() => undefined).then((v) => v === undefined && this.trackerImageCache.delete(src));
        this.trackerImageCache.set(src, cached);
      }
      return cached;
    });
  }

  /** An issue's description and comments from its tracker, with the local activity (agents' reports) merged in. */
  private async remoteView(
    item: BacklogItem & { remote: RemoteIssue },
    webview: vscode.Webview,
  ): Promise<Pick<TicketView, 'description' | 'descriptionHtml' | 'activity' | 'error'> & { edit?: RemoteEditOptions; priorityName?: string }> {
    const dir = this.deps.backlog.dir;
    // Entries posted to the issue show as its comments.
    const localEntries = (await this.localEntries(item, (await this.deps.backlog.readTicket(item)).activity, webview)).filter((e) => !e.posted);
    try {
      const { details: d, edit } = await this.remoteDetails(item.id);
      const remoteEntries = await Promise.all(
        d.comments.map(async (c) => ({
          date: entryDate(new Date(c.date)),
          author: c.author,
          body: c.body,
          html: c.format === 'html' ? await this.trackerImages(item.id, c.body) : await renderMarkdown(c.body, webview, dir, this.roots(item)),
        })),
      );
      return {
        description: d.descriptionText,
        descriptionHtml: d.format === 'html' ? await this.trackerImages(item.id, d.description) : await renderMarkdown(d.description, webview, dir, this.roots(item)),
        activity: [...remoteEntries, ...localEntries].sort((a, b) => a.date.localeCompare(b.date)),
        edit,
        priorityName: d.issue.priorityName,
      };
    } catch (error) {
      return { description: '', descriptionHtml: '', activity: localEntries, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private refreshAll(): void {
    for (const [id, panel] of this.panels) void this.post(id, panel);
  }

  /** The latest post per panel: an older one that finishes later (a slow tracker) is dropped. */
  private readonly posts = new WeakMap<vscode.WebviewPanel, number>();

  /** Sends a ticket's view; never leaves the tab waiting: a failure shows in it. */
  private async post(id: string, panel: vscode.WebviewPanel): Promise<void> {
    const seq = (this.posts.get(panel) ?? 0) + 1;
    this.posts.set(panel, seq);
    let shown: BacklogItem | undefined;
    const send = (view: Omit<TicketView, 'agents' | 'showActivity'>) => {
      if (this.posts.get(panel) !== seq) return;
      const chats = shown ? this.agentChats(shown, view.activity) : [];
      // Each agent with the reports it signed.
      const agents = chats.map((c) => ({ ...c, reports: view.activity.filter((e) => sameAgent(entryAgent(e.author), c.agent)).length }));
      const showActivity = this.deps.memento.get<boolean>(SHOW_ACTIVITY_KEY, false);
      const message: TicketHostMessage = { type: 'ticket', ticket: { ...view, agents, showActivity } };
      void panel.webview.postMessage(message);
    };
    let base: Omit<TicketView, 'agents' | 'showActivity'> | undefined;
    try {
      const item = await this.item(id);
      if (!item) {
        panel.dispose();
        return;
      }
      panel.title = `${item.id} ${item.title}`;
      const dir = this.deps.backlog.dir;
      const { remote, ...plain } = item;
      base = { ...this.baseView(plain, remote), ...(await this.work(plain)), ...(await this.family(plain)) };
      shown = plain;
      if (remote) {
        // What the backlog knows shows at once; the description and comments follow from the tracker.
        if (!this.details.get(id)?.settled) send({ ...base, loading: true });
        const { edit, priorityName, ...content } = await this.remoteView({ ...plain, remote }, panel.webview);
        send({ ...base, ...content, remote: base.remote && { ...base.remote, edit, priorityName: priorityName ?? base.remote.priorityName } });
      } else {
        const ticket = await this.deps.backlog.readTicket(item);
        send({
          ...base,
          description: ticket.description,
          descriptionHtml: await renderMarkdown(ticket.description, panel.webview, dir, this.roots(plain)),
          activity: await this.localEntries(item, ticket.activity, panel.webview),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send({
        ...(base ?? {
          item: { id, title: id, status: 'todo', created: '' },
          description: '',
          descriptionHtml: '',
          activity: [],
          links: [],
          worktrees: [],
          postTargets: [],
          canCreateIssue: false,
          branches: [],
          commits: [],
          history: [],
          canCleanUp: false,
          agentDefaults: {},
          children: [],
          canReview: false,
        }),
        error: message,
      });
    }
  }

  /** A ticket's view without its description and activity. */
  private baseView(plain: BacklogItem, remote: RemoteIssue | undefined): Omit<TicketView, 'agents' | 'showActivity'> {
    const source = remote && this.deps.integrations.current.find((s) => s.config.id === remote.source);
    const issues = this.deps.integrations.issues();
    return {
      item: plain,
      description: '',
      descriptionHtml: '',
      activity: [],
      links: (plain.links ?? []).map((l) => {
        const now = issues.find((i) => i.id === l.id);
        return {
          id: l.id,
          kind: l.source.startsWith('github:') ? 'github' : 'jira',
          title: now?.title ?? l.title,
          url: l.url,
          statusName: now?.statusName,
        };
      }),
      remote: remote && source && { kind: source.config.kind, label: source.label, url: remote.url, statusName: remote.statusName, priorityName: remote.priorityName },
      postTargets: remote ? [remote.id] : (plain.links ?? []).map((l) => l.id),
      canCreateIssue: !remote && this.deps.integrations.current.length > 0,
      worktrees: this.worktreesOf(plain).map((ws) => ({
        key: ws.key,
        branch: workstreamLabel(ws),
        attention: ws.attention,
        status: ATTENTION_LABEL[ws.attention],
        message: ws.agent?.message,
        changes: ws.changes.length,
        ahead: ws.sync.ahead,
        behind: ws.sync.behind,
        ...(ws.sync.upstream ? { upstream: ws.sync.upstream } : {}),
      })),
      branches: [],
      commits: [],
      history: [],
      canCleanUp: false,
      agentDefaults: agentChoice(undefined),
      children: [],
      ...(plain.review ? { review: { ...plain.review, running: !!this.reviews?.isRunning(plain.id) } } : {}),
      canReview: !remote && !!this.reviews && this.worktreesOf(plain).length > 0,
    };
  }

  /** An item's parent and its parts. */
  private async family(item: BacklogItem): Promise<Pick<TicketView, 'parent' | 'children'>> {
    const data = await this.deps.backlog.read();
    const parent = item.parent ? data.items.find((i) => i.id === item.parent) : undefined;
    return {
      ...(parent ? { parent: { id: parent.id, title: parent.title, status: parent.status } } : {}),
      children: childrenOf(data, item.id).map((c) => ({ id: c.id, title: c.title, status: c.status, priority: c.priority, proposed: !!c.proposed })),
    };
  }

  /**
   * An item's branches without a worktree, its commits, and its history clean-ups: the one in progress, and the
   * histories kept (read from git: quick, and local).
   */
  private async work(item: BacklogItem & { remote?: RemoteIssue }): Promise<Pick<TicketView, 'branches' | 'commits' | 'rewrite' | 'history' | 'canCleanUp'>> {
    const cwd = this.deps.mainRoot;
    try {
      const local = (await runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd })).split('\n').filter(Boolean);
      const branches = local.filter((b) => branchMatches(item, b));
      const checkedOut = new Set(this.worktreesOf(item).map((w) => w.worktree.branch));
      const base = await resolveBase(cwd, readSettings().defaultBase);
      const ids = [item.id, ...(item.links ?? []).map((l) => l.id)];
      const [commits, history, rewrite] = await Promise.all([
        ticketCommits(cwd, { branches: branches.filter((b) => b !== base), base, ids, limit: 100 }),
        Promise.all([...(item.history ?? [])].reverse().map(async (v) => ({ ...v, log: await versionCommits(cwd, v.base, v.ref, 100) }))),
        item.rewrite &&
          compareRewrite(cwd, item.rewrite).then(
            (c) => ({ ...item.rewrite!, ...c, changes: this.deps.repository.current.find((w) => w.worktree.branch === item.rewrite!.clean)?.changes.length ?? 0 }),
            () => ({ ...item.rewrite!, differs: ['(a branch is missing)'], commits: 0, cleanCommits: 0, changes: 0 }),
          ),
      ]);
      // A local item's branch with commits of its own (not a clean-up's) can have its history cleaned up.
      const canCleanUp =
        !item.remote &&
        !item.rewrite &&
        !!base &&
        commits.some((c) => c.branches.some((b) => b !== base && !/-clean(-\d+)?$/.test(b)));
      return { branches: branches.filter((b) => !checkedOut.has(b) && b !== base), commits, history, canCleanUp, ...(rewrite ? { rewrite } : {}) };
    } catch {
      return { branches: [], commits: [], history: [], canCleanUp: false };
    }
  }

  /**
   * Opens a link from a description or an entry: a web page in the browser, or a file at its lines. A file's path is
   * from the repository root (in the ticket's worktrees first, then the main one: after a merge it's there) or next to
   * the ticket (its pictures); "path#L10-L20" and "path:10" select lines.
   */
  private async openHref(item: BacklogItem, href: string): Promise<void> {
    if (/^(https?|mailto):/i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return;
    const link = parseFileLink(/^file:/i.test(href) ? vscode.Uri.parse(href).fsPath + (href.includes('#') ? href.slice(href.indexOf('#')) : '') : href);
    const roots = [
      ...this.worktreesOf(item).flatMap((w) => (w.worktree.path ? [w.worktree.path] : [])),
      this.deps.mainRoot,
      this.deps.backlog.dir,
    ];
    const candidates = path.isAbsolute(link.path) ? [link.path] : roots.map((r) => path.join(r, link.path));
    const found = candidates.find((f) => fs.existsSync(f));
    if (!found) {
      void vscode.window.showWarningMessage(`${link.path} isn't there (anymore): not in ${item.id}'s worktrees, nor in the main worktree.`);
      return;
    }
    const uri = toWorkspaceUri(this.deps.reference, found);
    if (fs.statSync(found).isDirectory()) {
      await vscode.commands.executeCommand('revealInExplorer', uri);
      return;
    }
    const selection = link.start ? new vscode.Range(link.start - 1, 0, (link.end ?? link.start) - 1, link.end ? Number.MAX_SAFE_INTEGER : 0) : undefined;
    await vscode.commands.executeCommand('vscode.open', uri, { preview: true, ...(selection ? { selection } : {}) });
  }

  /** Reads the ticket, changes it and writes it back (the file may have changed since the view showed it). */
  private async changeTicket(item: BacklogItem, change: (t: Ticket) => Ticket): Promise<void> {
    await this.deps.backlog.writeTicket(item.id, change(await this.deps.backlog.readTicket(item)));
  }

  /** Adds an entry to a ticket's (local) activity: comments, and notes from Flotilla (an agent started). */
  async addActivity(id: string, author: string, body: string): Promise<void> {
    const item = await this.item(id);
    if (!item) return;
    await this.deps.backlog.appendActivity(item, { date: entryDate(new Date()), author, body: body.trim() });
  }

  private async onMessage(id: string, panel: vscode.WebviewPanel, m: TicketWebviewMessage): Promise<void> {
    const item = await this.item(id);
    if (!item) return;
    const backlog = this.deps.backlog;
    switch (m.type) {
      case 'ready':
        break;
      case 'title': {
        const title = m.title.trim();
        if (!title || title === item.title) return;
        if (item.remote) {
          await this.writeRemote(id, (s) => s.update(id, { title }));
          return;
        }
        await backlog.change((d) => updateItem(d, id, { title }));
        await this.changeTicket(item, (t) => ({ ...t, title }));
        break;
      }
      case 'description':
        if (item.remote) {
          // As the tracker writes it (Jira: wiki markup), as it was shown for editing.
          await this.writeRemote(id, (s) => s.update(id, { description: m.text }));
          return;
        }
        {
          const before = (await backlog.readTicket(item)).description;
          await this.changeTicket(item, (t) => ({ ...t, title: item.title, description: m.text }));
          if (before.trim() !== m.text.trim()) await backlog.noteDescriptions({ id, before, by: 'You' });
        }
        break;
      case 'showActivity':
        // Remembered for the user, and every ticket shows it the same way; no view changes.
        await this.deps.memento.update(SHOW_ACTIVITY_KEY, m.shown);
        return;
      case 'comment':
        if (!m.text.trim()) return;
        if (item.remote) {
          await this.writeRemote(id, (s) => s.comment(id, inMarkup(s, m.text)));
          return;
        } else {
          await this.addActivity(id, 'You', m.text);
        }
        break;
      case 'openRemote':
        if (item.remote) await vscode.env.openExternal(vscode.Uri.parse(item.remote.url));
        return;
      case 'status':
        await backlog.change((d) => updateItem(d, id, { status: m.status }));
        break;
      case 'priority':
        await backlog.change((d) => updateItem(d, id, { priority: m.priority }));
        break;
      case 'image': {
        const bytes = Buffer.from(m.data, 'base64');
        if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Images can be at most 10 MB.');
        const rel = await backlog.saveImage(id, m.name, bytes);
        const reply: TicketHostMessage = { type: 'imageSaved', requestId: m.requestId, markdown: `![${path.basename(rel)}](${rel})` };
        void panel.webview.postMessage(reply);
        return;
      }
      case 'start':
        await vscode.commands.executeCommand('flotilla.startBacklogItem', id, { agent: m.agent });
        return;
      case 'writeWithAI':
        await vscode.commands.executeCommand('flotilla.writeBacklogItem', id);
        return;
      case 'openFile':
        await vscode.window.showTextDocument(vscode.Uri.file(await backlog.ensureDocument(item)), { preview: false });
        return;
      case 'link':
        await vscode.commands.executeCommand('flotilla.linkBacklogItem', id);
        return;
      case 'unlink':
        await backlog.change((d) => unlinkIssue(d, id, m.id));
        break;
      case 'openLink': {
        const link = item.links?.find((l) => l.id === m.id);
        if (link) await vscode.env.openExternal(vscode.Uri.parse(link.url));
        return;
      }
      case 'openWorktree':
        if (this.worktreesOf(item).some((w) => w.key === m.key)) this.deps.revealWorktree(m.key);
        return;
      case 'transition': {
        const move = (await this.remoteDetails(id)).edit?.transitions.find((t) => t.id === m.id);
        if (!move || !item.remote) return;
        if (move.needs?.length) {
          // The workflow asks for more on this move (a resolution, a reviewer): that's done in the tracker.
          const open = await vscode.window.showWarningMessage(`"${move.name}" needs ${move.needs.join(', ')}, which Flotilla can't fill in.`, 'Do It in the Tracker');
          if (open) await vscode.env.openExternal(vscode.Uri.parse(item.remote.url));
          return;
        }
        await this.writeRemote(id, (s) => s.transition(id, move.id));
        return;
      }
      case 'remotePriority':
        await this.writeRemote(id, (s) => s.update(id, { priority: m.name }));
        return;
      case 'postEntry':
        await this.postEntry(item, m.key);
        return;
      case 'openCommit': {
        // In the history of a worktree that has it (one of the ticket's first, else the main one); its diff otherwise.
        const work = await this.work(item);
        const { commits } = work;
        const commit = commits.find((c) => c.hash === m.hash);
        // A commit of a kept history is on no branch: its diff.
        if (!commit) {
          if (work.history.some((v) => v.log.some((c) => c.hash === m.hash))) await openCommit(this.deps.reference, this.deps.mainRoot, m.hash);
          return;
        }
        const candidates = [
          ...this.worktreesOf(item).filter((w) => w.worktree.branch && commit.branches.includes(w.worktree.branch)),
          ...this.worktreesOf(item),
          ...this.deps.repository.current.filter((w) => w.worktree.isMain),
        ];
        for (const ws of candidates) {
          if (!ws.worktree.path) continue;
          const has = await runGit(['merge-base', '--is-ancestor', m.hash, 'HEAD'], { cwd: ws.worktree.path }).then(
            () => true,
            () => false,
          );
          if (has) {
            await this.deps.showCommits(ws.key, id, commits.map((c) => c.hash), m.hash);
            return;
          }
        }
        await openCommit(this.deps.reference, this.deps.mainRoot, m.hash);
        return;
      }
      case 'openHref':
        await this.openHref(item, m.href);
        return;
      case 'agentModel': {
        if (item.remote) return;
        let model = m.model?.trim() || undefined;
        if (model === 'other') {
          model = (
            await vscode.window.showInputBox({
              title: `The model for agents on ${id}`,
              prompt: "An alias (opus, sonnet, haiku, fable) or a model's full name (claude-opus-5-5)",
              value: item.agent?.model ?? '',
            })
          )?.trim();
          if (model === undefined) return;
        }
        if (model && !validModel(model)) {
          void vscode.window.showWarningMessage(`"${model}" isn't a model name: an alias (opus, sonnet…) or a model's id (letters, digits, dots and dashes).`);
          return;
        }
        await backlog.change((d) => ({ ...d, items: d.items.map((i) => (i.id === id ? withAgent(i, { ...i.agent, model: model || undefined }) : i)) }));
        break;
      }
      case 'agentEffort':
        if (item.remote) return;
        await backlog.change((d) => ({ ...d, items: d.items.map((i) => (i.id === id ? withAgent(i, { ...i.agent, effort: m.effort ?? undefined }) : i)) }));
        break;
      case 'cleanUp':
        await vscode.commands.executeCommand('flotilla.cleanUpHistory', id);
        return;
      case 'finishCleanUp':
        await vscode.commands.executeCommand('flotilla.finishCleanUp', id);
        return;
      case 'cancelCleanUp':
        await vscode.commands.executeCommand('flotilla.cancelCleanUp', id);
        return;
      case 'compareCleanUp':
        await vscode.commands.executeCommand('flotilla.compareCleanUp', id);
        return;
      case 'checkout':
        if ((await this.work(item)).branches.includes(m.branch)) await vscode.commands.executeCommand('flotilla.startBacklogItem', id, { agent: false, branch: m.branch });
        return;
      case 'startReview':
        await this.reviews?.start(id);
        return;
      case 'userReview':
        await this.reviews?.userReview(id, m.verdict, m.text);
        break;
      case 'reviewFix':
        await this.reviews?.fix(id, m.fix);
        return;
      case 'stopReview':
        await this.reviews?.stop(id);
        return;
      case 'accept':
        await backlog.change((d) => acceptItem(d, id));
        break;
      case 'dismiss':
        if (!item.proposed) return;
        await backlog.change((d) => removeItem(d, id));
        await backlog.deleteDocument(id);
        return;
      case 'openTicket':
        await this.open(m.id);
        return;
      case 'openChat':
        if (this.worktreesOf(item).some((w) => w.key === m.key)) await vscode.commands.executeCommand('flotilla.openChat', { key: m.key, chatId: m.id });
        return;
      case 'createIssue': {
        if (item.remote) return;
        const ticket = await backlog.readTicket(item);
        const link = await this.deps.integrations.createIssue(id, item.title, ticket.description);
        if (!link) return;
        await backlog.change((d) => linkIssue(d, id, link));
        await this.addActivity(id, 'Flotilla', `Created [${link.id}](${link.url}) and linked it.`);
        break;
      }
    }
    await this.post(id, panel);
  }

  /** Writes to an issue's tracker (only ever from a click in its tab), then reads it and the backlog again. */
  private async writeRemote(issue: string, write: (source: IssueSource) => Promise<void>): Promise<void> {
    await write(await this.source(issue));
    this.details.delete(issue);
    // The list has the status and priority the backlog shows; refreshing it refreshes the open tickets too.
    await this.deps.integrations.refresh();
  }

  /**
   * Posts a local activity entry (a comment or an agent's report) to the issue, or to one of a local item's linked
   * issues, after showing what will be posted and asking. Agents never post: they only write the ticket file.
   */
  private async postEntry(item: BacklogItem & { remote?: RemoteIssue }, key: string): Promise<void> {
    const entry = (await this.deps.backlog.readTicket(item)).activity.find((e) => Store.entryKey(item.id, e) === key);
    if (!entry) return;
    const targets = item.remote ? [item.remote.id] : (item.links ?? []).map((l) => l.id);
    const target = targets.length === 1 ? targets[0] : await vscode.window.showQuickPick(targets, { title: 'Post to Which Issue?' });
    if (!target) return;
    const source = await this.source(target);
    const text = inMarkup(source, `${entry.author && entry.author !== 'You' ? `**${entry.author}** (${entry.date}):\n\n` : ''}${entry.body}`);
    const preview = text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
    const choice = await vscode.window.showInformationMessage(
      `Post this ${entryAgent(entry.author) || entry.author === 'Agent' ? "agent's report" : 'entry'} to ${target} in ${source.label}?`,
      { modal: true, detail: preview },
      'Post',
    );
    if (choice !== 'Post') return;
    await source.comment(target, text);
    await this.deps.backlog.markPosted(key, target);
    this.details.delete(target);
    this.refreshAll();
  }

  private html(webview: vscode.Webview, dist: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(dist, ...p)).toString();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('codicons', 'codicon.css')}">
<link rel="stylesheet" href="${uri('ticket.css')}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${uri('ticket.js')}"></script>
</body>
</html>`;
  }
}

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import {
  addItem,
  agentChatItem,
  branchMatches,
  childrenOf,
  currentPrefix,
  itemBranches,
  entryAgent,
  sameAgent,
  linkedItem,
  readyToMerge,
  type BacklogItem,
} from '../../features/backlog/backlog';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import { markdownToJira } from '../../features/backlog/sources/jiraMarkup';
import type { IssueSource, RemoteDetails, RemoteEditOptions, RemoteIssue } from '../../features/backlog/sources/source';
import type { BacklogIntegrations } from './integrations';
import { entryAnchors, entryDate, entryThreads, parseReply, replyLine, type Ticket, type TicketEntry } from '../../features/backlog/ticket';
import { LocalBacklog as Store } from '../../features/backlog/localBacklog';
import type { Workstream } from '../../features/workstreams/workstream';
import type { AgentChatView, AttachmentView, MediaThumb, ReportView, TicketHostMessage, TicketView, TicketWebviewMessage } from '../../webview/ticketProtocol';
import { ATTENTION_LABEL, workstreamLabel } from '../format';
import { runGit } from '../../core/git/gitCli';
import { toWorkspaceUri } from '../../core/uris';
import { parseFileLink } from '../../features/backlog/ticket';
import { compareRewrite } from '../../features/backlog/history';
import { parseReport, reportAnswer, takeMedia } from '../../features/backlog/report';
import { mediaType, tooLarge, tooLargeNote, type MediaKind } from '../../features/backlog/media';
import { gatherAttachments, type FolderFile } from '../../features/backlog/attachments';
import { movesSince, ticketCommits, versionCommits } from '../../features/history/log';
import { ticketsForBacklogChange, ticketsForRepositoryChange, type OpenTicket } from '../../features/backlog/refresh';
import { resolveBase } from '../../features/workstreams/progress';
import { baseName, type MergeInfo } from '../../features/backlog/merged';
import type { Merges } from './merges';
import { baseLabel, dependsOn as dependsOnIds, isOpen } from '../../features/backlog/mainDrift';
import type { MainSync } from './mainSync';
import { readSettings } from '../settings';
import type { ReviewLoop } from './reviewLoop';
import type { Merger } from './merge';
import { agentChoice, askModel, isRunningHeadless, isRunningInTerminal, memoryShortage, modelLevels, spawnAsk } from './agentRunner';
import { heldBy, startedInTerminal } from '../../features/backlog/review';
import { AskChat } from '../../features/backlog/askChat';
import { askContextText, askInstructions, postedAnswer } from '../../features/backlog/ask';
import { formatMemory } from '../../features/workstreams/memory';
import { formatTokens, usageTip } from '../../features/chats/usage';
import { ticketUpdate } from '../../webview/ticketParts';
import type { Shaping } from './shaping';
import { discussable } from '../../features/backlog/shaping';
import { demoPath, demoRun, isReport, latestRun, parseRunBlocks, pickRunBlock, placedRunBlocks, withRunButtons } from '../../features/backlog/runBlocks';
import { gifSeconds, recordedDemo, withDemoUnits, type Recording } from '../../features/backlog/demo';
import { openTarget } from '../../features/backlog/runTarget';
import { demoPlace, runFingerprint, runPlaces, type RunPlace } from '../../features/backlog/runWorktree';
import { folderFor, missingName, startLaunch, startTask, type RunApprovals, type RunTerminals } from './runBlock';
import { creatingWorktrees } from '../../features/backlog/creatingWorktrees';
import type { CiRuns } from '../ci/ciRuns';
import { TicketCi } from './ticketCi';
import { handleMessage } from './ticketMessages';

export interface TicketDeps {
  extensionUri: vscode.Uri;
  /** The main worktree, where branches and commits are read. */
  mainRoot: string;
  /** This window's folder, for opening diffs. */
  reference: vscode.Uri;
  backlog: LocalBacklog;
  integrations: BacklogIntegrations;
  repository: Repository<Workstream>;
  /** Whether the items' work is merged (read from git). */
  merges: Merges;
  /** Run blocks: the approvals the user gave, and the terminals they run in. */
  approvals: RunApprovals;
  terminals: RunTerminals;
  /** Shows a worktree's tab in the sidebar. */
  revealWorktree(key: string): void;
  /** Shows a worktree's history in the sidebar, a ticket's commits highlighted, without taking the focus. */
  showCommits(key: string, ticket: string, hashes: string[], selected: string): Promise<void>;
  /** What's remembered for the user (across windows): "Show activity" is kept open or shut. */
  memento: vscode.Memento;
  /** Where the Ask chats' processes log (BL-80). */
  output?: vscode.OutputChannel;
  /** The CI/CD view's reader, and showing a worktree's CI/CD view: for the tickets' CI (BL-106). */
  ci?: CiRuns;
  showCi?(key: string): void;
}

/** The key the "Show activity" choice is kept under in the memento. */
const SHOW_ACTIVITY_KEY = 'flotilla.ticket.showActivity';

/** Whether the user keeps Flotilla's notes open (for every ticket, in every window). */
export function showActivityKept(memento: vscode.Memento): boolean {
  return memento.get<boolean>(SHOW_ACTIVITY_KEY, false);
}

export function keepShowActivity(memento: vscode.Memento, shown: boolean): Thenable<void> {
  return memento.update(SHOW_ACTIVITY_KEY, shown);
}

/** The key the tickets whose Attachments section the user folded are kept under in the memento (BL-110). */
const FOLDED_ATTACHMENTS_KEY = 'flotilla.ticket.foldedAttachments';

/** Whether the user folded a ticket's Attachments section. */
export function attachmentsFolded(memento: vscode.Memento, id: string): boolean {
  return memento.get<string[]>(FOLDED_ATTACHMENTS_KEY, []).includes(id);
}

export function keepAttachmentsFolded(memento: vscode.Memento, id: string, folded: boolean): Thenable<void> {
  const others = memento.get<string[]>(FOLDED_ATTACHMENTS_KEY, []).filter((i) => i !== id);
  return memento.update(FOLDED_ATTACHMENTS_KEY, folded ? [...others, id] : others);
}

/** The media files in a ticket's folder, by their path from the backlog's folder ("BL-3/shot.png"), with their times. */
async function folderFiles(dir: string, id: string): Promise<FolderFile[]> {
  const names = await fs.promises.readdir(path.join(dir, id)).catch(() => [] as string[]);
  const files = await Promise.all(
    names
      .filter((n) => mediaType(n))
      .map(async (n) => {
        const stat = await fs.promises.stat(path.join(dir, id, n)).catch(() => undefined);
        return stat?.isFile() ? [{ path: `${id}/${n}`, date: entryDate(stat.mtime) }] : [];
      }),
  );
  return files.flat();
}

/** A path's real location (through symlinks), or the path itself when there's no such file. */
function realPath(p: string): string {
  return fs.existsSync(p) ? fs.realpathSync(p) : p;
}

/** Rendered Markdown by the text's hash: an entry never changes, so it's rendered once, not at every view. */
const rendered = new Map<string, string>();
const RENDERED_MAX = 2000;

/** Renders Markdown with VS Code's own renderer (the built-in Markdown extension); plain text if it's unavailable. */
export async function renderMarkdown(text: string, webview: vscode.Webview, dir: string, roots: readonly string[] = []): Promise<string> {
  if (!text.trim()) return '';
  const key = crypto.createHash('sha1').update(text).digest('hex');
  let html = rendered.get(key);
  if (html === undefined) {
    try {
      html = await vscode.commands.executeCommand<string>('markdown.api.render', text);
      rendered.set(key, html);
      if (rendered.size > RENDERED_MAX) rendered.delete(rendered.keys().next().value!);
    } catch {
      html = `<pre>${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</pre>`;
    }
  }
  html = stripStyles(html);
  // Task list items ("- [ ] …") as checkboxes, like GitHub shows them.
  html = html.replace(/(<li\b[^>]*>)\s*\[([ xX])\]\s+/g, (_m, li: string, mark: string) => `${li}<span class="task${mark === ' ' ? '' : ' checked'}"></span>`);
  return replaceMedia(html, (src) => resolveMedia(src, webview, dir, roots));
}

/**
 * What an image or video source in a ticket shows (undefined: kept as written): a file next to the tickets loads
 * through the webview; one elsewhere in the repository (from its root: the ticket's worktrees, then the main one) or
 * anywhere on disk is embedded. Videos (MP4, WebM) get a player; a file over its kind's limit, a note (BL-79).
 */
export async function resolveMedia(src: string, webview: vscode.Webview, dir: string, roots: readonly string[] = []): Promise<Media | undefined> {
  const type = mediaType(src);
  if (/^data:/i.test(src)) return undefined;
  if (/^https?:/i.test(src) || src.startsWith('//')) return type?.kind === 'video' ? { src, kind: 'video' } : undefined;
  let rel = src;
  try {
    rel = /^file:/i.test(src) ? vscode.Uri.parse(src).fsPath : decodeURIComponent(src);
  } catch {
    // As written.
  }
  const name = path.basename(rel);
  const besideTicket = path.resolve(dir, rel);
  if (besideTicket.startsWith(dir + path.sep)) {
    const bytes = await fileSize(besideTicket);
    if (bytes !== undefined) {
      if (type && tooLarge(type.kind, bytes)) return { note: tooLargeNote(name, type.kind, bytes) };
      return { src: webview.asWebviewUri(vscode.Uri.file(besideTicket)).toString(), kind: type?.kind ?? 'image' };
    }
  }
  if (!type) return undefined;
  const candidates = path.isAbsolute(rel) ? [rel] : roots.map((r) => path.join(r, rel));
  for (const file of candidates) {
    const bytes = await fileSize(file);
    if (bytes === undefined) continue;
    // Videos play from the backlog's folder only: the view may load files from there, and they're too big to embed.
    if (type.kind === 'video') return { note: `${name} isn't next to the ticket: videos play from the ticket's folder (in ${dir}).` };
    if (tooLarge('image', bytes)) return { note: tooLargeNote(name, 'image', bytes) };
    const uri = await imageDataUri(file, type.type);
    if (uri) return { src: uri, kind: 'image' };
  }
  return undefined;
}

// A tag, its quoted attribute values may hold ">"; and an attribute in it (its name, and its value if it has one).
const TAG = /<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
const ATTRIBUTE = /(\s*)([^\s"'>/=]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/g;

/**
 * Html without its styles: no <style> elements and no style attributes. The page allows inline styles for Mermaid's
 * diagrams, drawn in the webview (BL-79); what the host renders (a stranger's GitHub issue, Jira's html) mustn't use
 * that to cover or hide the ticket.
 */
export function stripStyles(html: string): string {
  return html
    .replace(/<style\b(?:"[^"]*"|'[^']*'|[^'">])*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<\/?style\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi, '')
    .replace(TAG, (tag, name: string, attributes: string) =>
      /\bstyle\b/i.test(attributes) ? `<${name}${attributes.replace(ATTRIBUTE, (a, _s: string, attr: string) => (attr.toLowerCase() === 'style' ? '' : a))}>` : tag,
    );
}

/** A file's size; undefined if it isn't a file, or isn't there. */
/** What recordings are (BL-111), by file, size and time: they're read once. */
const recordings = new Map<string, { stamp: string; value: Recording }>();

/**
 * A recording's demo (the name the recorder noted in it) and, for a GIF, how long it plays: read from the file (a GIF
 * whole, it's at most 2 MB; a video's end, where its metadata is).
 */
async function readRecording(file: string): Promise<Recording> {
  const stat = await fs.promises.stat(file).catch(() => undefined);
  if (!stat) return {};
  const stamp = `${stat.size}:${stat.mtimeMs}`;
  const known = recordings.get(file);
  if (known?.stamp === stamp) return known.value;
  const gif = /\.gif$/i.test(file);
  const handle = await fs.promises.open(file, 'r').catch(() => undefined);
  if (!handle) return {};
  try {
    const length = gif ? Math.min(stat.size, 4 * 1024 * 1024) : Math.min(stat.size, 256 * 1024);
    const bytes = new Uint8Array(length);
    await handle.read(bytes, 0, length, stat.size - length);
    const name = recordedDemo(gif ? bytes.subarray(-1024) : bytes);
    const seconds = gif ? gifSeconds(bytes) : undefined;
    const value: Recording = { ...(name ? { name } : {}), ...(seconds ? { seconds } : {}) };
    recordings.set(file, { stamp, value });
    return value;
  } finally {
    await handle.close();
  }
}

async function fileSize(file: string): Promise<number | undefined> {
  try {
    const stat = await fs.promises.stat(file);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

/** Image files as data: URIs, while each keeps its time and size; the oldest go once they fill IMAGE_CACHE_CHARS. */
const images = new Map<string, { stamp: string; uri: string }>();
const IMAGE_CACHE_CHARS = 64 * 1024 * 1024;
let imageChars = 0;

/** An image file as a data: URI; undefined if it isn't there. */
async function imageDataUri(file: string, type: string): Promise<string | undefined> {
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return undefined;
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const known = images.get(file);
    if (known?.stamp === stamp) return known.uri;
    const uri = `data:${type};base64,${(await fs.promises.readFile(file)).toString('base64')}`;
    if (known) imageChars -= known.uri.length;
    images.delete(file);
    images.set(file, { stamp, uri });
    imageChars += uri.length;
    for (const [old, v] of images) {
      if (imageChars <= IMAGE_CACHE_CHARS) break;
      images.delete(old);
      imageChars -= v.uri.length;
    }
    return uri;
  } catch {
    return undefined;
  }
}

/** What an image in the html becomes: an image or a video from src, or a note saying why it isn't shown. */
export type Media = { src: string; kind: MediaKind } | { note: string };

const IMG = /<img\b[^>]*>/g;
const srcOf = (tag: string) => /\ssrc="([^"]*)"/.exec(tag)?.[1].replace(/&amp;/g, '&');
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const MERMAID = /^ {0,3}(`{3,}|~{3,})\s*mermaid[^\n]*\n([\s\S]*?)\n? {0,3}\1[`~]*\s*$/i;
const PICTURE = /^!\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)/;

/**
 * A report's media (parseReport's, BL-114) as thumbnails: a diagram by its code, a picture by what media says it is
 * (as written when it says nothing); one over its limit has none (its note shows in the open entry).
 */
export async function mediaThumbs(media: string[], resolve: (src: string) => Promise<Media | undefined>): Promise<MediaThumb[]> {
  const thumbs = await Promise.all(
    media.map(async (m): Promise<MediaThumb | undefined> => {
      const diagram = MERMAID.exec(m);
      if (diagram) return { kind: 'diagram', code: diagram[2] };
      const picture = PICTURE.exec(m);
      if (!picture) return undefined;
      const src = picture[2].replace(/^<|>$/g, '');
      const r = await resolve(src).catch(() => undefined);
      if (r && 'note' in r) return undefined;
      return { kind: r?.kind ?? mediaType(src)?.kind ?? 'image', src: r?.src ?? src, ...(picture[1] ? { alt: picture[1] } : {}) };
    }),
  );
  return thumbs.filter((t): t is MediaThumb => !!t);
}

/** Between a report's media and its details while their demos are paired (a comment: no html has it). */
const MEDIA_SPLIT = '<!--flotilla-media-split-->';

/** Replaces the images in html with what media says they are (undefined: kept as they are). */
export async function replaceMedia(html: string, media: (src: string) => Promise<Media | undefined>): Promise<string> {
  const found = [...new Set((html.match(IMG) ?? []).map(srcOf).filter((s): s is string => !!s))];
  const resolved = new Map(await Promise.all(found.map(async (s) => [s, await media(s).catch(() => undefined)] as const)));
  return html.replace(IMG, (tag) => {
    const src = srcOf(tag);
    const m = src === undefined ? undefined : resolved.get(src);
    if (!m) return tag;
    if ('note' in m) return `<span class="media-note"><i class="codicon codicon-file-media"></i> ${escapeHtml(m.note)}</span>`;
    if (m.kind === 'video') {
      // A player with its controls; it doesn't play until asked (so no sound at once), and loads only its first frame.
      const alt = /\salt="([^"]*)"/.exec(tag)?.[1];
      return `<video class="media" src="${escapeHtml(m.src)}" controls preload="metadata"${alt ? ` title="${alt}" aria-label="${alt}"` : ''}></video>`;
    }
    return tag.replace(/(\ssrc=")[^"]*(")/, (_m, a: string, c: string) => `${a}${escapeHtml(m.src)}${c}`);
  });
}

/** Replaces the images' sources in html (src: the new one, or undefined to keep it). */
export function replaceImages(html: string, src: (current: string) => Promise<string | undefined>): Promise<string> {
  return replaceMedia(html, async (s) => {
    const next = await src(s);
    return next ? { src: next, kind: 'image' } : undefined;
  });
}

/** Markdown (as comments and reports are written here) in a tracker's markup. */
export function inMarkup(source: IssueSource, markdown: string): string {
  return source.markup === 'jira' ? markdownToJira(markdown.trim()) : markdown.trim();
}

/** An issue as read from its tracker: its details, and what can be changed (unknown if asking failed). */
interface RemoteRead {
  details: RemoteDetails;
  edit?: RemoteEditOptions;
}

/** What a ticket's view shows of a worktree: a change to any of it is a change to the view. */
function workstreamState(w: Workstream) {
  return {
    branch: w.worktree.branch,
    attention: w.attention,
    message: w.agent?.message,
    changes: w.changes.length,
    sync: w.sync,
    chats: w.chats.map((c) => [c.id, c.state, c.message, c.title, c.firstPrompt, c.agent, c.model, c.effort, c.updatedAt]),
  };
}

/** Ticket editor tabs: one per backlog item, kept up to date with the ticket file and the item's worktree. */
export class TicketPanels implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly subscriptions: vscode.Disposable[] = [];

  reviews: ReviewLoop | undefined;
  shaping: Shaping | undefined;

  /** The review loop, for the tickets' review panel (created after the tickets). */
  useReviews(reviews: ReviewLoop): void {
    this.reviews = reviews;
    this.subscriptions.push(reviews.onDidChange((id) => this.refresh(new Set([id]))));
  }

  mainSync: MainSync | undefined;

  /** Update from Main (BL-55), for the tickets being worked on. */
  useMainSync(mainSync: MainSync): void {
    this.mainSync = mainSync;
  }

  /** The discussions with agents (BL-45), for the tickets nobody works on yet. */
  useShaping(shaping: Shaping): void {
    this.shaping = shaping;
    this.subscriptions.push(shaping.onDidChange(() => this.refreshAll()));
  }

  merger: Merger | undefined;

  /** The merges, for the tickets' Merge button and merge panel. */
  useMerger(merger: Merger): void {
    this.merger = merger;
    this.subscriptions.push(merger.onDidChange(() => this.refreshAll()));
  }

  /** The tickets' CI (BL-106), when there's a CI/CD view to read it. */
  readonly ci: TicketCi | undefined;

  constructor(readonly deps: TicketDeps) {
    this.ci = deps.ci && new TicketCi({ ci: deps.ci, showCi: (key) => deps.showCi?.(key), memento: deps.memento, mainRoot: deps.mainRoot });
    if (this.ci) this.subscriptions.push(this.ci);
    this.subscriptions.push(
      creatingWorktrees.onDidChange(() => this.refreshAll()),
      { dispose: deps.repository.onDidChange(() => void this.repositoryChanged()).dispose },
      deps.backlog.watch((changed) => void this.backlogChanged(changed)),
      deps.merges.watch(() => this.refreshAll()),
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
    this.asks.forEach((a) => a.dispose());
    this.asks.clear();
  }

  /**
   * Panels to focus their comment box in, once their view is shown (a ticket opened to answer or to request changes),
   * or to show their Demo section in (opened from a review card's demo mark, BL-135).
   */
  private readonly focusOnPost = new WeakMap<vscode.WebviewPanel, 'comment' | 'demo'>();

  async open(id: string, o: { focus?: 'comment' | 'demo' } = {}): Promise<void> {
    // An issue linked to a local item is part of it.
    id = linkedItem(await this.deps.backlog.read(), id)?.id ?? id;
    const existing = this.panels.get(id);
    if (existing) {
      existing.reveal();
      if (o.focus) void existing.webview.postMessage({ type: 'focus', target: o.focus } satisfies TicketHostMessage);
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
    if (o.focus) this.focusOnPost.set(panel, o.focus);
    const ci = this.ci?.open(id, panel);
    panel.onDidDispose(() => {
      ci?.dispose();
      this.panels.delete(id);
      // Its Ask chat ends with it: nothing of it is kept.
      this.asks.get(id)?.dispose();
      this.asks.delete(id);
    });
    panel.webview.onDidReceiveMessage((m: TicketWebviewMessage) =>
      (m.type === 'ask' || m.type === 'askStop' || m.type === 'askNew' || m.type === 'askPost'
        ? this.onAsk(id, panel, m)
        : m.type === 'ci' || m.type === 'ciOpen' || m.type === 'ciShow'
          ? // The CI goes on its own: the rest of the ticket isn't sent again for it.
            (this.ci?.handle(id, m) ?? Promise.resolve())
          : this.onMessage(id, panel, m)
      ).catch(
        (e: unknown) => void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e)),
      ),
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
        [...items]
          .sort((a, b) => order(a) - order(b))
          .map((i) => ({ label: i.id, description: i.title, detail: i.status === 'review' ? 'In review' : undefined })),
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
          {
            label: '$(request-changes) Request Changes',
            verdict: 'changes' as const,
            detail: 'An agent picks them up, and asks you first if it needs more context',
          },
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

  /**
   * Pauses, stops or resumes an agent on a ticket (session: that chat's; else the one working on it): its discussion's
   * agent (see Shaping), or one of the review loop's or started by hand (see ReviewLoop.control).
   */
  async controlAgent(id: string, action: 'pause' | 'stop' | 'resume', session?: string): Promise<void> {
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    const shaping = item?.shaping;
    const discussing =
      !!shaping && !!this.shaping && (session ? session === shaping.session : action === 'resume' ? !!shaping.held && !heldBy(item.review) : this.shaping.isRunning(id));
    if (discussing) return this.shaping!.control(id, action);
    await this.reviews?.control(id, action, session);
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
  remoteDetails(id: string, fresh = false): Promise<RemoteRead> {
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
  private async localEntries(item: BacklogItem, entries: TicketEntry[], webview: vscode.Webview, attachments: readonly AttachmentView[] = []): Promise<TicketView['activity']> {
    // A demo's recording and its block show as one unit (BL-111).
    const demos = new Map(attachments.filter((a) => a.demo).map((a): [string, Recording] => [a.src, { ...(a.recorded ? { name: a.recorded } : {}), ...(a.seconds ? { seconds: a.seconds } : {}) }]));
    const units = (html: string) => withDemoUnits(html, (src) => demos.get(src));
    const posted = await this.deps.backlog.posted();
    const agents = new Map(this.agentChats(item, entries).map((c) => [c.agent.toLowerCase(), c]));
    const threads = entryThreads(entries);
    return Promise.all(
      entries.map(async (whole, n) => {
        const key = Store.entryKey(item.id, whole);
        // A reply shows whom it answers above it, not its reply line (BL-126).
        const thread = threads[n];
        const e = thread.reply ? { ...whole, body: parseReply(whole.body)?.text ?? whole.body } : whole;
        const opened = e.author === 'Flotilla' ? /chat for agent ([A-Za-z0-9-]+)/.exec(e.body)?.[1] : undefined;
        const agent = opened ?? entryAgent(e.author);
        const found = agent ? agents.get(agent.toLowerCase()) : undefined;
        const at = new Date(e.date.replace(' ', 'T')).getTime();
        // An agent opened in the last hours whose chat isn't there yet: its first message waits to be sent.
        const chat: AgentChatView | undefined =
          found ?? (opened && Date.now() - at < 12 * 3_600_000 ? { pending: true, agent: opened, headless: /^Review round/.test(e.body) } : undefined);
        const report = entryAgent(e.author) ? await this.reportView(item, e.body, entries.slice(n + 1), webview, key, units) : undefined;
        const html = report ? '' : await renderMarkdown(e.body, webview, this.deps.backlog.dir, this.roots(item));
        // Any entry's media (a report's, a comment's) show beside its line when it's folded (BL-114).
        const media = takeMedia(e.body).media;
        const thumbs = media.length ? await mediaThumbs(media, (src) => resolveMedia(src, webview, this.deps.backlog.dir, this.roots(item))) : [];
        return {
          ...e,
          html: !report && isReport(e.author) ? units(withRunButtons(html, parseRunBlocks(e.body), key)) : html,
          key,
          anchor: thread.anchor,
          ...(thread.reply ? { reply: thread.reply } : {}),
          ...(thread.root !== undefined ? { root: thread.root } : {}),
          ...(posted[key] ? { posted: posted[key] } : {}),
          ...(chat ? { chat } : {}),
          ...(report ? { report } : {}),
          ...(thumbs.length ? { thumbs } : {}),
        };
      }),
    );
  }

  /** An agent's report split for the ticket (its summary, what it needs, its details); undefined for an older report. */
  private async reportView(
    item: BacklogItem,
    body: string,
    later: TicketEntry[],
    webview: vscode.Webview,
    key: string,
    units: (html: string) => string = (h) => h,
  ): Promise<ReportView | undefined> {
    const parts = parseReport(body);
    if (parts.summary === undefined) return undefined;
    const roots = this.roots(item);
    const answer = reportAnswer(later);
    // Run blocks keep their Run buttons, numbered through the entry: the summary's first, then the details'.
    const details = withRunButtons(await renderMarkdown(parts.details, webview, this.deps.backlog.dir, roots), parseRunBlocks(parts.details), key, parseRunBlocks(parts.summary).length);
    // Its pictures, videos and diagrams lead the details (BL-114). A recording goes with its demo block in the details
    // (BL-111): they're paired as one, which shows with the media.
    const media = parts.media.length ? await renderMarkdown(parts.media.join('\n\n'), webview, this.deps.backlog.dir, roots) : '';
    const [ledBy, rest] = units(`${media}${MEDIA_SPLIT}${details}`).split(MEDIA_SPLIT);
    return {
      summary: units(withRunButtons(await renderMarkdown(parts.summary, webview, this.deps.backlog.dir, roots), parseRunBlocks(parts.summary), key)),
      details: rest.trim(),
      ...(ledBy.trim() ? { media: ledBy.trim() } : {}),
      asks: parts.asks,
      ...(parts.asks && parts.needs ? { needs: await renderMarkdown(parts.needs, webview, this.deps.backlog.dir, roots) } : {}),
      questions: parts.questions,
      ...(answer !== undefined ? { answer } : {}),
    };
  }

  /** The chats of agents started for an item (their first message names it), in its worktrees, oldest first. */
  /**
   * The chats of agents that worked on an item, oldest first: those started for it (their first message names it),
   * and any chat (in any worktree) whose agent signed one of its entries or that an entry says was opened for it.
   */
  agentChats(item: BacklogItem, entries: TicketEntry[]): Array<Exclude<AgentChatView, { pending: true }>> {
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
          // A quiet chat whose process runs in this window is still working: its record and transcript just wait.
          const alive = isRunningHeadless(c.id) || isRunningInTerminal(c.id);
          const stalled = c.stalled && !alive ? c.stalled : undefined;
          return [
            {
              key: ws.key,
              id: c.id,
              agent,
              title: agentChatItem(c.title) ? item.title : c.title,
              state: c.stalled && alive ? ('working' as const) : c.state,
              ...(stalled ? { stalled: stalled.toISOString() } : {}),
              message: c.message,
              branch: workstreamLabel(ws),
              started: (c.startedAt ?? c.updatedAt).toISOString(),
              updated: c.updatedAt.toISOString(),
              ...((c.model ?? startedWith.get(agent.toLowerCase())?.model) ? { model: c.model ?? startedWith.get(agent.toLowerCase())?.model } : {}),
              ...((c.effort ?? startedWith.get(agent.toLowerCase())?.effort) ? { effort: c.effort ?? startedWith.get(agent.toLowerCase())?.effort } : {}),
              ...(c.usage?.turns ? { tokens: { label: formatTokens(c.usage.reRead), tip: usageTip(c.usage), reRead: c.usage.reRead } } : {}),
            },
          ];
        }),
      )
      .sort((a, b) => a.started.localeCompare(b.started));
  }

  /** Where a ticket's images and links are looked for: its worktrees, then the main one. */
  roots(item: BacklogItem): string[] {
    return [...this.worktreesOf(item).flatMap((w) => (w.worktree.path ? [w.worktree.path] : [])), this.deps.mainRoot];
  }

  /** Images in a tracker's HTML that need its login (Jira's attachments), fetched with it and embedded; cached. */
  private readonly trackerImageCache = new Map<string, Promise<string | undefined>>();

  private async trackerImages(issue: string, tracker: string): Promise<string> {
    const html = stripStyles(tracker);
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

  /**
   * A ticket's attachments (BL-110), each resolved as the ticket's inline media are; one that shows nothing there (not
   * found, or over its limit) isn't listed.
   */
  private async attachments(item: BacklogItem, description: string, entries: TicketEntry[], webview: vscode.Webview): Promise<AttachmentView[]> {
    const dir = this.deps.backlog.dir;
    const roots = this.roots(item);
    const found = gatherAttachments(description, entries, await folderFiles(dir, item.id));
    const views = await Promise.all(
      found.map(async ({ src, entry, ...a }): Promise<AttachmentView | undefined> => {
        const entryKey = entry !== undefined ? { entryKey: Store.entryKey(item.id, entries[entry]) } : {};
        // A diagram (BL-136) is drawn from its code: there's nothing to load.
        if (a.kind === 'diagram') return { ...a, src, ...entryKey };
        // An image on the web loads as it is (the page allows https images); a video the same.
        const media = /^https?:|^\/\//i.test(src) ? { src, kind: a.kind } : await resolveMedia(src, webview, dir, roots).catch(() => undefined);
        if (!media || 'note' in media) return undefined;
        const file = path.resolve(dir, src);
        const r = a.demo && file.startsWith(dir + path.sep) ? await readRecording(file) : {};
        return {
          ...a,
          src: media.src,
          kind: media.kind,
          ...entryKey,
          ...(r.name ? { recorded: r.name } : {}),
          ...(r.seconds ? { seconds: r.seconds } : {}),
        };
      }),
    );
    return views.filter((v): v is AttachmentView => !!v);
  }

  /** An issue's description and comments from its tracker, with the local activity (agents' reports) merged in. */
  private async remoteView(
    item: BacklogItem & { remote: RemoteIssue },
    webview: vscode.Webview,
  ): Promise<Pick<TicketView, 'description' | 'descriptionHtml' | 'activity' | 'attachments' | 'error'> & { edit?: RemoteEditOptions; priorityName?: string }> {
    const dir = this.deps.backlog.dir;
    const local = (await this.deps.backlog.readTicket(item)).activity;
    // Entries posted to the issue show as its comments.
    // What the agents' reports show, and the ticket's folder; the tracker's own attachments stay in the tracker.
    const attachments = await this.attachments(item, '', local, webview);
    const localEntries = (await this.localEntries(item, local, webview, attachments)).filter((e) => !e.posted);
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
        descriptionHtml:
          d.format === 'html' ? await this.trackerImages(item.id, d.description) : await renderMarkdown(d.description, webview, dir, this.roots(item)),
        activity: [...remoteEntries, ...localEntries].sort((a, b) => a.date.localeCompare(b.date)),
        attachments,
        edit,
        priorityName: d.issue.priorityName,
      };
    } catch (error) {
      return { description: '', descriptionHtml: '', activity: localEntries, attachments, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private refreshAll(): void {
    for (const [id, panel] of this.panels) void this.post(id, panel);
  }

  /** Refreshes the open tickets with these ids; the others keep their view. */
  private refresh(ids: ReadonlySet<string>): void {
    for (const [id, panel] of this.panels) if (ids.has(id)) void this.post(id, panel);
  }

  /** Each item as last seen in backlog.json (JSON): what changed in it is found by comparing. */
  private itemSigs = new Map<string, string>();

  /**
   * The backlog folder changed: the tickets whose file changed, and whose item in backlog.json did (and its parent and
   * parts, whose lists show it). Other open tickets keep their view.
   */
  private async backlogChanged(files: ReadonlySet<string>): Promise<void> {
    const data = await this.deps.backlog.read();
    const sigs = new Map(data.items.map((i) => [i.id, JSON.stringify(i)]));
    const changed = new Set<string>();
    for (const [id, sig] of sigs) if (this.itemSigs.get(id) !== sig) changed.add(id);
    for (const id of this.itemSigs.keys()) if (!sigs.has(id)) changed.add(id);
    this.itemSigs = sigs;
    const ids = ticketsForBacklogChange({ items: data.items, changed, files });
    if (ids === 'all') return this.refreshAll();
    this.refresh(ids);
  }

  /** Each worktree as last seen (its branch, state, chats), to tell what changed. */
  private workstreamSigs = new Map<string, string>();

  /**
   * The worktrees or the refs changed: the tickets whose worktrees or agents changed, those a changed chat was started
   * for, and, when a ref moved, those whose branch moved or that a new commit mentions. Other tickets keep their view.
   */
  private async repositoryChanged(): Promise<void> {
    const current = this.deps.repository.current;
    const sigs = new Map(current.map((w) => [w.key, JSON.stringify(workstreamState(w))]));
    const changed = new Set<string>();
    for (const [key, sig] of sigs) if (this.workstreamSigs.get(key) !== sig) changed.add(key);
    for (const key of this.workstreamSigs.keys()) if (!sigs.has(key)) changed.add(key);
    this.workstreamSigs = sigs;
    if (!this.panels.size) return;
    const moves = await movesSince(this.deps.mainRoot);
    if (!changed.size && !moves) return;
    const data = await this.deps.backlog.read();
    const chatStarts = current
      .filter((w) => changed.has(w.key))
      .flatMap((w) => w.chats.flatMap((c) => agentChatItem(c.firstPrompt)?.item ?? []));
    const open: OpenTicket[] = [...this.panels].map(([id, panel]) => {
      const item = data.items.find((i) => i.id === id);
      return {
        id,
        ids: [id, ...(item?.links ?? []).map((l) => l.id)],
        keys: new Set([...(item ? this.worktreesOf(item).map((w) => w.key) : []), ...(this.shown.get(panel) ?? [])]),
        branches: (branch: string) => !!item && branchMatches(item, branch),
      };
    });
    this.refresh(ticketsForRepositoryChange({ open, changedKeys: changed, chatStarts, moves }));
  }

  /** The worktrees and agents' keys a ticket's view showed, per panel: a change to one of them refreshes it. */
  private readonly shown = new WeakMap<vscode.WebviewPanel, Set<string>>();

  /** The latest post per panel: an older one that finishes later (a slow tracker) is dropped. */
  private readonly posts = new WeakMap<vscode.WebviewPanel, number>();

  /** The view each panel shows (as last sent): a change sends only the parts that differ from it. */
  readonly sentViews = new WeakMap<vscode.WebviewPanel, TicketView>();

  /** The posts running per panel. A post superseded by a newer one sends nothing: the newer one carries its change. */
  private readonly running = new WeakMap<vscode.WebviewPanel, Set<Promise<void>>>();

  /** Sends a ticket's view (see postView), and keeps it in `running` until it's done. */
  private post(id: string, panel: vscode.WebviewPanel): Promise<void> {
    const run = this.postView(id, panel);
    const set = this.running.get(panel) ?? new Set<Promise<void>>();
    this.running.set(panel, set);
    set.add(run);
    return run.finally(() => set.delete(run));
  }

  /**
   * Waits until no post of the panel is running. Once one has finished, the view with everything written before it has
   * been sent: the newest post is the one that sends it, and a post that was superseded has its newer one in `running`.
   */
  private async settled(panel: vscode.WebviewPanel): Promise<void> {
    for (let set = this.running.get(panel); set?.size; set = this.running.get(panel)) await Promise.allSettled([...set]);
  }

  /** Sends a ticket's view; never leaves the tab waiting: a failure shows in it. */
  private async postView(id: string, panel: vscode.WebviewPanel): Promise<void> {
    const seq = (this.posts.get(panel) ?? 0) + 1;
    this.posts.set(panel, seq);
    let shown: BacklogItem | undefined;
    const send = (view: Omit<TicketView, 'agents' | 'showActivity'>) => {
      if (this.posts.get(panel) !== seq) return;
      const chats = shown ? this.agentChats(shown, view.activity) : [];
      // Each agent with the reports it signed, where it runs if it's busy, and whether the user paused or stopped it.
      const r = shown?.review;
      const held = heldBy(r);
      const own = r?.state === 'reviewing' ? r.reviewerSession : r?.state === 'working' || r?.state === 'revising' ? r.implementerSession : undefined;
      const agents = chats.map((c) => {
        const halted =
          held?.session === c.id
            ? r?.state === 'paused'
              ? ('paused' as const)
              : ('stopped' as const)
            : shown?.shaping?.held && shown.shaping.session === c.id
              ? shown.shaping.held.kind
              : undefined;
        const busy = !halted && (isRunningInTerminal(c.id) || ((c.state === 'working' || c.state === 'waiting-for-input') && !this.reviews?.hasEnded(c.id)));
        const runs = !busy
          ? undefined
          : isRunningInTerminal(c.id) || startedInTerminal(view.activity, c.agent)
            ? ('terminal' as const)
            : isRunningHeadless(c.id) || own === c.id
              ? ('headless' as const)
              : ('panel' as const);
        return {
          ...c,
          reports: view.activity.filter((e) => sameAgent(entryAgent(e.author), c.agent)).length,
          ...(runs ? { runs } : {}),
          ...(halted ? { held: halted } : {}),
        };
      });
      this.shown.set(panel, new Set([...view.worktrees.map((w) => w.key), ...agents.map((a) => a.key)]));
      this.ci?.setWorktrees(id, view.worktrees.map((w) => ({ key: w.key, branch: w.branch })));
      const showActivity = showActivityKept(this.deps.memento);
      const next: TicketView = { ...view, agents, showActivity, attachmentsFolded: attachmentsFolded(this.deps.memento, view.item.id) };
      const update = ticketUpdate(this.sentViews.get(panel), next);
      if (update) {
        this.sentViews.set(panel, next);
        void panel.webview.postMessage(update);
      }
      const focus = this.focusOnPost.get(panel);
      if (focus && this.focusOnPost.delete(panel)) void panel.webview.postMessage({ type: 'focus', target: focus } satisfies TicketHostMessage);
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
      base = { ...this.baseView(plain, remote), ...(await this.work(plain)), ...(await this.family(plain)), ...(await this.mergeInfo(plain)) };
      shown = plain;
      if (remote) {
        // What the backlog knows shows at once; the description and comments follow from the tracker.
        if (!this.details.get(id)?.settled) send({ ...base, loading: true });
        const { edit, priorityName, ...content } = await this.remoteView({ ...plain, remote }, panel.webview);
        send({ ...base, ...content, remote: base.remote && { ...base.remote, edit, priorityName: priorityName ?? base.remote.priorityName } });
      } else {
        const ticket = await this.deps.backlog.readTicketCached(item);
        const attachments = await this.attachments(item, ticket.description, ticket.activity, panel.webview);
        send({
          ...base,
          description: ticket.description,
          descriptionHtml: await renderMarkdown(ticket.description, panel.webview, dir, this.roots(plain)),
          activity: await this.localEntries(item, ticket.activity, panel.webview, attachments),
          attachments,
          run: latestRun(ticket.activity, (e) => Store.entryKey(plain.id, e)),
          ...(await this.mainView(plain, ticket.description)),
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
          canMerge: false,
          canDiscuss: false,
          dependsOn: [],
        }),
        error: message,
      });
    }
  }

  /** What it depends on (BL-55), and whether main can be merged into its branch from here. */
  private async mainView(item: BacklogItem, description: string): Promise<Pick<TicketView, 'dependsOn' | 'updateFromMain'>> {
    const data = await this.deps.backlog.read();
    const dependsOn = dependsOnIds(description, item.id).flatMap((id) => {
      const dep = data.items.find((i) => i.id.toUpperCase() === id);
      return dep ? [{ id: dep.id, title: dep.title, status: dep.status }] : [];
    });
    const base = this.mainSync && isOpen(item) && this.worktreesOf(item).length ? await this.mainSync.base() : undefined;
    return { dependsOn, ...(base ? { updateFromMain: { base: baseLabel(base) } } : {}) };
  }

  /** A ticket's view without its description and activity. */
  private baseView(plain: BacklogItem, remote: RemoteIssue | undefined): Omit<TicketView, 'agents' | 'showActivity'> {
    const queued = this.reviews?.queuedFor(plain.id);
    const mergeProgress = this.merger?.mergeProgress(plain.id);
    const mergeQueue = readyToMerge(plain) ? this.merger?.queuePlace(plain.id) : undefined;
    const mergeStop = this.merger?.ciStop(plain.id, (branch) => {
      const ws = this.worktreesOf(plain).find((w) => w.worktree.branch === branch);
      return ws && (ws.sync.head ?? ws.worktree.head);
    });
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
      remote: remote &&
        source && { kind: source.config.kind, label: source.label, url: remote.url, statusName: remote.statusName, priorityName: remote.priorityName },
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
      ...(modelLevels().light ? { lightModel: modelLevels().light } : {}),
      children: [],
      ...(plain.review ? { review: { ...plain.review, running: !!this.reviews?.isRunning(plain.id) } } : {}),
      ...(queued ? { queued } : {}),
      canReview: !remote && !!this.reviews && this.worktreesOf(plain).length > 0,
      canMerge: !remote && !!this.merger && readyToMerge(plain),
      ...(mergeProgress ? { mergeProgress } : {}),
      ...(mergeStop ? { mergeStop } : {}),
      ...(mergeQueue ? { mergeQueue } : {}),
      ...(plain.merging ? { merging: { ...plain.merging, running: !!this.merger?.isRunning(plain.id) } } : {}),
      ...(creatingWorktrees.has(plain.id) ? { creating: true } : {}),
      canDiscuss: !remote && !!this.shaping && discussable(plain),
      dependsOn: [],
      ...(this.shaping && !remote && discussable(plain) && plain.shaping
        ? { shaping: { agent: plain.shaping.agent, running: this.shaping.isRunning(plain.id), ready: !!plain.shaping.ready, ...(plain.shaping.held ? { held: plain.shaping.held.kind } : {}) } }
        : {}),
    };
  }

  /** The branch an item merges into (once it can be merged); once merged, what that has that its upstream doesn't. */
  private async mergeInfo(item: BacklogItem): Promise<Pick<TicketView, 'unpushed' | 'mergeInto'>> {
    if (!this.merger) return {};
    if (readyToMerge(item)) {
      const into = await this.merger.baseBranch().catch(() => undefined);
      return into ? { mergeInto: into } : {};
    }
    if (!item.merged) return {};
    const u = await this.merger.unpushed(item.merged.into).catch(() => undefined);
    return u?.count ? { unpushed: { base: item.merged.into, ...u } } : {};
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
  async work(item: BacklogItem & { remote?: RemoteIssue }): Promise<Pick<TicketView, 'branches' | 'commits' | 'rewrite' | 'history' | 'canCleanUp' | 'merge'>> {
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
            (c) => ({
              ...item.rewrite!,
              ...c,
              changes: this.deps.repository.current.find((w) => w.worktree.branch === item.rewrite!.clean)?.changes.length ?? 0,
            }),
            () => ({ ...item.rewrite!, differs: ['(a branch is missing)'], commits: 0, cleanCommits: 0, changes: 0 }),
          ),
      ]);
      // A local item's branch with commits of its own (not a clean-up's) can have its history cleaned up.
      const canCleanUp = !item.remote && !item.rewrite && !!base && commits.some((c) => c.branches.some((b) => b !== base && !/-clean(-\d+)?$/.test(b)));
      const merge = this.deps.merges.get(item.id);
      return { branches: branches.filter((b) => !checkedOut.has(b) && b !== base), commits, history, canCleanUp, ...(rewrite ? { rewrite } : {}), ...(merge ? { merge } : {}) };
    } catch {
      return { branches: [], commits: [], history: [], canCleanUp: false };
    }
  }

  /**
   * Opens a link from a description or an entry: a web page in the browser, or a file at its lines. A file's path is
   * from the repository root (in the ticket's worktrees first, then the main one: after a merge it's there) or next to
   * the ticket (its pictures); "path#L10-L20" and "path:10" select lines.
   */
  async openHref(item: BacklogItem, href: string): Promise<void> {
    if (/^(https?|mailto):/i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return;
    const link = parseFileLink(/^file:/i.test(href) ? vscode.Uri.parse(href).fsPath + (href.includes('#') ? href.slice(href.indexOf('#')) : '') : href);
    const roots = [...this.worktreesOf(item).flatMap((w) => (w.worktree.path ? [w.worktree.path] : [])), this.deps.mainRoot, this.deps.backlog.dir];
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
  async changeTicket(item: BacklogItem, change: (t: Ticket) => Ticket): Promise<void> {
    await this.deps.backlog.editTicket(item, change);
  }

  /**
   * A Done item's work that isn't merged: a sibling ticket (same parent) to merge the branch, asking which branch when
   * there are several. The new ticket opens.
   */
  async mergeSibling(item: BacklogItem, branch?: string): Promise<void> {
    const merge = this.deps.merges.get(item.id);
    const unmerged = merge?.branches.filter((b) => b.state === 'unmerged') ?? [];
    let pick: string | undefined = branch ?? unmerged[0]?.branch;
    if (!branch && unmerged.length > 1) {
      pick = (
        await vscode.window.showQuickPick(
          unmerged.map((b) => ({ label: b.branch, description: `${b.commits} ${b.commits === 1 ? 'commit' : 'commits'}`, branch: b.branch })),
          { title: `Merge which branch of ${item.id}?` },
        )
      )?.branch;
    }
    if (!pick) return;
    const into = merge ? baseName(merge.base) : 'the base branch';
    const commits = unmerged.find((b) => b.branch === pick)?.commits ?? 0;
    const title = `Merge ${pick} into ${into}`;
    const description = `Merge the work of ${item.id} (“${item.title}”): branch \`${pick}\` has ${commits} ${commits === 1 ? 'commit' : 'commits'} that ${into} doesn't have yet.\n\n- [ ] \`${pick}\` is in ${into}, or its work is dropped (and ${item.id} says so).`;
    let added: string | undefined;
    await this.deps.backlog.change((d) => {
      const r = addItem(d, title, currentPrefix(d, vscode.workspace.getConfiguration('flotilla').get<string>('backlog.idPrefix', 'BL')), new Date());
      added = r.item.id;
      return { ...r.data, items: r.data.items.map((i) => (i.id === added && item.parent ? { ...i, parent: item.parent } : i)) };
    });
    if (!added) return;
    await this.deps.backlog.writeTicket(added, { title, description, activity: [] });
    await this.deps.backlog.appendActivity(item, { date: entryDate(new Date()), author: 'You', body: `Asked for ${added} to merge \`${pick}\`.` });
    await this.open(added);
  }

  /** Done with unmerged work, and it's superseded: which ticket has the work instead. The warning goes. */
  async dismissUnmerged(item: BacklogItem): Promise<void> {
    const data = await this.deps.backlog.read();
    const by = (
      await vscode.window.showInputBox({
        title: `Dismiss the unmerged work of ${item.id}`,
        prompt: 'Which ticket has this work instead (it supersedes it)?',
        placeHolder: 'BL-12',
        ignoreFocusOut: true,
        validateInput: (value) => {
          const t = value.trim().toLowerCase();
          if (!t) return 'Give the id of the ticket that supersedes it.';
          if (t === item.id.toLowerCase()) return "A ticket can't supersede itself.";
          return data.items.some((i) => i.id.toLowerCase() === t) ? undefined : `There's no ticket ${value.trim()} in the backlog.`;
        },
      })
    )?.trim();
    if (!by) return;
    const superseding = data.items.find((i) => i.id.toLowerCase() === by.toLowerCase())!.id;
    await this.deps.backlog.change((d) => ({ ...d, items: d.items.map((i) => (i.id === item.id ? { ...i, supersededBy: superseding } : i)) }));
    await this.deps.backlog.appendActivity(item, { date: entryDate(new Date()), author: 'You', body: `Dismissed its unmerged work: ${superseding} supersedes it.` });
  }

  /** Adds an entry to a ticket's (local) activity: comments, and notes from Flotilla (an agent started). */
  /** A reply's text, with the line that names the entry it answers first (BL-126); as it is when that entry is gone. */
  async withReplyLine(item: BacklogItem, text: string, replyTo: string | undefined): Promise<string> {
    if (!replyTo) return text;
    const activity = (await this.deps.backlog.readTicket(item)).activity;
    const parent = activity[entryAnchors(activity).indexOf(replyTo)];
    return parent ? `${replyLine(parent, replyTo)}\n${text.trim()}` : text;
  }

  async addActivity(id: string, author: string, body: string): Promise<void> {
    const item = await this.item(id);
    if (!item) return;
    await this.deps.backlog.appendActivity(item, { date: entryDate(new Date()), author, body: body.trim() });
  }

  /**
   * Runs a run block of a ticket's reports (BL-24, BL-20; the command flotilla.runBacklogItem): the one `ref` names, or
   * the ticket's run (its last block). It runs in the ticket's worktree: shell commands one after the other in that
   * worktree's terminal, `launch` and `task` by name, and `open` a web link or a file of the worktree. The first time
   * (and whenever the block or its worktree changed) it asks, showing what runs. The block is read from the ticket when
   * it runs: one that's gone (its entry was edited) isn't run. A demo block with `try` only sets the demo's window up
   * (Try it yourself, BL-135).
   */
  async run(id: string, ref?: { key: string; index: number; try?: boolean }): Promise<void> {
    const item = await this.item(id);
    if (!item || item.remote) return;
    const ticket = await this.deps.backlog.readTicket(item);
    const picked = pickRunBlock(
      placedRunBlocks(ticket.activity, (e) => Store.entryKey(id, e)),
      ref,
    );
    if (!picked) {
      void vscode.window.showWarningMessage(
        ref
          ? `That run block of ${id} isn't in the ticket any more: its report changed. Use the ticket's Run button.`
          : `${id} has no run block: its agent didn't give one. Ask it for one, in a comment.`,
      );
      return;
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('Run blocks run only in a trusted workspace.');
      return;
    }
    const { kind, title, lines } = picked.block;
    if (kind === 'shell' && !lines.length) {
      void vscode.window.showWarningMessage(`The run block "${title ?? id}" has no commands.`);
      return;
    }
    // A demo (its name, then maybe a title) plays in the worktree's terminal, with the repository's player (BL-78).
    const demo = kind === 'demo' ? demoRun(picked.block, ref?.try ? 'try' : 'play') : undefined;
    if (kind === 'demo' && !demo) {
      void vscode.window.showWarningMessage(`${id}'s demo block doesn't name a demo: write its name after \`demo\` (letters, digits, - and _).`);
      return;
    }
    const commands = demo ? demo.commands : lines;
    const place = await this.runPlace(id, item, demo?.file);
    if (!place) return;
    if (demo && !fs.existsSync(path.join(place.dir, demo.file))) {
      void vscode.window.showWarningMessage(`${demo.file} isn't in ${place.dir}.`);
      return;
    }
    // What an open block opens is checked before anyone is asked: a refused one doesn't get a dialog.
    const target = lines[0] ?? title ?? '';
    const opened = kind === 'open' ? openTarget(target, place.dir, realPath) : undefined;
    if (opened && 'refused' in opened) {
      void vscode.window.showWarningMessage(`${id}'s open block: ${opened.refused}.`);
      return;
    }
    if (opened && 'file' in opened && !fs.existsSync(opened.file)) {
      void vscode.window.showWarningMessage(`${target} isn't in ${place.dir}.`);
      return;
    }
    // A launch or task needs its worktree in this window (added, or opened in a window of its own), and a name it has.
    let folder: vscode.WorkspaceFolder | undefined;
    if (kind === 'launch' || kind === 'task') {
      folder = await folderFor(place.dir, this.deps.reference, place.label);
      if (!folder) return;
      const missing = await missingName(kind, folder, title);
      if (missing) {
        void vscode.window.showWarningMessage(missing);
        return;
      }
    }
    const fingerprint = runFingerprint(id, place.dir, picked.block);
    const approved = this.deps.approvals.has(fingerprint);
    if (!approved) {
      const inTerminal = kind === 'shell' || kind === 'demo';
      const what = inTerminal ? commands.join('\n') : kind === 'open' ? target : `${kind === 'launch' ? 'Launch configuration' : 'Task'} "${title ?? ''}"`;
      const shown = inTerminal ? `In ${place.dir}:\n\n${what}` : `${what}\n\nIn ${place.dir}`;
      const answer = await vscode.window.showWarningMessage(`Run ${title ?? kind} for ${id}?`, { modal: true, detail: shown }, 'Run');
      if (answer !== 'Run') return;
    }
    if (kind === 'shell' || kind === 'demo') {
      const terminal = await this.deps.terminals.forRun(id, place.dir);
      if (!terminal) return;
      terminal.show();
      for (const line of commands) terminal.sendText(line);
    } else if (folder && kind === 'launch') {
      await startLaunch(folder, title ?? '');
    } else if (folder && kind === 'task') {
      await startTask(folder, title ?? '');
    } else if (opened && 'url' in opened) {
      await vscode.env.openExternal(vscode.Uri.parse(opened.url));
    } else if (opened && 'file' in opened) {
      await vscode.commands.executeCommand('vscode.open', toWorkspaceUri(this.deps.reference, opened.file), { preview: false });
    }
    // Approved once the run goes ahead: a declined "Stop and Run" leaves the block unapproved.
    if (!approved) await this.deps.approvals.add(fingerprint);
    const verb = kind === 'open' ? 'opened' : kind === 'launch' ? 'started' : kind === 'demo' ? (ref?.try ? 'tried' : 'played') : 'ran';
    const ran = demo ? `the demo "${demo.name}"` : title ? `"${title}"` : `the ${kind} block`;
    await this.addActivity(id, 'Flotilla', `You ${verb} ${ran} in \`${place.label}\`.`);
  }

  /**
   * The worktree a run block runs in: the ticket's worktree here (a pick when there are several). With none here, says
   * why: its worktree isn't reachable from this window, or a branch's worktree is gone (then it offers to create one).
   * Undefined when there's nothing to run in.
   */
  private async runPlace(id: string, item: BacklogItem, demo?: string): Promise<RunPlace | undefined> {
    const worktrees = this.worktreesOf(item).map((w) => ({ branch: w.worktree.branch, path: w.worktree.path, adminDir: w.worktree.adminDir }));
    const found = runPlaces(itemBranches(item), worktrees);
    // A demo of a ticket that's merged and cleaned up runs from main, when it's there (BL-111).
    const main = demo ? demoPlace(found, demo, fs.existsSync(path.join(this.deps.mainRoot, demo)), { label: 'main', dir: this.deps.mainRoot }) : undefined;
    if (main && 'why' in main) {
      void vscode.window.showWarningMessage(`${id}'s demo can't run: ${main.why}.`);
      return undefined;
    }
    if (main) return main;
    if (found.reachable.length === 1) return found.reachable[0];
    if (found.reachable.length > 1) {
      const picked = await vscode.window.showQuickPick(
        found.reachable.map((p) => ({ label: p.label, description: p.dir, place: p })),
        { title: `Run ${id} in Which Worktree?` },
      );
      return picked?.place;
    }
    if (found.unreachable.length) {
      void vscode.window.showWarningMessage(
        `${id}'s worktree (${found.unreachable.join(', ')}) isn't reachable from this window: it's in another environment, so run the block there.`,
      );
      return undefined;
    }
    const branch = found.missing[0];
    if (branch) {
      const answer = await vscode.window.showWarningMessage(`${id}'s worktree for ${branch} is gone. Create one to run the block in?`, 'Create Worktree');
      if (answer === 'Create Worktree') await vscode.commands.executeCommand('flotilla.startBacklogItem', id, { agent: false, branch });
      return undefined;
    }
    void vscode.window.showWarningMessage(`${id} has no worktree to run it in: start it first.`);
    return undefined;
  }

  /**
   * Handles a message of the tab, then posts the view (what it changed shows) and says it's done: the webview's
   * "working…" for an action ends here, whether it posted, failed or returned early.
   */
  private async onMessage(id: string, panel: vscode.WebviewPanel, m: TicketWebviewMessage): Promise<void> {
    let failed = false;
    try {
      await this.handle(id, panel, m);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // A tab closed meanwhile has nothing to show.
      if (this.panels.get(id) === panel) {
        await this.post(id, panel);
        // Done only once the view has the action's change: a post still running (the backlog watcher's) may carry it.
        await this.settled(panel);
        if (m.type !== 'ready') void panel.webview.postMessage({ type: 'done', message: m, failed } satisfies TicketHostMessage);
      }
    }
  }

  private async handle(id: string, panel: vscode.WebviewPanel, m: TicketWebviewMessage): Promise<void> {
    const item = await this.item(id);
    if (!item) return;
    await handleMessage({ id, panel, item, backlog: this.deps.backlog, panels: this }, m);
  }

  /** The Ask chats of the open tickets (BL-80): in memory only, one per tab. */
  readonly asks = new Map<string, AskChat>();
  private readonly askTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * The Ask chat's messages: they change nothing in the ticket, so they don't post its view. A question returns once
   * it's sent (or has waited for memory); its answer streams in as it's written.
   */
  private async onAsk(id: string, panel: vscode.WebviewPanel, m: Extract<TicketWebviewMessage, { type: 'ask' | 'askStop' | 'askNew' | 'askPost' }>): Promise<void> {
    if (m.type === 'askNew') return this.asks.get(id)?.reset();
    if (m.type === 'askStop') return this.asks.get(id)?.stop();
    if (m.type === 'askPost') {
      const chat = this.asks.get(id);
      const turn = chat?.answered(m.index);
      if (!chat || !turn || turn.posted) return;
      await this.addActivity(id, 'You', postedAnswer(turn.question, turn.answer, askModel()));
      chat.markPosted(turn);
      return;
    }
    let chat = this.asks.get(id);
    if (!chat) {
      const created: AskChat = new AskChat({
        model: askModel(),
        memoryShort: () => {
          const short = memoryShortage();
          return short && `Waiting for memory: ${formatMemory(short.freeMB)} free, and flotilla.agents.minFreeMemoryMB asks for ${formatMemory(short.minMB)}…`;
        },
        context: () => this.askContext(id, panel),
        spawn: (cwd) => spawnAsk(cwd, { instructions: askInstructions({ id, title: this.sentViews.get(panel)?.item.title ?? id }), output: this.output() }),
        render: (markdown) => renderMarkdown(markdown, panel.webview, this.deps.backlog.dir, this.roots(this.sentViews.get(panel)?.item ?? { id, title: id, status: 'todo', created: '' })),
        changed: () => {
          if (this.asks.get(id) === created) this.postAsk(id, panel);
        },
        log: (line) => this.output().appendLine(line),
      });
      chat = created;
      this.asks.set(id, chat);
    }
    await chat.ask(m.text);
  }

  private fallbackOutput: vscode.OutputChannel | undefined;
  private output(): vscode.OutputChannel {
    return this.deps.output ?? (this.fallbackOutput ??= vscode.window.createOutputChannel('Flotilla'));
  }

  /** Sends the Ask chat to its tab, at most every 60 ms while an answer streams in. */
  postAsk(id: string, panel: vscode.WebviewPanel, delayMs = 60): void {
    if (this.askTimers.has(id)) return;
    this.askTimers.set(
      id,
      setTimeout(() => {
        this.askTimers.delete(id);
        const chat = this.asks.get(id);
        if (chat && this.panels.get(id) === panel) void panel.webview.postMessage({ type: 'ask', ask: chat.view() } satisfies TicketHostMessage);
      }, delayMs),
    );
  }

  /**
   * What an Ask chat starts with (BL-80): the ticket as its tab shows it (description, latest activity), and its
   * branch (commits, the files they change, what's uncommitted). It answers in the ticket's worktree, else the main one.
   */
  private async askContext(id: string, panel: vscode.WebviewPanel): Promise<{ cwd: string; text: string }> {
    const view = this.sentViews.get(panel);
    const item = view?.item ?? (await this.item(id));
    if (!item) throw new Error(`${id} isn't in the backlog.`);
    const mainRoot = this.deps.mainRoot;
    const ws = this.worktreesOf(item).find((w) => w.worktree.path);
    const cwd = ws?.worktree.path ?? mainRoot;
    const base = await resolveBase(mainRoot, readSettings().defaultBase).catch(() => undefined);
    const branch = ws?.worktree.branch ?? view?.branches[0];
    const firstLines = (text: string, n: number) => {
      const all = text.split('\n').filter((l) => l.trim());
      return (all.length > n ? [...all.slice(0, n), `… ${all.length - n} more`] : all).join('\n');
    };
    const [diffStat, changes] = await Promise.all([
      base && branch && branch !== base
        ? runGit(['diff', '--stat=120', `${base}...${branch}`], { cwd: mainRoot }).then((t) => firstLines(t, 40), () => '')
        : Promise.resolve(''),
      ws ? runGit(['status', '--short'], { cwd }).then((t) => firstLines(t, 30), () => '') : Promise.resolve(''),
    ]);
    const text = askContextText({
      id: item.id,
      title: item.title,
      status: item.status,
      ...(view?.remote ? {} : { file: this.deps.backlog.docPath(item.id) }),
      description: view?.description ?? '',
      activity: view?.activity ?? [],
      ...(ws ? { worktree: { path: cwd, branch: ws.worktree.branch, changes } } : {}),
      ...(base ? { base } : {}),
      commits: (view?.commits ?? []).filter((c) => c.branches.length),
      diffStat,
    });
    return { cwd, text };
  }

  /** Writes to an issue's tracker (only ever from a click in its tab), then reads it and the backlog again. */
  async writeRemote(issue: string, write: (source: IssueSource) => Promise<void>): Promise<void> {
    await write(await this.source(issue));
    this.details.delete(issue);
    // The list has the status and priority the backlog shows; refreshing it refreshes the open tickets too.
    await this.deps.integrations.refresh();
  }

  /**
   * Posts a local activity entry (a comment or an agent's report) to the issue, or to one of a local item's linked
   * issues, after showing what will be posted and asking. Agents never post: they only write the ticket file.
   */
  async postEntry(item: BacklogItem & { remote?: RemoteIssue }, key: string): Promise<void> {
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:; media-src ${webview.cspSource} https:; connect-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('codicons', 'codicon.css')}">
<link rel="stylesheet" href="${uri('ticket.css')}">
</head>
<body>
<div id="root" data-mermaid="${uri('mermaid.js')}"></div>
<script nonce="${nonce}" src="${uri('ticket.js')}"></script>
</body>
</html>`;
  }
}

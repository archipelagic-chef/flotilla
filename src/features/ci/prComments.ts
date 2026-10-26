import { entryAgent } from '../backlog/backlog';
import { entryEdit } from '../backlog/commentEdits';
import { parseReport } from '../backlog/report';
import {
  entryAnchors,
  entryDate,
  fromGitHub,
  gitHubAuthor,
  parseReply,
  replyLine,
  type TicketEntry,
} from '../backlog/ticket';
import type { PullRequestComment } from './pullRequests';

/**
 * A ticket's activity and its pull request's comments, both ways (BL-224). The pull request's comments (its
 * conversation's and its line comments) come into the ticket as entries by "<login> on GitHub", each once: an entry
 * links its comment, and a comment already linked isn't brought in again. Your comments and the agents' report
 * summaries go to the pull request, each with a hidden mark naming its entry, so it's found there again: to edit it
 * when its entry is edited, to delete it when its entry is, and never to bring it back into the ticket.
 *
 * What was posted is kept as the entries' anchors ("known"): an entry is posted once, so a comment deleted on GitHub
 * isn't posted again. The entries already in the ticket when its pull request is first seen are known without being
 * posted: a new pull request doesn't get the ticket's whole history.
 */

/** The hidden mark at the end of a comment posted from a ticket's entry. */
const MARK = /<!--\s*flotilla\s+([A-Za-z][\w-]*)#([\w-]+)\s*-->\s*$/;

const mark = (id: string, anchor: string) => `<!-- flotilla ${id}#${anchor} -->`;

/** The ticket entry a comment was posted from, by its mark; undefined for comments made on GitHub. */
export function markOf(body: string): { id: string; anchor: string } | undefined {
  const m = MARK.exec(body);
  return m ? { id: m[1], anchor: m[2] } : undefined;
}

/** A link that opens a ticket at an entry, from GitHub (Flotilla's URI handler). */
export function ticketLink(id: string, anchor: string): string {
  return `vscode://archipelagic.flotilla/ticket?id=${encodeURIComponent(id)}&entry=${encodeURIComponent(anchor)}`;
}

/** What of an entry is posted on the pull request: your comment's text, an agent's report summary (or reply); none for the rest. */
export function postedText(e: TicketEntry): string | undefined {
  if (fromGitHub(e.author)) return undefined;
  const edit = entryEdit(e.body);
  if (edit.deleted) return undefined;
  if (e.author === 'You') return edit.text.trim() || undefined;
  if (!entryAgent(e.author)) return undefined;
  const summary = parseReport(edit.text).summary?.trim();
  return summary || (edit.replyLine ? edit.text.trim() : undefined) || undefined;
}

/** The line of an entry's text a reply on GitHub quotes: its first, without the line of a GitHub comment's place and link. */
function quoted(e: TicketEntry): string {
  const lines = entryEdit(e.body)
    .text.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !ON_LINE.test(l) && !ON_GITHUB.test(l));
  return lines[0] ?? '';
}

const ON_LINE = /^\*\*On \[[^\]]*\]\([^)]*\)\*\*:?$/;
const ON_GITHUB = /^\[On GitHub\]\([^)]*\)$/;

/** A comment's entry in the ticket: the one that links it. */
function linkedAnchor(activity: ReadonlyArray<TicketEntry>, anchors: string[], url: string): string | undefined {
  const i = activity.findIndex((e) => e.body.includes(`](${url})`));
  return i >= 0 ? anchors[i] : undefined;
}

/**
 * The pull request's comments that aren't in the ticket yet, as entries to append, oldest first: not the ones posted
 * from a ticket, nor those an entry links already. A line comment says its file and line (a link to it, which gets
 * its diff mark); a reply in a thread, or a comment quoting an entry, is a reply to that entry (BL-126).
 */
export function commentEntries(activity: ReadonlyArray<TicketEntry>, comments: ReadonlyArray<PullRequestComment>): TicketEntry[] {
  const all = [...activity];
  const added: TicketEntry[] = [];
  for (const c of comments) {
    if (markOf(c.body)) continue;
    const anchors = entryAnchors(all);
    if (linkedAnchor(all, anchors, c.url)) continue;
    let text = c.body.replace(/\r\n?/g, '\n').trim();
    let parent: string | undefined;
    if (c.inReplyTo) {
      // A thread is flat on GitHub (each reply names its first comment): a reply answers the thread's comment before it.
      const thread = comments.filter((t) => t.kind === 'review' && (t.id === c.inReplyTo || t.inReplyTo === c.inReplyTo) && t.id < c.id);
      for (let n = thread.length - 1; n >= 0 && !parent; n--) parent = anchorOf(all, anchors, thread[n]);
    } else {
      // GitHub's Quote reply: "> the line" first.
      const quote = /^((?:>[^\n]*\n?)+)/.exec(text);
      const said = quote?.[1]
        .split('\n')
        .map((l) => l.replace(/^>\s?/, '').trim())
        .join(' ');
      if (quote && said) {
        const person = (e: TicketEntry) => e.author === 'You' || !!entryAgent(e.author) || fromGitHub(e.author);
        let i = all.length - 1;
        while (i >= 0 && !(person(all[i]) && quoted(all[i]) && said.includes(quoted(all[i]).slice(0, 80)))) i--;
        if (i >= 0) {
          parent = anchors[i];
          text = text.slice(quote[1].length).trim();
        }
      }
    }
    const lines = [
      parent ? replyLine(all[anchors.indexOf(parent)], parent) : '',
      !parent && c.path ? `**On [${c.path}${c.line ? `:${c.line}` : ''}](${c.path}${c.line ? `#L${c.line}` : ''})**:` : '',
      text || '_(No text.)_',
      '',
      `[On GitHub](${c.url})`,
    ];
    const entry = {
      date: entryDate(new Date(c.createdAt)),
      author: gitHubAuthor(c.login),
      body: lines
        .filter((l, i) => l || i === 3)
        .join('\n')
        .trim(),
    };
    all.push(entry);
    added.push(entry);
  }
  return added;
}

/** The entry a comment is: the one it was posted from (its mark), or the one that links it. */
function anchorOf(activity: ReadonlyArray<TicketEntry>, anchors: string[], c: PullRequestComment): string | undefined {
  const m = markOf(c.body);
  return m ? (anchors.includes(m.anchor) ? m.anchor : undefined) : linkedAnchor(activity, anchors, c.url);
}

/** A comment as it's posted from an entry: who wrote it (an agent), the line it answers, its text, the link back, and its mark. */
export function commentBody(id: string, anchor: string, e: TicketEntry, text: string, quote?: string): string {
  const agent = entryAgent(e.author);
  return [
    agent ? `**${e.author}**:` : '',
    quote ? `> ${quote}` : '',
    text,
    `<sub>From [${id}](${ticketLink(id, anchor)}) in Flotilla</sub>\n${mark(id, anchor)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export interface CommentSync {
  /** The entries known after this: posted, or there before the pull request (to keep for the next sync). */
  known: string[];
  posts: Array<{ anchor: string; body: string; inReplyTo?: number }>;
  edits: Array<{ anchor: string; comment: PullRequestComment; body: string }>;
  deletes: Array<{ anchor: string; comment: PullRequestComment }>;
}

/**
 * What goes from the ticket to its pull request: entries to post (once each), comments whose entry was edited, and
 * comments whose entry was deleted. `known` undefined: the pull request is new here, and the entries there now are
 * only known. A reply to a line comment goes into its thread; a reply to a comment in the conversation quotes it.
 */
export function planPosts(o: {
  id: string;
  activity: ReadonlyArray<TicketEntry>;
  comments: ReadonlyArray<PullRequestComment>;
  known: ReadonlyArray<string> | undefined;
}): CommentSync {
  const anchors = entryAnchors(o.activity);
  if (!o.known) return { known: anchors, posts: [], edits: [], deletes: [] };
  const known = new Set(o.known);
  const posted = new Map<string, PullRequestComment>();
  for (const c of o.comments) {
    const m = markOf(c.body);
    if (m?.id === o.id && !posted.has(m.anchor)) posted.set(m.anchor, c);
  }
  const sync: CommentSync = { known: [...o.known], posts: [], edits: [], deletes: [] };
  o.activity.forEach((e, i) => {
    const anchor = anchors[i];
    const text = postedText(e);
    const there = posted.get(anchor);
    if (text === undefined) {
      if (there) sync.deletes.push({ anchor, comment: there });
      return;
    }
    const reply = parseReply(entryEdit(e.body).replyLine ?? '');
    const parentAt = reply ? anchors.indexOf(reply.to) : -1;
    const parent = parentAt >= 0 ? (posted.get(reply!.to) ?? o.comments.find((c) => o.activity[parentAt].body.includes(`](${c.url})`))) : undefined;
    const thread = parent?.kind === 'review' ? (parent.inReplyTo ?? parent.id) : undefined;
    const quote = parent && !thread ? quoted(o.activity[parentAt]) : undefined;
    const body = commentBody(o.id, anchor, e, text, quote);
    if (there) {
      if (there.body.trim() !== body.trim()) sync.edits.push({ anchor, comment: there, body });
    } else if (!known.has(anchor)) {
      sync.posts.push({ anchor, body, ...(thread ? { inReplyTo: thread } : {}) });
    }
    if (!known.has(anchor)) {
      known.add(anchor);
      sync.known.push(anchor);
    }
  });
  // Entries that are gone from the ticket: their comments go too.
  for (const [anchor, c] of posted) if (!anchors.includes(anchor)) sync.deletes.push({ anchor, comment: c });
  return sync;
}

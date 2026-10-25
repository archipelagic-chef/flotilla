import { useEffect, useState } from 'preact/hooks';
import { entryAgent } from '../../features/backlog/backlog';
import { entryRound, type FeedGroup, foldRounds, foldTitle, openEntry, type RoundFold, type RoundInfo } from '../../features/backlog/rounds';
import { type Answer, answerComment, answerFromText, answerOf, answersIn, choose, defaultAnswer } from '../../features/backlog/report';
import { summaryOf } from '../../features/backlog/ticket';
import type { ReportView, TicketView, TicketWebviewMessage } from '../ticketProtocol';
import { Diagram, diagramsIn, openMedia, SHOW_ENTRY, showEntry, shownDiagram } from './attachments';
import { act, ActionButton, doneListeners, send, useWorking, WorkingTag } from './actions';
import { REPLY_TO, sendComment, useSending } from './comments';
import { AskButton, AskLine } from './askAgent';
import { MarkdownBox, mentionPrefix, Rendered } from './markdownBox';
import { ago, ChatCard, chatState } from './agents';
import './activity.css';

type ActivityEntry = TicketView['activity'][number];

/** Who an entry is by, as the ticket names it: an agent by its name. */
const byName = (e: Pick<ActivityEntry, 'author'>) => entryAgent(e.author) ?? (e.author || 'Note');

const AUTHOR_ICON: Record<string, string> = {
  you: 'account',
  agent: 'hubot',
  flotilla: 'info',
};

/**
 * What an agent needs from the user: its text, and its questions. Unanswered questions (local items) are answered by
 * clicking: a choice (its recommendation preselected) or Other…; one Send posts the answers as the user's comment, and
 * the agent goes on from there. Answered ones, and those of tracker-linked items, show what was chosen, read-only.
 */
function Needs({ report, name, live }: { report: ReportView; name: string; live: boolean }) {
  const answered = report.answer !== undefined;
  const interactive = live && !answered && report.questions.length > 0;
  const [answers, setAnswers] = useState<Answer[]>(() => report.questions.map(defaultAnswer));
  const given = answered ? answersIn(report.questions, report.answer!) : [];
  const shown = interactive ? answers : report.questions.map((q, i) => (answered ? answerFromText(q, given[i] ?? '') : { picked: [], other: '' }));
  const update = (qi: number, change: (a: Answer) => Answer) => setAnswers((all) => all.map((a, i) => (i === qi ? change(a) : a)));
  const texts = report.questions.map((q, i) => answerOf(q, answers[i]));
  const ready = interactive && texts.every(Boolean);
  const submit = () => {
    if (ready) sendComment(answerComment(report.questions.map((question, i) => ({ question, answer: texts[i] }))));
  };
  return (
    <div class={`needs${answered ? ' answered' : ''}`}>
      {report.needs && (
        <>
          <div class="needs-line">
            <i class="codicon codicon-question" /> <strong>Needs from you:</strong>
          </div>
          <Rendered html={report.needs} empty="" />
        </>
      )}
      {answered && <div class="muted">Answered.</div>}
      {report.questions.map((q, qi) => {
        const a = shown[qi];
        const other = q.options.length;
        const type = q.kind === 'several' ? 'checkbox' : 'radio';
        return (
          <fieldset class="question" key={qi}>
            <legend>{q.text}</legend>
            {q.kind === 'text' ? (
              interactive ? (
                <MarkdownBox
                  value={a.other}
                  setValue={(text) => update(qi, (x) => ({ ...x, other: text }))}
                  placeholder="Your answer (Markdown)"
                  label={`Your answer to: ${q.text}`}
                  onSubmit={submit}
                  images={false}
                  minRows={2}
                  autoFocus={qi === 0}
                />
              ) : (
                <div class="answer-text">{a.other}</div>
              )
            ) : (
              <>
                {q.options.map((o, i) => (
                  <label class="choice" key={i}>
                    <input
                      type={type}
                      name={`${name}-${qi}`}
                      checked={a.picked.includes(i)}
                      disabled={!interactive}
                      onChange={() => update(qi, (x) => choose(q, x, i))}
                    />
                    <span>{o.text}</span>
                    {o.recommended && <span class="recommended">recommended</span>}
                  </label>
                ))}
                {q.kind !== 'yesno' && (
                  <label class="choice">
                    <input
                      type={type}
                      name={`${name}-${qi}`}
                      checked={a.picked.includes(other)}
                      disabled={!interactive}
                      onChange={() => update(qi, (x) => choose(q, x, other))}
                    />
                    <span>Other…</span>
                  </label>
                )}
                {q.kind !== 'yesno' &&
                  a.picked.includes(other) &&
                  (interactive ? (
                    <MarkdownBox
                      value={a.other}
                      setValue={(text) => update(qi, (x) => ({ ...x, other: text }))}
                      placeholder="Your answer (Markdown)"
                      label={`Your answer to: ${q.text}`}
                      onSubmit={submit}
                      images={false}
                      minRows={2}
                      autoFocus
                    />
                  ) : (
                    <div class="answer-text">{a.other}</div>
                  ))}
              </>
            )}
          </fieldset>
        );
      })}
      {interactive && (
        <div class="actions-row">
          <button class="button" disabled={!ready} onClick={submit} title="Posts the answers as your comment: the agent goes on from there">
            {report.questions.length > 1 ? 'Send Answers' : 'Send'}
          </button>
        </div>
      )}
    </div>
  );
}

type EntryKind = 'comment' | 'agent' | 'history';

/** People's comments (here or in the tracker), agents' reports, and Flotilla's notes (what happened). */
function kindOf(author: string): EntryKind {
  if (entryAgent(author) || author.toLowerCase() === 'agent') return 'agent';
  if (author === 'Flotilla' || !author) return 'history';
  return 'comment';
}

/** When an entry was written ("2026-10-11 09:30", local time); undefined if it doesn't say. */
function entryTime(date: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(date);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)).getTime() : undefined;
}

/** The entries (in their order) with the commits merged in by time, oldest first. */
function withCommits<E extends { date: string }>(entries: E[], commits: TicketView['commits']): Array<E | { commit: TicketView['commits'][number] }> {
  const pending = [...commits].sort((a, b) => a.date.localeCompare(b.date));
  const out: Array<E | { commit: TicketView['commits'][number] }> = [];
  for (const e of entries) {
    const at = entryTime(e.date);
    // Entries are written to the minute: a commit in that minute comes first.
    while (at !== undefined && pending.length && new Date(pending[0].date).getTime() < at + 60_000) out.push({ commit: pending.shift()! });
    out.push(e);
  }
  for (const c of pending) out.push({ commit: c });
  return out;
}

const TABS: Array<{ kind?: EntryKind; label: string }> = [{ label: 'All' }, { kind: 'comment', label: 'Comments' }, { kind: 'agent', label: 'Agent Reports' }];

const EMPTY: Record<string, string> = {
  all: 'No comments or reports yet. Agents report here as they work.',
  comment: 'No comments yet.',
  agent: 'No agent reports yet. Start an agent: it reports here as it works.',
};

/** A row of the feed: an entry, or a commit. */
type FeedRow = TicketView['activity'][number] | { commit: TicketView['commits'][number] };

const feedRound = (f: FeedRow): RoundInfo => ('commit' in f ? { part: 'round' } : entryRound(f));

/** A feed row's key: a commit's hash, or an entry's place in the ticket's activity (which only grows at the end). */
const rowKey = (f: FeedRow, ticket: TicketView) => ('commit' in f ? `commit-${f.commit.hash}` : `entry-${ticket.activity.indexOf(f)}`);

/** One row of the feed: a commit, or an entry (a comment, an agent's report, a note). */
function FeedRowView({ f, ticket, onFold, nest }: { f: FeedRow; ticket: TicketView; onFold?: () => void; nest?: boolean }) {
  if ('commit' in f) {
    const c = f.commit;
    return (
      <li class="entry kind-commit">
        <ActionButton
          class="commit-line"
          message={{ type: 'openCommit', hash: c.hash }}
          working="Opening…"
          title={`${c.subject}\n${c.author}, ${new Date(c.date).toLocaleString()}\nClick to show it in its worktree’s history`}
        >
          <i class="codicon codicon-git-commit" />
          <span class="hash">{c.short}</span>
          <span class="subject">{c.subject}</span>
          {c.branches[0] && <span class="branch-tag">{c.branches[0]}</span>}
          <span class="muted">
            {c.author} · {ago(c.date)}
          </span>
        </ActionButton>
      </li>
    );
  }
  const e = f;
  const kind = kindOf(e.author);
  const agentChat = kind === 'agent' && e.chat && !('pending' in e.chat) ? e.chat : undefined;
  // Its replies show under it, one level deep (BL-126): a top-level entry's, in the conversation.
  const replies = nest ? repliesTo(e, ticket) : [];
  return (
    <li class={`entry kind-${kind}${e.reply ? ' reply' : ''}`} data-entry-key={e.key}>
      {e.reply && <ReplyLine e={e} ticket={ticket} />}
      <div class="entry-head">
        <i class={`codicon codicon-${kind === 'agent' ? 'hubot' : (AUTHOR_ICON[e.author.toLowerCase()] ?? 'account')}`} />
        {/* Agents go by their names ("Nova-7"); the robot icon and the tag say what they are. */}
        <strong>{entryAgent(e.author) ?? (e.author || 'Note')}</strong>
        {kind === 'agent' && <span class="bot-tag">agent</span>}
        {e.date && <span class="muted">{e.date}</span>}
        {agentChat && (
          <button
            class="chat-chip"
            onClick={() => send({ type: 'openChat', key: agentChat.key, id: agentChat.id })}
            title={`Written in the chat "${agentChat.title}"${agentChat.stalled ? ` (${chatState(agentChat).label})` : ''}. Click to open it in Claude Code.`}
          >
            <span class={`dot ${chatState(agentChat).cls}`} />
            <i class="codicon codicon-comment-discussion" />
            <span class="chat-chip-title">{agentChat.title}</span>
          </button>
        )}
        {e.posted && (
          <span class="posted" title={`Posted as a comment on ${e.posted}`}>
            <i class="codicon codicon-check" /> Posted to {e.posted}
          </span>
        )}
        {e.key && !e.posted && ticket.postTargets.length > 0 && kind !== 'history' && (
          <ActionButton class="text-button post-entry" message={{ type: 'postEntry', key: e.key! }} working="Posting…" title="Shows what will be posted and asks first">
            <i class="codicon codicon-comment-unresolved" /> Post to {ticket.postTargets.length === 1 ? ticket.postTargets[0] : 'an Issue'}…
          </ActionButton>
        )}
        {!ticket.remote && e.anchor && kind !== 'history' && (
          <button
            class="text-button reply-entry"
            onClick={() => window.dispatchEvent(new CustomEvent<ActivityEntry>(REPLY_TO, { detail: e }))}
            title="Reply to this entry: your comment shows under it"
          >
            <i class="codicon codicon-reply" /> Reply
          </button>
        )}
        <AskButton e={e} ticket={ticket} />
        {onFold && (
          <button class="text-button fold-entry" aria-expanded={true} onClick={onFold}>
            <i class="codicon codicon-chevron-up" /> Fold
          </button>
        )}
      </div>
      {e.report ? (
        <>
          <Rendered html={e.report.summary} empty="" />
          {/* Its pictures, videos and diagrams lead it (BL-114): the text they belong to stays in Details. */}
          {e.report.media && (
            <div class="report-media">
              <Rendered html={e.report.media} empty="" />
            </div>
          )}
          {e.report.asks && <Needs report={e.report} name={e.key ?? `${e.date}${e.author}`} live={!ticket.remote} />}
          {e.report.details && (
            <details class="report-details">
              <summary>Details</summary>
              <Rendered html={e.report.details} empty="" />
            </details>
          )}
        </>
      ) : (
        <Rendered html={e.html} empty="" />
      )}
      {kind === 'history' && e.chat && <ChatCard chat={e.chat} />}
      {replies.length > 0 && (
        <ol class="replies">
          {replies.map((r) => (
            <FeedRowView key={rowKey(r, ticket)} f={r} ticket={ticket} />
          ))}
        </ol>
      )}
      {/* Where its reply will show: what the agent asked to answer it is at (BL-127). */}
      <AskLine e={e} ticket={ticket} />
    </li>
  );
}

/** The replies grouped under a top-level entry (BL-126): in the conversation, by anyone but Flotilla. */
function repliesTo(e: ActivityEntry, ticket: TicketView): ActivityEntry[] {
  const i = ticket.activity.indexOf(e);
  return ticket.activity.filter((r) => r.root === i && kindOf(r.author) !== 'history');
}

/** Whether an entry shows under its top-level entry, not on its own: a reply to an entry of the conversation. */
const nested = (e: ActivityEntry, ticket: TicketView) =>
  e.root !== undefined && kindOf(e.author) !== 'history' && !!ticket.activity[e.root] && kindOf(ticket.activity[e.root].author) !== 'history';

/** "↩ reply to You, 16:04" above a reply: a click goes to the entry it answers (when it's still there). */
function ReplyLine({ e, ticket }: { e: ActivityEntry; ticket: TicketView }) {
  const r = e.reply!;
  const parent = ticket.activity.find((p) => p.anchor === r.to);
  const day = r.date.slice(0, 10) === e.date.slice(0, 10) ? r.date.slice(11) : r.date;
  const label = parent ? `reply to ${byName(parent)}${day ? `, ${day}` : ''}` : r.label.replace(/^Reply/, 'reply') || 'reply';
  return parent?.key ? (
    <button class="reply-to" onClick={() => showEntry(parent.key!)} title="Go to the entry it answers">
      ↩ {label}
    </button>
  ) : (
    <div class="reply-to" title={parent ? undefined : 'The entry it answers is no longer in the ticket'}>
      ↩ {label}
    </div>
  );
}

/** A folded report's media (BL-114), beside its line: a click opens one in the viewer, and the entry stays folded. */
function MediaStrip({ e }: { e: ActivityEntry }) {
  const thumbs = e.thumbs!;
  const open = (at: number) =>
    openMedia(
      thumbs.map((t) => ({ ...t, name: t.alt ?? (t.kind === 'diagram' ? 'Diagram' : (t.src ?? '').split(/[/?#]/).filter(Boolean).at(-1) ?? ''), author: e.author, date: e.date, entryKey: e.key })),
      at,
    );
  return (
    <ul class="media-strip">
      {thumbs.map((t, i) => (
        <li key={i}>
          <button class="media-thumb" onClick={() => open(i)} title={`${t.alt ?? (t.kind === 'diagram' ? 'A diagram' : '')}\nClick to open it large`.trim()}>
            {t.kind === 'diagram' ? (
              <Diagram code={t.code ?? ''} label={t.alt ?? 'A diagram'} class="media-thumb-diagram" />
            ) : t.kind === 'video' ? (
              <>
                {/* Its first frame; it doesn't play here. */}
                <video src={t.src} preload="metadata" muted tabIndex={-1} />
                <i class="codicon codicon-play-circle play-mark" />
              </>
            ) : (
              <img src={t.src} alt={t.alt ?? ''} loading="lazy" />
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A review's rounds folded into one line ("Reviewed by Flux-3 in 2 rounds → approved"); a click shows them, in order. */
function RoundFoldLine({ fold, ticket }: { fold: RoundFold<FeedRow>; ticket: TicketView }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // "Show in activity" (BL-110) for an entry in it opens it.
    const show = (e: Event) => fold.items.some((f) => !('commit' in f) && f.key === (e as CustomEvent<string>).detail) && setOpen(true);
    window.addEventListener(SHOW_ENTRY, show);
    return () => window.removeEventListener(SHOW_ENTRY, show);
  }, [fold]);
  return (
    <li class="entry kind-review">
      <button
        class="review-fold"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={open ? 'Hides the reviews and changes' : 'Shows the reviews and changes, in order'}
      >
        <i class={`codicon codicon-${open ? 'chevron-down' : 'chevron-right'}`} />
        <i class="codicon codicon-eye" />
        <span>{foldTitle(fold)}</span>
      </button>
      {open && (
        <ol class="fold-items">
          {fold.items.map((f) => (
            <FeedRowView key={rowKey(f, ticket)} f={f} ticket={ticket} nest />
          ))}
        </ol>
      )}
    </li>
  );
}

/** What the link under a ticket in review without a run block puts in the comment box: a request to the agent. */
const ASK_FOR_RUN =
  'Please end your report with a run block: a fenced block with the info string `run`, and the commands that try the work (or a `launch`, `task` or `open` block), so it can be run from here.';

/** Flotilla's notes and the commits, in time order: what happened, behind "Show activity". */
function Timeline({ ticket }: { ticket: TicketView }) {
  const notes = ticket.activity.filter((e) => kindOf(e.author) === 'history');
  const rows = withCommits(notes, ticket.commits);
  if (!rows.length) return <div class="empty-text">Nothing has happened yet.</div>;
  return (
    <ol class="timeline">
      {rows.map((f, i) => {
        if ('commit' in f) {
          const c = f.commit;
          return (
            <li key={c.hash} class="timeline-row">
              <ActionButton
                class="timeline-item commit"
                message={{ type: 'openCommit', hash: c.hash }}
                working="Opening…"
                title={`${c.subject}\n${c.author}, ${new Date(c.date).toLocaleString()}\nClick to show it in its worktree’s history`}
              >
                <i class="codicon codicon-git-commit" />
                <span class="hash">{c.short}</span>
                <span class="timeline-text">{c.subject}</span>
                <span class="muted">{ago(c.date)}</span>
              </ActionButton>
            </li>
          );
        }
        const e = f;
        const chat = e.chat && !('pending' in e.chat) ? e.chat : undefined;
        return (
          <li key={`${e.date}${i}`} class="timeline-row">
            <span class="timeline-item">
              <span class="muted">{e.date}</span>
              <span class="timeline-text">{summaryOf(e.body) ?? ''}</span>
            </span>
            {chat && (
              <button
                class="chat-chip"
                onClick={() => send({ type: 'openChat', key: chat.key, id: chat.id })}
                title={`Open the chat "${chat.title}" in Claude Code`}
              >
                <i class="codicon codicon-comment-discussion" />
                <span class="chat-chip-title">{chat.title}</span>
              </button>
            )}
            {e.chat && 'pending' in e.chat && <ChatCard chat={e.chat} />}
          </li>
        );
      })}
    </ol>
  );
}

export function Activity({ ticket }: { ticket: TicketView }) {
  const [comment, setComment] = useState('');
  // The entry the comment box replies to (BL-126).
  const [replyTo, setReplyTo] = useState<ActivityEntry | undefined>(undefined);
  const [tab, setTab] = useState<EntryKind | undefined>(undefined);
  const [timeline, setTimeline] = useState(ticket.showActivity);
  // The entries (by their place in the activity) the user opened: all but the latest report fold to a line.
  const [opened, setOpened] = useState<Set<number>>(() => new Set());
  useEffect(() => setTimeline(ticket.showActivity), [ticket.showActivity]);
  const toggleOpened = (i: number) =>
    setOpened((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const toggleTimeline = () => {
    setTimeline(!timeline);
    send({ type: 'showActivity', shown: !timeline });
  };
  useEffect(() => {
    // "Show in activity" (BL-110): the entry opens, with its details, and shows in the middle for a moment.
    const show = (event: Event) => {
      const key = (event as CustomEvent<string>).detail;
      const i = ticket.activity.findIndex((e) => e.key === key);
      if (i < 0) return;
      setTab(undefined);
      // A reply's top-level entry opens with it (BL-126).
      const root = ticket.activity[i].root;
      setOpened((s) => new Set(s).add(i).add(root ?? i));
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const li = document.querySelector<HTMLElement>(`.feed [data-entry-key="${CSS.escape(key)}"]`);
          if (!li) return;
          for (const d of li.querySelectorAll('details')) if (d.querySelector('img, video, [data-diagram], code.language-mermaid')) d.open = true;
          // A diagram's "Show in activity" (BL-136) goes to the diagram in it.
          const n = shownDiagram(key);
          ((n !== undefined ? diagramsIn(li)[n] : undefined) ?? li).scrollIntoView({ behavior: 'smooth', block: 'center' });
          li.classList.add('flash');
          setTimeout(() => li.classList.remove('flash'), 1600);
        }),
      );
    };
    window.addEventListener(SHOW_ENTRY, show);
    return () => window.removeEventListener(SHOW_ENTRY, show);
  }, [ticket.activity]);
  useEffect(() => {
    const reply = (event: Event) => {
      setReplyTo((event as CustomEvent<ActivityEntry>).detail);
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.comment-box textarea')?.focus());
    };
    window.addEventListener(REPLY_TO, reply);
    return () => window.removeEventListener(REPLY_TO, reply);
  }, []);
  // The entry replied to, as the ticket has it now (gone when it was removed).
  const replying = replyTo && ticket.activity.find((e) => e.anchor === replyTo.anchor);
  const sending = useSending();
  useEffect(() => {
    const listener = (m: TicketWebviewMessage, failed: boolean) => {
      // It didn't post: what was written goes back into the box, so nothing is lost.
      if (m.type === 'comment' && failed) setComment((draft) => (draft.trim() ? draft : m.text));
    };
    doneListeners.add(listener);
    return () => void doneListeners.delete(listener);
  }, []);
  // Once the host has the comment (an entry after `at`, by the same author), it's no longer sent: it's the entry.
  const unconfirmed = sending.filter((p) => !ticket.activity.slice(p.at).some((e) => e.author === 'You' && e.body.trim() === p.text.trim()));
  const changesBusy = useWorking({ type: 'userReview', verdict: 'changes', text: '' });
  const approveBusy = useWorking({ type: 'userReview', verdict: 'approved', text: '' });
  const post = (ask = false) => {
    if (!comment.trim()) return;
    sendComment(comment, replying?.anchor, ask);
    setComment('');
    setReplyTo(undefined);
    if (tab && tab !== 'comment') setTab(undefined);
  };
  const review = (verdict: 'approved' | 'changes') => {
    act({ type: 'userReview', verdict, text: comment }, 'Sending…');
    setComment('');
    if (tab && tab !== 'comment') setTab(undefined);
  };
  const asking = ticket.review?.state === 'asking' ? (ticket.review.implementer ?? 'The agent') : undefined;
  // A local item with work to review: the user can review it here, as in a pull request.
  const reviewable = !ticket.remote && ticket.canReview && ticket.item.status !== 'done';
  // A ticket in review (or approved) runs its latest run block from here, next to Approve and Request Changes.
  const showRun = !ticket.remote && (ticket.item.status === 'review' || ticket.review?.state === 'approved');
  // It goes in the comment box, after a draft. Request Changes sends it to the agent: a Comment is only a note.
  const askForRun = () => {
    setComment((draft) => (draft.trim() ? `${draft.trimEnd()}\n\n${ASK_FOR_RUN}` : ASK_FOR_RUN));
    document.querySelector<HTMLTextAreaElement>('.comment-box textarea')?.focus();
  };
  // In All, a reply shows under its top-level entry (BL-126); a tab shows each entry of its kind on its own.
  const inConversation = (e: ActivityEntry) => kindOf(e.author) !== 'history' && (tab ? kindOf(e.author) === tab : !nested(e, ticket));
  // In All, a review's rounds fold into one line (rounds.ts). They're found with Flotilla's notes ("Review round 2: …"),
  // which then stay in the timeline: a fold shows the reviews and revisions.
  const groups: Array<FeedGroup<FeedRow>> = tab
    ? ticket.activity.filter(inConversation).map((item) => ({ item }))
    : foldRounds<FeedRow>(ticket.activity, feedRound, ticket.review && { state: ticket.review.state, reviewer: ticket.review.reviewer })
        .map((g) => ('fold' in g ? { fold: { ...g.fold, items: g.fold.items.filter((f) => !('commit' in f) && inConversation(f)) } } : g))
        .filter((g) => ('fold' in g ? g.fold.items.length > 0 : !('commit' in g.item) && inConversation(g.item)));
  // Notes and commits are the timeline; comments and reports are the conversation. The latest agent's report in the
  // feed is open (rounds.ts says which), older ones are folded to a line each (opened by a click).
  const folded = new Set(groups.flatMap((g) => ('fold' in g ? g.fold.items : [])));
  const latest = openEntry(ticket.activity, (e) => !folded.has(e) && (!nested(e, ticket) || !folded.has(ticket.activity[e.root!])));
  return (
    <section class="block">
      <div class="block-head">
        <h2>Activity</h2>
      </div>
      <div class="tabs" role="tablist" aria-label="Show">
        {TABS.map((t) => {
          const count = ticket.activity.filter((e) => kindOf(e.author) !== 'history' && (!t.kind || kindOf(e.author) === t.kind)).length;
          return (
            <button key={t.label} role="tab" aria-selected={tab === t.kind} onClick={() => setTab(t.kind)}>
              {t.label}
              {count > 0 && <span class="count">{count}</span>}
            </button>
          );
        })}
      </div>
      {!groups.length && !unconfirmed.length && !ticket.loading && <div class="empty-text">{EMPTY[tab ?? 'all']}</div>}
      <ol class="feed">
        {groups.map((g) => {
          if ('fold' in g) return <RoundFoldLine key={rowKey(g.fold.items[0], ticket)} fold={g.fold} ticket={ticket} />;
          const e = g.item as TicketView['activity'][number];
          const i = ticket.activity.indexOf(e);
          const replies = tab ? 0 : repliesTo(e, ticket).length;
          // The latest agent's entry is open, and so is the entry it replies to.
          const holdsLatest = !!latest && latest.root === i && nested(latest, ticket);
          // A comment an agent is answering stays open: its line shows what the agent is at (BL-127).
          const answering = !!e.anchor && ['thinking', 'waiting'].includes(ticket.asked?.[e.anchor]?.state ?? '');
          if (e !== latest && !holdsLatest && !answering && !opened.has(i)) {
            return (
              <li key={i} class={`entry folded kind-${kindOf(e.author)}`} data-entry-key={e.key}>
                <button class="entry-fold" aria-expanded={false} onClick={() => toggleOpened(i)} title="Open this entry">
                  <i class="codicon codicon-chevron-right" />
                  <strong>{entryAgent(e.author) ?? (e.author || 'Note')}</strong>
                  {e.date && <span class="muted">{e.date}</span>}
                  <span class="fold-first">{summaryOf(e.body) ?? ''}</span>
                  {replies > 0 && (
                    <span class="reply-count">
                      {replies} repl{replies === 1 ? 'y' : 'ies'}
                    </span>
                  )}
                </button>
                {!!e.thumbs?.length && <MediaStrip e={e} />}
              </li>
            );
          }
          return <FeedRowView key={i} f={e} ticket={ticket} nest={!tab} onFold={e !== latest && !holdsLatest ? () => toggleOpened(i) : undefined} />;
        })}
        {(!tab || tab === 'comment') &&
          unconfirmed.map((p, i) => (
            <li key={`sending-${i}`} class="entry kind-comment sending">
              <div class="entry-head">
                <i class="codicon codicon-account" />
                <strong>You</strong>
                <span class="muted">{p.date}</span>
                <WorkingTag label="Sending…" />
              </div>
              <div class="sending-body">{p.text}</div>
            </li>
          ))}
      </ol>
      <button class="text-button activity-toggle" aria-expanded={timeline} onClick={toggleTimeline}>
        <i class={`codicon codicon-chevron-${timeline ? 'down' : 'right'}`} /> {timeline ? 'Hide activity' : 'Show activity'}
      </button>
      {timeline && <Timeline ticket={ticket} />}
      <div class="comment-box">
        {replying && (
          <div class="replying">
            <i class="codicon codicon-reply" /> Replying to <strong>{byName(replying)}</strong>
            {replying.date && <span class="muted">{replying.date}</span>}
            <span class="replying-first">{summaryOf(replying.body) ?? ''}</span>
            <button class="icon-button" onClick={() => setReplyTo(undefined)} title="Cancel the reply: the comment goes at the end" aria-label="Cancel the reply">
              <i class="codicon codicon-close" />
            </button>
          </div>
        )}
        <MarkdownBox
          value={comment}
          setValue={setComment}
          placeholder={
            replying
              ? `Reply to ${byName(replying)} (Markdown; Ctrl+Enter posts the reply)`
              : asking
              ? `Answer ${asking}'s question (Markdown; Ctrl+Enter sends it, and ${asking} goes on)`
              : ticket.remote
                ? `Comment in ${ticket.remote.kind === 'jira' ? 'Jira (Markdown, converted to Jira formatting' : 'GitHub (Markdown'}; Ctrl+Enter posts it there)`
                : 'Add a comment (Markdown; paste or drop images and videos; Ctrl+Enter posts)'
          }
          label="Comment"
          onSubmit={() => post()}
          onSubmitShift={ticket.canAsk && !asking ? () => post(true) : undefined}
          images={!ticket.remote}
          format="markdown"
          mention={mentionPrefix(ticket.item.id)}
        />
        <div class="actions-row">
          {reviewable && (
            <>
              <button
                class="button secondary"
                disabled={!!changesBusy || !!approveBusy}
                onClick={() => review('changes')}
                title="Sends the work back with your comment: an agent picks it up (its implementer's chat, resumed), and asks you first if it needs more context"
              >
                <i class="codicon codicon-request-changes" /> Request Changes
                {changesBusy && <WorkingTag label={changesBusy} />}
              </button>
              <button class="button secondary" disabled={!!changesBusy || !!approveBusy} onClick={() => review('approved')} title="Approves the work, with your comment if you wrote one">
                <i class="codicon codicon-check" /> Approve
                {approveBusy && <WorkingTag label={approveBusy} />}
              </button>
            </>
          )}
          {showRun &&
            (ticket.run ? (
              <ActionButton
                class="button secondary"
                message={{ type: 'run', key: ticket.run!.key, index: ticket.run!.index }}
                working="Running…"
                title={`Runs ${ticket.run.title ? `"${ticket.run.title}"` : 'the latest run block'} in the ticket's worktree, after asking`}
              >
                <i class="codicon codicon-play" /> Run
              </ActionButton>
            ) : (
              <>
                <button class="button secondary" disabled title="The agent didn't give a run block: there's nothing to run">
                  <i class="codicon codicon-play" /> Run
                </button>
                <span class="muted">The agent didn't give a run block.</span>
                {reviewable && (
                  <button
                    class="text-button"
                    onClick={askForRun}
                    title="Puts a request for one in the comment box. Request Changes sends it to the agent; Comment would only leave a note."
                  >
                    Ask it for one
                  </button>
                )}
              </>
            ))}
          {ticket.canAsk && !asking && (
            <button class="button secondary" disabled={!comment.trim()} onClick={() => post(true)} title="Posts your comment, and an agent answers it now, as a reply (Ctrl+Shift+Enter)">
              <i class="codicon codicon-sparkle" /> Comment and Ask an Agent
            </button>
          )}
          <button class="button" disabled={!comment.trim()} onClick={() => post()}>
            {asking ? 'Answer' : 'Comment'}
          </button>
        </div>
      </div>
    </section>
  );
}

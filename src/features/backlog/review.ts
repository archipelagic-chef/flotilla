import type { BacklogItem } from './backlog';
import { entryAgent, sameAgent } from './backlog';
import { parseReport } from './report';
import type { TicketEntry } from './ticket';

/**
 * The review loop: when an item goes to review, a reviewer agent (not the one that did the work) reviews it and gives
 * a verdict in the ticket. Changes requested send it back to the implementer, who reports "Ready for review" when
 * done; the reviewer looks again. It ends when the reviewer approves, or after the most rounds allowed.
 */
export interface ReviewState {
  /** 1 for the first review. */
  round: number;
  /**
   * working: an agent the autopilot started is doing the work; reviewing: the reviewer is at it; revising: the implementer is making the changes asked for; asking: the
   * implementer asked something and waits for the user's answer (a comment); yours: the work waits for the user's
   * review; approved; stopped: no verdict, too many rounds, or stopped by the user.
   */
  state: 'working' | 'reviewing' | 'revising' | 'asking' | 'yours' | 'approved' | 'stopped' | 'paused';
  /**
   * Paused on Claude's usage limit (or for a prioritized start, see `for`): the agent's chat goes on at until, then back
   * in resume's state. Paused by the user (byUser): it goes on when they resume it.
   */
  paused?: HeldAgent & {
    /** ISO 8601; none for a pause by the user. */
    until?: string;
    /** The reset was said (not a guess). */
    known?: boolean;
    /** Paused to make room for a prioritized start on this item (not for a limit): it goes on when a slot frees. */
    for?: string;
    /** What was hit, when the reset wasn't said: the tries back off by it. */
    kind?: 'usage' | 'rate' | 'overloaded';
    /** Tries that failed on the limit again since it first stopped (ISO 8601), when the reset wasn't said. */
    tries?: number;
    since?: string;
    /** The user paused it (when, ISO 8601): it waits for them, whatever the limit or the queue. */
    byUser?: string;
  };
  /** The autopilot started the work (no one asked an agent to). */
  autopilot?: boolean;
  /** The reviewer agent ('' when there has been none yet). */
  reviewer: string;
  /** The user gave the last verdict (approved, or changes requested), not the reviewer agent. */
  byUser?: boolean;
  /** When the review last came to a state that waits on the user (see WAITING_STATES), ISO 8601. */
  since?: string;
  reviewerSession?: string;
  implementer?: string;
  implementerSession?: string;
  /** The worktree the work (and the review) is in. */
  worktree?: string;
  /** Why it stopped, for the user. */
  reason?: string;
  /**
   * Why it stopped, for fixing it from the ticket; and the implementer's task that didn't get done, if any. Stopped by
   * the user: the agent they stopped (to resume its chat), and when (ISO 8601).
   */
  stop?: { kind: ReviewStopKind; task?: RevisionTask; agent?: HeldAgent; at?: string };
  /** Rounds allowed beyond flotilla.review.maxRounds (Another Round). */
  extraRounds?: number;
  /** Reports already acted on ("Ready for review", verdicts), by entry key. */
  handled?: string[];
}

/** An agent paused or stopped on an item: enough to go on in its chat. */
export interface HeldAgent {
  phase: 'review' | 'work';
  session: string;
  agent: string;
  /** The review's state while it runs again. */
  resume: 'working' | 'reviewing' | 'revising';
  /** Where it ran: without a window (the default), or in a terminal (where it goes on again). */
  where?: 'headless' | 'terminal';
  /**
   * It was started by hand, not by the loop: the review's state before it was held ('none': it had none), which it
   * gets back once the agent goes on.
   */
  before?: ReviewState['state'] | 'none';
}

/** The agent the user paused or stopped on an item (to go on in its chat), if any. */
export function heldBy(review: ReviewState | undefined): HeldAgent | undefined {
  if (review?.state === 'paused' && review.paused?.byUser) return review.paused;
  if (review?.state === 'stopped' && review.stop?.kind === 'user') return review.stop.agent;
  return undefined;
}

/** Whether Flotilla's latest note about an agent says it was started (or resumed) in a terminal. */
export function startedInTerminal(entries: TicketEntry[], agent: string): boolean {
  const name = agent.replace(/[^A-Za-z0-9-]/g, '');
  const note = entries.filter((e) => e.author === 'Flotilla' && new RegExp(`chat for agent ${name}(?![A-Za-z0-9-])`).test(e.body)).at(-1);
  return !!note && /, in a terminal\b/.test(note.body);
}

export type Verdict = 'approved' | 'changes';

/** The states that wait on the user: an agent's question, work ready for the user's review, approved work, a stopped review. */
export const WAITING_STATES: readonly ReviewState['state'][] = ['asking', 'yours', 'approved', 'stopped'];

/** The review after a change: when it comes to a state that waits on the user, that's when it began waiting (now). */
export function stampWaiting(before: ReviewState | undefined, after: ReviewState, now: string): ReviewState {
  return after.state !== before?.state && WAITING_STATES.includes(after.state) ? { ...after, since: now } : after;
}

/** The folder a ticket file is in (this module is also used in webviews: no node:path). */
const folderOf = (file: string) => file.replace(/[\\/][^\\/]*$/, '');

/**
 * Why a review stopped: the implementer is busy in its chat, stopped without reporting "Ready for review", or its chat
 * is gone; the reviewer gave no verdict; too many rounds; no worktree; or the user stopped it.
 */
export type ReviewStopKind = 'busy' | 'no-report' | 'chat-gone' | 'no-verdict' | 'rounds' | 'no-worktree' | 'user' | 'runaway';

/** What the implementer is asked to do: the prompt, why (for notes), and whether only its own chat may do it. */
export interface RevisionTask {
  prompt: string;
  why: string;
  resumeOnly?: boolean;
  /** Not part of a review round (merging main into the branch, BL-55): noted as itself. */
  aside?: boolean;
}

/** How a stopped review is fixed from the ticket. */
export type ReviewFix = 'retry' | 'newAgent' | 'inChat' | 'anotherRound' | 'worktree' | 'resumeNow' | 'resume';

/** A fix's button, as fits why it stopped. */
export function fixLabel(fix: ReviewFix, kind: ReviewStopKind | undefined): string {
  switch (fix) {
    case 'retry':
      return kind === 'no-report' || kind === 'runaway' ? 'Resume It' : kind === 'busy' ? 'Try Again' : kind === 'no-verdict' || kind === 'user' || !kind ? 'Review Again' : 'Try Again';
    case 'newAgent':
      return 'New Agent';
    case 'inChat':
      return 'Give It in Its Chat';
    case 'anotherRound':
      return 'Another Round';
    case 'worktree':
      return 'Create Worktree';
    case 'resumeNow':
      return 'Go On Now';
    case 'resume':
      return 'Resume';
  }
}

/** The fixes for a stop, the first the one to offer first (held: the agent the user stopped, which can go on). */
export function fixesFor(kind: ReviewStopKind | undefined, hasTask: boolean, held?: HeldAgent): ReviewFix[] {
  if (kind === 'user' && held) return held.phase === 'review' ? ['resume', 'retry'] : ['resume', 'newAgent'];
  switch (kind) {
    case 'busy':
      return ['inChat', 'newAgent', 'retry'];
    case 'no-report':
    case 'runaway':
      return ['retry', 'newAgent'];
    case 'chat-gone':
      return ['newAgent'];
    case 'rounds':
      return ['anotherRound'];
    case 'no-worktree':
      return ['worktree'];
    case 'no-verdict':
    case 'user':
    default:
      return hasTask ? ['retry', 'newAgent'] : ['retry'];
  }
}

/** A review's verdict, from its last "Verdict: …" line. */
export function parseVerdict(body: string): Verdict | undefined {
  const lines = body.split(/\r?\n/).filter((l) => /^\s*\**\s*verdict\s*\**\s*:/i.test(l));
  const last = lines.at(-1)?.toLowerCase();
  if (!last) return undefined;
  if (/changes?\s+requested|request(ed)?\s+changes|not\s+approved|reject/.test(last)) return 'changes';
  if (/approved?|lgtm|accept/.test(last)) return 'approved';
  return undefined;
}

/** Whether an implementer's report says the work is ready for review (its last line does). */
export function saysReadyForReview(body: string): boolean {
  const last = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  return !!last && /^[*_]*ready for review[.!]?[*_]*$/i.test(last);
}

/** Whether an implementer's report asks the user something and waits for the answer (its Needs line or its last line says so). */
export function saysWaitingForUser(body: string): boolean {
  return parseReport(body).waiting;
}

/** The user's comments since the agent's last report (the answer to its question), once: none that were acted on. */
export function userAnswer(entries: TicketEntry[], review: ReviewState, key: (e: TicketEntry) => string): TicketEntry[] {
  const answer: TicketEntry[] = [];
  for (let n = entries.length - 1; n >= 0; n--) {
    const e = entries[n];
    if (e.author !== 'You') {
      if (e.author === 'Flotilla') continue;
      break;
    }
    if (review.handled?.includes(key(e))) break;
    answer.unshift(e);
  }
  return answer;
}

/** The user's review as a ticket entry's body: what they wrote, and their verdict. */
export function userReviewBody(verdict: Verdict, text: string): string {
  return [text.trim(), verdict === 'approved' ? 'Verdict: approved' : 'Verdict: changes requested'].filter(Boolean).join('\n\n');
}

/**
 * The newest report by an agent that says it's ready for review and hasn't been acted on, with its index. The
 * reviewer's own reports don't count.
 */
export function readyReport(
  entries: TicketEntry[],
  review: ReviewState | undefined,
  key: (e: TicketEntry) => string,
): { entry: TicketEntry; agent: string } | undefined {
  for (let n = entries.length - 1; n >= 0; n--) {
    const e = entries[n];
    const agent = entryAgent(e.author);
    if (!agent || sameAgent(agent, review?.reviewer)) continue;
    if (review?.handled?.includes(key(e))) return undefined;
    if (saysReadyForReview(e.body)) return { entry: e, agent };
  }
  return undefined;
}

/** The reviewer's newest report with a verdict that hasn't been acted on. */
export function verdictReport(
  entries: TicketEntry[],
  review: ReviewState,
  key: (e: TicketEntry) => string,
): { entry: TicketEntry; verdict: Verdict } | undefined {
  for (let n = entries.length - 1; n >= 0; n--) {
    const e = entries[n];
    if (!sameAgent(entryAgent(e.author), review.reviewer)) continue;
    if (review.handled?.includes(key(e))) return undefined;
    const verdict = parseVerdict(e.body);
    if (verdict) return { entry: e, verdict };
  }
  return undefined;
}

/**
 * Show rather than tell (BL-79): whatever has a shape is shown, next to the text it explains. The ticket draws Mermaid
 * blocks, shows images and GIFs, and plays videos (files next to it, up to MEDIA_LIMITS).
 */
export function showNotes(o: { id: string; backlogDir: string }): string {
  const folder = `${o.backlogDir}/${o.id}`;
  return `Show rather than tell: when the work has a shape, show it, next to the text it explains (not at the end). A flow or a sequence: a diagram, as a \`\`\`mermaid block (the ticket draws it). A structure: a tree or boxes (Mermaid, or an SVG). Before and after: two screenshots. A UI change: a short demo GIF or video (MP4 or WebM). Save files in ${folder}/ and show each with ![What it shows](${o.id}/name.svg) (.png, .gif, .mp4 and .webm the same way; videos get a player). Keep them small: images and GIFs at most 2 MB, videos at most 10 MB; larger ones aren't shown.`;
}

/**
 * How a report that hands work over for review says what to look at: in order, with links to the files (which the
 * ticket opens at their lines), and pictures where they explain better (files next to the ticket, which it shows).
 */
export function reviewNotes(o: { id: string; backlogDir: string }): string {
  return `That report says how to review the work, under a heading "#### How to review": what to look at, in the order to look at it (the files and lines that matter, what changed there and why), how to try it, and what's risky or still open. Where there's something to run or open to try the work (a build, a test window, a local page, a file), say how as a run block: a fenced code block whose info string starts with \`run\`, then an optional kind and a title. Its lines are shell commands, one after the other (the default); a shell title doesn't start with \`launch\`, \`task\` or \`open\`, which read as the kind.\`run launch <name>\` starts a debug configuration of .vscode/launch.json by name, \`run task <name>\` a task of .vscode/tasks.json, and \`run open <url or file>\` opens a URL (e.g. http://localhost:5173) or a file in the worktree. Keep it short and safe to run again: no deploys, no deleting data. Link every file you mention by its path from the repository root, with the lines: [src/api/limit.ts:42](src/api/limit.ts#L42), or #L42-L60 for a range; the ticket opens them. ${showNotes(o)}`;
}

/**
 * How an agent keeps its context small (BL-68): what it reads stays in its context and is read again on every turn,
 * which is where most of its tokens go (files and diffs above all, measured with npm run bench:tokens).
 */
export const CONTEXT_NOTES = `Keep your context small: whatever you read stays in it and is read again on every turn. Find code with grep and read only the lines you change or must check, not whole files. Ask a subagent (the Agent tool) only for broad exploration across many files: it starts with a context of its own, so it costs more than it saves for a lookup. Look at changes with \`git diff --stat\` first, then diff only the files you need. Keep command output short: while you work, run only the tests of the code you change, and the whole suite once at the end.`;

/** What the reviewer is told. Its first line names it and the item (that's how the ticket finds its chat). */
export function reviewerPrompt(o: {
  item: Pick<BacklogItem, 'id' | 'title'>;
  reviewer: string;
  implementer?: string;
  ticket: string;
  branch: string;
  base: string;
  round: number;
}): string {
  const who = o.implementer ? `${o.implementer} (another agent)` : 'another agent';
  return [
    `You are agent ${o.reviewer}, working on backlog item ${o.item.id}: "${o.item.title}". You are its reviewer.`,
    o.round === 1
      ? `${who} did the work, in this git worktree on branch ${o.branch}. Review it: read the ticket ${o.ticket} (the description and its acceptance criteria, and the "How to review" notes in its last report; earlier entries only if you need them), the changes (git diff ${o.base}...HEAD, and the commit messages), and run the tests.`
      : `Round ${o.round}: ${who} made changes after your last review (see the ticket ${o.ticket}). Review again: check that what you asked for was done, and look at the new changes (git diff ${o.base}...HEAD).`,
    CONTEXT_NOTES,
    `Run the work the way the ticket says, if you can. Its run block is the last fenced block whose info string is \`run\`, in an agent's report in the activity (if there's none, the "How to review" notes of the latest report say how to try it). The info string is \`run\`, then the kind if there is one, then a title: with no kind the block is shell commands; a block whose kind is \`launch\`, \`task\` or \`open\` is skipped. Run the shell lines that need no window (tests, a CLI, a build). If a block mixes shell lines with ones that open a window or a browser, run the window-free lines and skip the rest. Say which lines you skipped and why. Run only what the block says, and nothing that deploys or deletes data.`,
    `Don't change the code: only review. Report in the ticket: append an entry at the end of its "## Activity" section, a heading "### YYYY-MM-DD HH:MM · Agent ${o.reviewer}" (local time). Start the entry with your verdict as a line, exactly "Verdict: approved" or "Verdict: changes requested", then at most 3 lines right under it, with no blank line between (what's good, and what must change); then a blank line and the details: what must change, as a checklist, specific enough to act on; what you ran and what it gave (or why you didn't run it); and any files the run left changed in \`git status\`.`,
    `If the work changes what the user sees (the UI), the report must show it: a screenshot, before and after, or a demo GIF or video. When it doesn't, request one in your checklist.`,
    `Approve when it's good enough to merge: it does what the ticket asks, it's tested, and nothing important is wrong. Don't hold it up for matters of taste; mention those without requesting them.`,
    `Never change issue trackers (Jira, GitHub Issues), and don't push.`,
  ].join('\n\n');
}

/** What the implementer is told when the reviewer asks for changes (its chat resumed). */
export function revisionPrompt(o: { item: Pick<BacklogItem, 'id'>; reviewer: string; ticket: string; round: number }): string {
  return [
    `${o.reviewer}, an agent reviewing ${o.item.id}, requested changes (review round ${o.round}). Read its review at the end of the ticket ${o.ticket}.`,
    MAY_ASK,
    `Make the changes, commit them (messages start with "${o.item.id}: "), then report in the ticket as before, saying what you changed for each request. Report it in the same shape (a summary, then "Needs from you: nothing"), and end that report with a line "Ready for review." so it's reviewed again.`,
    reviewNotes({ id: o.item.id, backlogDir: folderOf(o.ticket) }),
    `If you disagree with a request, say why in your report instead of making the change.`,
  ].join('\n\n');
}

/** The ticket's description stays what's to be done: the implementer works the user's requests into it. */
const UPDATE_DESCRIPTION = (ticket: string) =>
  `Keep the ticket's description what's to be done: as you take up what the user asks (here, and in their answers), work it into the description in ${ticket} (between the "# Title" and "## Activity"), usually as acceptance criteria. Edit only the description there, and leave the activity as it is.`;

/** How the implementer may ask the user before (or instead of) making changes, when it needs to. */
const MAY_ASK = `If you need more context to do it well (what's asked is unclear, or there's a choice only the user can make), ask first: report in the ticket with your questions in its "Needs from you:" line, and stop without changing anything. You're resumed with the answer. Otherwise start on it directly.`;

/** What the implementer is told when the user reviewed the work and requested changes. */
export function userRevisionPrompt(o: { item: Pick<BacklogItem, 'id'>; ticket: string; feedback: string }): string {
  const feedback = o.feedback.trim();
  return [
    `The user reviewed your work on ${o.item.id} and requested changes${feedback ? ':' : ', without saying more (their review is at the end of the ticket ' + o.ticket + ').'}`,
    ...(feedback ? [feedback.replace(/^/gm, '> ')] : []),
    `Read the ticket ${o.ticket} for the context (the description, and the activity).`,
    MAY_ASK,
    UPDATE_DESCRIPTION(o.ticket),
    `Make the changes, commit them (messages start with "${o.item.id}: "), then report in the ticket, in the same shape (a summary, then "Needs from you: nothing"), saying what you changed for each request. End that report with a line "Ready for review." so the user reviews it again. If you disagree with a request, say why in your report instead of making the change.`,
    reviewNotes({ id: o.item.id, backlogDir: folderOf(o.ticket) }),
  ].join('\n\n');
}

/** What the implementer is told when the user answered its question (its chat resumed). */
export function answerPrompt(o: { item: Pick<BacklogItem, 'id'>; ticket: string; answer: string }): string {
  return [
    `The user answered you in the ticket ${o.ticket}:`,
    o.answer.trim().replace(/^/gm, '> '),
    UPDATE_DESCRIPTION(o.ticket),
    `Go on with the changes for ${o.item.id}. Commit them (messages start with "${o.item.id}: "), then report in the ticket in the same shape, ending with a line "Ready for review." If you still need to know more, ask again the same way (in its "Needs from you:" line).`,
    reviewNotes({ id: o.item.id, backlogDir: folderOf(o.ticket) }),
  ].join('\n\n');
}

/** What a paused agent is told when it goes on after Flotilla paused it to make room for another ticket. */
export function resumeAfterPausePrompt(phase: 'review' | 'work'): string {
  return phase === 'review'
    ? 'Flotilla paused you to make room for another ticket; a slot is free now. Go on with your review where you left off, and end your entry in the ticket with your verdict, as asked.'
    : 'Flotilla paused you to make room for another ticket; a slot is free now. Go on where you left off. When the work is done, report in the ticket as asked, ending with "Ready for review." (or with "Waiting for you." if you need the user).';
}

/** What an agent the user paused or stopped is told when they resume it (its chat resumed). */
export function resumeAfterUserPausePrompt(phase: 'review' | 'work'): string {
  return phase === 'review'
    ? 'The user paused you before you finished, and now resumes you. Go on with your review where you left off, and end your entry in the ticket with your verdict, as asked.'
    : 'The user paused you before you finished, maybe in the middle of an edit, and now resumes you. First run `git status` (and `git diff`) to see what you had changed and not committed yet, then go on where you left off. When the work is done, report in the ticket as asked, ending with "Ready for review." (or with "Waiting for you." if you need the user).';
}

/** What a new agent is told when it takes over from one the user stopped. */
export function takeOverPrompt(o: { stopped: string; ticket: string }): string {
  return `The user stopped ${o.stopped}, another agent, before it finished this; you take over. Its reports are in the ticket ${o.ticket}, and its work is in this worktree: its commits, and maybe changes it hadn't committed yet (run \`git status\` first). Go on from there.`;
}

/** What an agent paused on a usage limit is told when it goes on (its chat resumed). */
export function resumeAfterLimitPrompt(phase: 'review' | 'work'): string {
  return phase === 'review'
    ? "Claude's usage limit stopped you before you finished; it has reset. Go on with your review where you left off, and end your entry in the ticket with your verdict, as asked."
    : 'Claude\'s usage limit stopped you before you finished; it has reset. Go on where you left off. When the work is done, report in the ticket as asked, ending with "Ready for review." (or, if you need the user, with a "Needs from you:" line and the question).';
}

/** What an agent the autopilot starts is told, after the usual start: nobody is watching its chat. */
export const AUTOPILOT_NOTE =
  'Flotilla\'s autopilot started you: nobody is watching this chat, so the ticket is how you talk to the user. If you can\'t go on without a decision only the user can make, ask in the ticket, in your report\'s "Needs from you:" line, and stop; you\'re resumed with the answer. Otherwise decide sensibly yourself, and say what you decided in your report.';

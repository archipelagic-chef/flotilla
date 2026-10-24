import type { ChatState } from '../chats/chats';
import type { BacklogItem } from './backlog';

/**
 * A ticket's Check (BL-163): what a ticket says is going on (agents working, a review or a merge under way), each
 * checked against what's really there (processes, transcripts, temporary worktrees). A claim that holds is left alone;
 * one that doesn't is a glitch, with the cleanup that sets it right. Nothing here changes anything: see TicketChecker.
 */

/** A process, as `ps` lists it. */
export interface ProcessInfo {
  pid: number;
  args: string;
}

/** The processes in `ps -A -ww -o pid=,args=`'s output. */
export function parsePs(out: string): ProcessInfo[] {
  const list: ProcessInfo[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) list.push({ pid: Number(m[1]), args: m[2] });
  }
  return list;
}

/**
 * The process that runs a chat: Claude Code's, with the session in its command line (`--session-id <id>` or
 * `--resume <id>`, as Flotilla starts its agents and Claude Code's panel resumes a chat). Not a shell that only
 * mentions it (`grep <id>`, a command an agent runs).
 */
export function processOf(list: readonly ProcessInfo[], session: string): ProcessInfo | undefined {
  const flag = new RegExp(`(?:^|\\s)--(?:session-id|resume)[\\s=]${session.replace(/[^A-Za-z0-9-]/g, '')}(?:\\s|$)`);
  return list.find((p) => flag.test(p.args) && !NOT_CLAUDE.test(p.args.trimStart().split(/\s/)[0] ?? ''));
}

/** Programs whose command line may name a session without running it: shells and searches. */
const NOT_CLAUDE = /(?:^|[\\/])(?:sh|bash|zsh|fish|dash|grep|egrep|rg|ps|pgrep|tail|cat|less|jq)(?:\.exe)?$/;

/** How long a chat that says it's working may be quiet, with no process found, before it's a glitch. */
export const QUIET_MS = 2 * 60_000;
/** How long a running agent may write nothing to its chat, while it says it's working, before it's stuck. */
export const STUCK_MS = 30 * 60_000;

/** What a cleanup does: see TicketChecker.cleanUp. */
export type Cleanup =
  /** Its chat record says working: it's marked done (never deleted: its transcript stays). */
  | { kind: 'chat-done'; session: string; gitDirs: string[] }
  /** A stuck process: stopped (after asking), and its chat marked done. */
  | { kind: 'stop-process'; pid: number; session: string; gitDirs: string[] }
  /** A review whose agent runs nowhere: stopped, with its next step offered (Review Again, go on). */
  | { kind: 'review-lost'; phase: 'review' | 'work' }
  /** A paused agent whose chat is gone: stopped, as it can't go on. */
  | { kind: 'paused-gone' }
  /** A merge being resolved by an agent that runs nowhere: failed, with Resolve with Agent offered. */
  | { kind: 'merge-lost' }
  /** A merge whose temporary worktree is gone: its state is cleared. */
  | { kind: 'merge-gone' }
  /** A review naming a worktree that's gone or on another branch (BL-167): its `worktree` is cleared. */
  | { kind: 'review-worktree'; worktree: string }
  /** A "Creating its worktree…" record no window still creates (BL-167): removed. */
  | { kind: 'creating-stale'; dir: string; id: string }

  /** The merge queue or train names a ticket wrongly (gone, done, its branch moved): both are rebuilt (BL-166). */
  | { kind: 'queue-rebuild' }
  /** A temporary merge worktree no ticket's merge names: removed with `git worktree remove` (BL-166). */
  | { kind: 'orphan-remove'; dir: string };

export interface Claim {
  /** Unique within a ticket: Clean Up of one claim names it. */
  key: string;
  ok: boolean;
  /** "Iris-3 is working (process 4812, last activity 20 s ago)", "Orbit-2 shows as working, but …". */
  text: string;
  /** A glitch's: what Clean Up does, and the note it leaves in the activity. */
  cleanup?: Cleanup;
  /** What Clean Up does, for the user ("marks its chat done"). */
  fix?: string;
  note?: string;
  /** Clean Up asks first (it stops a process). */
  ask?: string;
}

/** A chat of the ticket's whose record says it's working, with what's known of it. */
export interface ChatFacts {
  session: string;
  agent?: string;
  /** The git dirs its record is in (where it's marked done). */
  gitDirs: string[];
  state: ChatState;
  /** Its record's or transcript's last write, whichever is later. */
  lastWrite: Date;
  process?: ProcessInfo;
  /** This window runs it (headless or in a terminal). */
  runsHere: boolean;
  /** Its transcript shows a build or a test running. */
  busy?: boolean;
}

export interface ReviewFacts {
  /** The review loop runs its agent, is starting it, or has it queued. */
  runs: boolean;
  /** The chat of the session the review's state names, if found. */
  chat?: ChatFacts;
  /** The process of that session (also when its chat isn't found). */
  process?: ProcessInfo;
  /** A paused agent's chat transcript exists (to go on in). */
  pausedChatExists?: boolean;
}

export interface MergeFacts {
  /** The merger runs its agent, or the merge (queued, its checks, its wait for CI). */
  runs: boolean;
  dirExists: boolean;
  process?: ProcessInfo;
}

/** "20 s", "6 min", "3 h", "2 days". */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} days`;
}

/** "16:10" (local), or "Oct 19 16:10" for another day. */
export function clock(d: Date, now: Date): string {
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleString('en-US', { month: 'short', day: 'numeric' })} ${hm}`;
}

const nameOf = (c: Pick<ChatFacts, 'agent' | 'session'>) => c.agent || `Chat ${c.session.slice(0, 8)}`;

/** A chat that says it's working: running (✓), ended (✗: marked done) or stuck (✗: stopped, after asking). */
export function checkChat(c: ChatFacts, now: Date): Claim {
  const name = nameOf(c);
  const quiet = now.getTime() - c.lastWrite.getTime();
  const key = `chat:${c.session}`;
  const evidence = (what: string) => `${what}, last activity ${ago(quiet)} ago`;
  if (c.process && quiet >= STUCK_MS && !c.busy) {
    return {
      key,
      ok: false,
      text: `${name}'s process ${c.process.pid} runs, but has written nothing to its chat for ${ago(quiet)}`,
      cleanup: { kind: 'stop-process', pid: c.process.pid, session: c.session, gitDirs: c.gitDirs },
      fix: 'stops it, and marks its chat done',
      ask: `${name} has written nothing for ${ago(quiet)}, though it says it's working. Stop its process (${c.process.pid})?`,
      note: `Check: ${name} showed as working, but had written nothing to its chat for ${ago(quiet)} (since ${clock(c.lastWrite, now)}); stopped its process (${c.process.pid}) and marked its chat done.`,
    };
  }
  if (c.process) return { key, ok: true, text: `${name} is working (${evidence(`process ${c.process.pid}`)})` };
  if (c.runsHere) return { key, ok: true, text: `${name} is working (${evidence('in this window')})` };
  if (c.busy) return { key, ok: true, text: `${name} is working (${evidence('a build or test runs')})` };
  if (quiet < QUIET_MS) return { key, ok: true, text: `${name} is working (${evidence('no process found yet')})` };
  return {
    key,
    ok: false,
    text: `${name} shows as working, but no process runs it (its chat was last written at ${clock(c.lastWrite, now)})`,
    cleanup: { kind: 'chat-done', session: c.session, gitDirs: c.gitDirs },
    fix: 'marks its chat done',
    note: `Check: ${name}'s chat had ended at ${clock(c.lastWrite, now)} but showed as working; marked done.`,
  };
}

/** The review's state: an agent at work (working, reviewing, revising), or paused, with its chat to go on in. */
export function checkReview(review: BacklogItem['review'], f: ReviewFacts, now: Date): Claim | undefined {
  if (!review) return undefined;
  if (review.state === 'paused') {
    const p = review.paused;
    if (!p || f.pausedChatExists !== false) return p ? { key: 'review', ok: true, text: `${p.agent} is paused, its chat there to go on in` } : undefined;
    return {
      key: 'review',
      ok: false,
      text: `${p.agent} is paused, but its chat is gone: it can't go on`,
      cleanup: { kind: 'paused-gone' },
      fix: 'stops the review, to start it again',
      note: `Check: ${p.agent} was paused, but its chat was gone; stopped the review.`,
    };
  }
  if (review.state !== 'working' && review.state !== 'reviewing' && review.state !== 'revising') return undefined;
  const reviewing = review.state === 'reviewing';
  const agent = (reviewing ? review.reviewer : review.implementer) || 'Its agent';
  const doing = reviewing ? 'reviewing' : review.state === 'revising' ? 'making the changes asked for' : 'working';
  const process = f.process ?? f.chat?.process;
  if (f.runs) return { key: 'review', ok: true, text: `${agent} is ${doing} (run by this window)` };
  if (process) return { key: 'review', ok: true, text: `${agent} is ${doing} (process ${process.pid})` };
  const quiet = f.chat ? now.getTime() - f.chat.lastWrite.getTime() : undefined;
  if (quiet !== undefined && (quiet < QUIET_MS || f.chat?.busy)) return { key: 'review', ok: true, text: `${agent} is ${doing} (last activity ${ago(quiet)} ago)` };
  const since = f.chat ? ` (its chat was last written at ${clock(f.chat.lastWrite, now)})` : '';
  return {
    key: 'review',
    ok: false,
    text: `The ticket says ${agent} is ${doing}, but it isn't running${since}`,
    cleanup: { kind: 'review-lost', phase: reviewing ? 'review' : 'work' },
    fix: reviewing ? 'stops the review, with Review Again offered' : 'stops it, with going on offered',
    note: `Check: ${agent} showed as ${doing}, but wasn't running${since}; stopped the review, to ${reviewing ? 'review again' : 'go on'} from the ticket.`,
  };
}

/** A merge under way: its temporary worktree there, and its resolving agent running. */
export function checkMerge(merging: BacklogItem['merging'], f: MergeFacts): Claim | undefined {
  if (!merging) return undefined;
  if (!f.dirExists) {
    return {
      key: 'merge',
      ok: false,
      text: `A merge of \`${merging.branch}\` is under way, but its temporary worktree is gone`,
      cleanup: { kind: 'merge-gone' },
      fix: "clears the merge's state, to merge again",
      note: `Check: the merge of \`${merging.branch}\` into \`${merging.base}\` had lost its temporary worktree; cleared its state, to merge again.`,
    };
  }
  if (merging.state !== 'resolving') return { key: 'merge', ok: true, text: `The merge of \`${merging.branch}\` waits in its temporary worktree (${merging.state})` };
  const agent = merging.agent ?? 'Its agent';
  if (f.runs) return { key: 'merge', ok: true, text: `${agent} is resolving the merge (run by this window)` };
  if (f.process) return { key: 'merge', ok: true, text: `${agent} is resolving the merge (process ${f.process.pid})` };
  if (merging.paused) return { key: 'merge', ok: true, text: `${agent} is paused resolving the merge: Resume goes on with it` };
  return {
    key: 'merge',
    ok: false,
    text: `The ticket says ${agent} is resolving the merge, but it isn't running`,
    cleanup: { kind: 'merge-lost' },
    fix: 'stops the merge where it is, with Resolve with Agent offered',
    note: `Check: ${agent} showed as resolving the merge of \`${merging.branch}\`, but wasn't running; stopped it there, to Resolve with Agent again or cancel.`,
  };
}

/** The line a ticket shows when a check on opening it found glitches: "Orbit-2 shows as working, but it isn't running". */
export function glitchLine(claims: readonly Pick<Claim, 'ok' | 'text'>[]): string | undefined {
  const bad = claims.filter((c) => !c.ok);
  if (!bad.length) return undefined;
  return bad.length === 1 ? bad[0].text : `${bad[0].text}, and ${bad.length - 1} more`;
}


import { agentChatItem, type BacklogItem } from './backlog';
import { isDiscussionChat } from './shaping';

/**
 * Ask an Agent (BL-127): an agent answers a comment of yours now, as a reply to it. Who answers, what it's told, and
 * how its comment shows while it works. Shared by the host and the webviews (no node or vscode APIs).
 */

/** A ticket's implementer: its agent and chat, where it runs, and whether it's busy (working, or asking in its chat). */
export interface Implementer {
  agent: string;
  session: string;
  cwd?: string;
  running: boolean;
}

/**
 * Who answers: the implementer, its chat resumed (it knows the work); the same, once its turn ends (wait); or a fresh
 * agent that reads the ticket (on a ticket nobody has worked on, or Answer Now), named after its discussion's agent.
 */
export type Answerer =
  { kind: 'implementer'; agent: string; session: string; cwd?: string } | { kind: 'wait'; agent: string } | { kind: 'fresh'; agent?: string };

export function whoAnswers(o: { implementer?: Implementer; now?: boolean; discussionAgent?: string }): Answerer {
  const i = o.implementer;
  if (i && !o.now)
    return i.running ? { kind: 'wait', agent: i.agent } : { kind: 'implementer', agent: i.agent, session: i.session, ...(i.cwd ? { cwd: i.cwd } : {}) };
  return { kind: 'fresh', ...(o.discussionAgent ? { agent: o.discussionAgent } : {}) };
}

/** A chat, as far as finding the implementer needs it. */
export interface ImplementerChatInfo {
  id: string;
  firstPrompt?: string;
  state: 'working' | 'waiting-for-input' | 'done' | 'ended';
  cwd?: string;
  updatedAt: Date;
  /** It went quiet without the hook saying so: it isn't running. */
  stalled?: Date;
}

/**
 * The ticket's implementer among the chats: the one its review names (by session), else the latest chat whose first
 * message started an agent on it. Discussions and the answerers of comments aren't.
 */
export function findImplementer<C extends ImplementerChatInfo>(
  chats: readonly C[],
  item: Pick<BacklogItem, 'id' | 'review'>,
): (C & { agent: string }) | undefined {
  const own = chats
    .map((c) => ({ c, who: agentChatItem(c.firstPrompt) }))
    .filter(({ c, who }) => who?.item === item.id && !isDiscussionChat(c.firstPrompt) && !isAnswerChat(c.firstPrompt));
  const session = item.review?.implementerSession;
  const pick = own.find(({ c }) => !!session && c.id === session) ?? [...own].sort((a, b) => b.c.updatedAt.getTime() - a.c.updatedAt.getTime())[0];
  return pick && { ...pick.c, agent: pick.who!.agent };
}

/** Whether a chat is busy: an agent's turn is going on in it (a stalled one isn't). */
export function chatBusy(c: Pick<ImplementerChatInfo, 'state' | 'stalled'>): boolean {
  return !c.stalled && (c.state === 'working' || c.state === 'waiting-for-input');
}

/** The first line of a fresh answerer's chat: the ticket and agent (agentChatItem reads them, so its card counts it). */
export function answerLead(item: Pick<BacklogItem, 'id' | 'title'>, agent: string): string {
  return `You are agent ${agent}, working on backlog item ${item.id}, answering a comment of its owner: "${item.title}".`;
}

/** Whether a chat's first message is a fresh answerer's (see answerLead): it isn't the ticket's implementer. */
export function isAnswerChat(firstPrompt: string | undefined): boolean {
  return /^You are agent [A-Za-z0-9-]+, working on backlog item [A-Za-z0-9_-]+, answering a comment of its owner/.test(firstPrompt?.trim() ?? '');
}

/** The comment asked about: its heading's date and author, and its text. */
export interface AskedComment {
  date: string;
  author: string;
  text: string;
}

/**
 * What the answerer is told: the comment, and that its final message is the reply (Flotilla writes it into the
 * ticket only once it's done, so a stopped run leaves nothing half-written). fresh: a new agent, which changes no code.
 */
export function askPrompt(o: { item: Pick<BacklogItem, 'id' | 'title'>; ticket: string; comment: AskedComment; fresh?: { agent: string } }): string {
  const quoted = o.comment.text
    .trim()
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  return [
    ...(o.fresh
      ? [
          answerLead(o.item, o.fresh.agent),
          `Its ticket is ${o.ticket}: Markdown with the title, the description, then an "## Activity" log of comments and reports. Read what you need of it, and of this repository's code, to answer. You change no code: no branch, no worktree, no commands that change anything. The ticket is the only file you may change.`,
        ]
      : []),
    `The owner of ${o.item.id} asks you to answer their comment in the ticket (${o.ticket}) now: the entry "### ${o.comment.date} · ${o.comment.author}" of its "## Activity" section, which says:`,
    quoted,
    `Answer it in your final message, in your own words and briefly: Flotilla writes that message into the ticket as your reply to the comment, so don't write it there yourself, and give it no heading or reply line. Then stop. Don't change code, the ticket's description or its status unless the comment asks you to; when you do change something, say what in your answer.`,
  ].join('\n\n');
}

/** How a comment asked about shows (BL-127): its answerer and what it's at. */
export interface AnswerView {
  agent: string;
  /** thinking: it works; waiting: for the implementer's turn to end; then how it ended (Retry offered). */
  state: 'thinking' | 'waiting' | 'answered' | 'stopped' | 'failed';
  /** When it started thinking (ISO 8601). */
  since?: string;
  /** What it's doing now, from its transcript ("Reading src/a.ts"). */
  now?: string;
  /** Why it failed. */
  error?: string;
}

/** The line a comment asked about shows. */
export function askLabel(a: AnswerView): string {
  switch (a.state) {
    case 'thinking':
      return `${a.agent} is thinking…`;
    case 'waiting':
      return `Waiting for ${a.agent} to finish its turn`;
    case 'answered':
      return `${a.agent} replied`;
    case 'stopped':
      return `You stopped ${a.agent}`;
    case 'failed':
      return `${a.agent} stopped without a reply${a.error ? ` (${a.error})` : ''}`;
  }
}

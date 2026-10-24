import { agentChatItem, agentLead, entryAgent, sameAgent, type BacklogItem } from './backlog';
import type { TicketEntry } from './ticket';

/**
 * Shaping (BL-45): a ticket nobody works on yet (a proposal, or To Do) is discussed with an agent in the ticket. The
 * agent talks there and writes what's agreed into the description; it changes no code. Its chat is resumed by every
 * later comment, and the ticket says when it thinks the ticket is ready to start.
 */

/** The last line of a reply that says the ticket is ready to start. */
export const READY_TO_START = 'Ready to start.';

/** Whether a reply says the ticket is ready to start: its last line is "Ready to start.". */
export function saysReadyToStart(body: string): boolean {
  const last = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  return !!last && /^[*_]*ready to start[.!]?[*_]*$/i.test(last);
}

/**
 * Whether the shaping agent's newest reply says the ticket is ready to start, with nobody having written since (a
 * comment after it means the ticket isn't settled yet).
 */
export function readyToStart(entries: TicketEntry[], agent: string): boolean {
  for (let n = entries.length - 1; n >= 0; n--) {
    const e = entries[n];
    if (e.author === 'You') return false;
    if (sameAgent(entryAgent(e.author), agent)) return saysReadyToStart(e.body);
  }
  return false;
}

/** Whether a local item can be discussed: nobody works on it (a proposal, or To Do). */
export function discussable(item: Pick<BacklogItem, 'status' | 'proposed'>): boolean {
  return !!item.proposed || item.status === 'todo';
}

/**
 * What a shaping agent may do: read and search the code, and edit its ticket, which is the only file it may change.
 * Its tool list is these; a rule limits Edit to the ticket, and whatever else is asked is refused, as nobody is there
 * to ask (see runAgentHeadless). Claude Code's rule for an absolute path is "//" and the path. Checked against the
 * CLI (2.1.296): Bash is absent, Edit of another file is refused.
 */
export function shapingTools(ticket: string): string[] {
  return ['Read', 'Grep', 'Glob', `Edit(//${ticket.replace(/^\/+/, '')})`];
}

/**
 * The rules every shaping prompt gives: what its reply is (Flotilla writes it into the ticket), what it writes in the
 * ticket, and when it says the ticket is ready.
 */
function rules(ticket: string): string[] {
  return [
    `Its ticket is ${ticket}: Markdown with the title, the description, then an "## Activity" log of comments and replies. Read it first, with any images it links (paths relative to the ticket's folder).`,
    `Your reply is your final message, and nothing else: Flotilla adds it to the end of the ticket's Activity, dated and signed with your name, after the owner's newest entry. Write it as the reply only, with no heading and no signature. Keep it short: a few lines, and questions as a short numbered list. Ask what you need to know; propose, don't assume. Don't write in the Activity yourself.`,
    `When you and the user agree on something, write it into the description (the title too, when it changes): the problem or goal, the context, and the acceptance criteria as a checklist. Where it has a shape (a flow, a sequence, a structure), show it with a \`\`\`mermaid diagram next to the text it explains (the ticket draws it). Edit the ticket with the Edit tool, change only what's agreed and leave the rest of the file as it is; never rewrite the whole file.`,
    `When this ticket builds on another's work, or reshapes the same feature as another ticket, add a line "Depends on: <its id>" to the description: the autopilot then starts it only once that one is merged. Not when they merely change the same files: tickets start from main at once, and overlapping changes are reconciled when they merge.`,
    `When you think the ticket is ready to start, first add a short "### Where to start" section at the end of the description, for the agent who'll do the work: the files and functions it touches (as links with lines, like [src/a.ts:42](src/a.ts#L42)) and the approach you agreed, so it needn't search for what you found. Then end your reply with the line "${READY_TO_START}" (only then; never "Ready for review.").`,
  ];
}

/** The first message of a shaping agent's chat: its role, and how it works in the ticket. */
export function shapingPrompt(o: { item: Pick<BacklogItem, 'id' | 'title'>; agent: string; ticket: string }): string {
  return [
    agentLead(o.item, o.agent),
    `Nobody works on this ticket yet: its owner wants to shape it with you first, in the ticket itself. Talk it through with them, read this repository's code where it helps you understand the problem, and write what's agreed into the ticket. You change no code: no branch, no worktree, no commands. The ticket is the only file you may change.`,
    ...rules(o.ticket),
  ].join('\n\n');
}

/**
 * A message to a shaping agent whose chat goes on: the owner wrote in the ticket, or opened the discussion without a
 * comment yet (opened).
 */
export function followUpPrompt(o: { ticket: string; opened: boolean }): string {
  return [
    o.opened
      ? `Its owner opened the discussion of the ticket without a comment yet: read it, and start the conversation (what's unclear, what you'd propose).`
      : `Its owner wrote in the ticket since your last reply: read the entries at the end of its "## Activity" section, and answer them in your final message.`,
    ...rules(o.ticket),
  ].join('\n\n');
}

/**
 * Discuss (BL-188): the ticket is talked through in a Claude Code chat, not in its activity. The chat's first message
 * names the ticket and says it's a discussion (see discussionLead); the agent writes what's agreed into the
 * description, and a summary into the activity when the talk ends.
 */

/** The first line of a discussion's chat: the ticket and agent (agentChatItem reads them), and that it's a discussion. */
export function discussionLead(item: Pick<BacklogItem, 'id' | 'title'>, agent: string): string {
  return `You are agent ${agent}, working on backlog item ${item.id}, discussing it with its owner: "${item.title}".`;
}

/** Whether a chat's first message is a discussion's (see discussionLead): it doesn't count as a working agent. */
export function isDiscussionChat(firstPrompt: string | undefined): boolean {
  return /^You are agent [A-Za-z0-9-]+, working on backlog item [A-Za-z0-9_-]+, discussing it with its owner/.test(firstPrompt?.trim() ?? '');
}

/** The first message of a discussion's chat: who it is, what it does in the chat and in the ticket, and how it opens. */
export function discussionPrompt(o: { item: Pick<BacklogItem, 'id' | 'title'>; agent: string; ticket: string }): string {
  return [
    discussionLead(o.item, o.agent),
    `Nobody works on this ticket yet: its owner wants to shape it with you first, in this chat. Read this repository's code where it helps you understand the problem. You change no code: no branch, no worktree, no commands that change anything. The ticket is the only file you may change.`,
    `Its ticket is ${o.ticket}: Markdown with the title, the description, then an "## Activity" log of comments and reports. Read it first, with any images it links (paths relative to the ticket's folder).`,
    `Open the conversation now, without waiting for the owner: in a few lines, what you understood the ticket is for, what you checked in the code (with links like [src/a.ts:42](src/a.ts#L42)), and your first questions as a short numbered list. Then talk it through here, as in any chat: ask what you need to know; propose, don't assume.`,
    `As you agree on things, write them into the ticket's description at once (the title too, when it changes): the goal ("**When it's done:**" first), why, and the acceptance criteria as a checklist. Where it has a shape (a flow, a sequence, a structure), show it with a \`\`\`mermaid diagram next to the text it explains. Edit only the description, and only what's agreed; leave the rest of the file as it is, never rewrite the whole file, and don't write in the Activity while you talk.`,
    `When this ticket builds on another's work, or reshapes the same feature as another ticket, add a line "Depends on: <its id>" to the description. Not when they merely change the same files.`,
    `When you think the ticket is ready to start, add a short "### Where to start" section at the end of the description, for the agent who'll do the work: the files and functions it touches (as links with lines) and the approach you agreed.`,
    `When the owner says the discussion is over, append one entry at the end of the ticket's "## Activity" section: a heading "### YYYY-MM-DD HH:MM · Agent ${o.agent}" (local time), then a short summary: "Discussed with you: agreed …; open …". When the ticket is ready to start, end it with the line "${READY_TO_START}". Then say in the chat that it's in the ticket.`,
  ].join('\n\n');
}

/** The link in a ticket's note that opens a chat ("flotilla-chat:<session>"; see TicketPanels.openHref). */
export const CHAT_LINK = 'flotilla-chat:';

/** A chat as a discussion is found among a worktree's chats. */
export interface DiscussionChatInfo {
  id: string;
  firstPrompt?: string;
  open: boolean;
  updatedAt: Date;
}

/**
 * The chat of a ticket's discussion: the one with its session, or else (its first message only just sent, the
 * session not saved yet) the newest discussion chat started for the ticket and its agent.
 */
export function findDiscussionChat<C extends DiscussionChatInfo>(
  chats: readonly C[],
  o: { id: string; agent: string; session?: string },
): C | undefined {
  if (o.session) return chats.find((c) => c.id === o.session);
  return chats
    .filter((c) => {
      const of = agentChatItem(c.firstPrompt);
      return isDiscussionChat(c.firstPrompt) && of?.item === o.id && sameAgent(of.agent, o.agent);
    })
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
}

/** Whether the discussion's agent wrote in the activity since the discussion started (since: an entry's date, "YYYY-MM-DD HH:MM"). */
export function summarizedSince(entries: TicketEntry[], agent: string, since: string): boolean {
  return entries.some((e) => sameAgent(entryAgent(e.author), agent) && e.date >= since);
}

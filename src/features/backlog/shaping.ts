import { agentLead, entryAgent, sameAgent, type BacklogItem } from './backlog';
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

/** The rules every shaping prompt gives: where it talks, what it writes, and when it says the ticket is ready. */
function rules(agent: string, ticket: string): string[] {
  return [
    `Its ticket is ${ticket}: Markdown with the title, the description, then an "## Activity" log of comments and replies. Read it first, with any images it links (paths relative to the ticket's folder).`,
    `Talk in the ticket: append each reply at the end of its "## Activity" section (add the section if it's missing), as a heading "### YYYY-MM-DD HH:MM · Agent ${agent}" (local time; sign every entry as Agent ${agent}, which links it to this chat), followed by the reply. Keep replies short: a few lines, and questions as a short numbered list. Ask what you need to know; propose, don't assume.`,
    `When you and the user agree on something, write it into the description (the title too, when it changes): the problem or goal, the context, and the acceptance criteria as a checklist. Edit the ticket with the Edit tool, change only what's agreed and leave the rest of the file as it is; never rewrite the whole file.`,
    `When you think the ticket is ready to start, end your reply with the line "${READY_TO_START}" (only then; never "Ready for review.").`,
  ];
}

/** The first message of a shaping agent's chat: its role, and how it works in the ticket. */
export function shapingPrompt(o: { item: Pick<BacklogItem, 'id' | 'title'>; agent: string; ticket: string }): string {
  return [
    agentLead(o.item, o.agent),
    `Nobody works on this ticket yet: its owner wants to shape it with you first, in the ticket itself. Talk it through with them, read this repository's code where it helps you understand the problem, and write what's agreed into the ticket. You change no code: no branch, no worktree, no commands. The ticket is the only file you may change.`,
    ...rules(o.agent, o.ticket),
  ].join('\n\n');
}

/**
 * A message to a shaping agent whose chat goes on: the owner wrote in the ticket, or opened the discussion without a
 * comment yet (opened).
 */
export function followUpPrompt(o: { agent: string; ticket: string; opened: boolean }): string {
  return [
    o.opened
      ? `Its owner opened the discussion of the ticket without a comment yet: read it, and start the conversation (what's unclear, what you'd propose).`
      : `Its owner wrote in the ticket since your last reply: read the entries at the end of its "## Activity" section, and reply there as before.`,
    ...rules(o.agent, o.ticket),
  ].join('\n\n');
}

/**
 * Discuss (BL-241): a ticket nobody works on yet is talked through in a chat in its own view, like the Ask pane (BL-80).
 * One Claude Code process per open ticket takes the owner's messages on stdin and streams its answers (stream-json both
 * ways). Its instructions are its system prompt (discussionPrompt), it may only read and edit the ticket (shapingTools),
 * and its session is kept: a later process resumes it, and the chat is read back from its transcript.
 */
import { askSettings } from './ask';
import type { AskTurn } from './ask';
import type { BacklogItem } from './backlog';
import { leanFlags } from './leanStart';
import { discussionLead } from './shaping';

/** The claude arguments of a discussion's process: streaming in and out, its session kept (new, or resumed), its tools only. */
export function discussArgs(o: {
  /** --model and --effort (choiceArgs). */
  choice: readonly string[];
  instructions: string;
  plugins: readonly string[];
  session: string;
  resume: boolean;
  /** shapingTools(ticket): their names offered, and their rules (Edit of the ticket only) allowed. */
  tools: readonly string[];
}): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    ...(o.resume ? ['--resume', o.session] : ['--session-id', o.session]),
    '--permission-mode',
    'dontAsk',
    ...o.choice,
    '--append-system-prompt',
    o.instructions,
    ...leanFlags(undefined),
    // No hooks: it isn't one of the worktree's chats (Discuss doesn't open one), and isn't handed the backlog guide.
    '--settings',
    askSettings(o.plugins),
    // Last: the lists are variadic.
    '--tools',
    [...new Set(o.tools.map((t) => t.replace(/\(.*$/, '')))].join(','),
    '--allowedTools',
    ...o.tools,
  ];
}

/** The message that starts a discussion (not shown): the agent opens the conversation. Its lead names the ticket, for its spend (transcriptSpend). */
export function discussionOpener(item: Pick<BacklogItem, 'id' | 'title'>, agent: string): string {
  return `${discussionLead(item, agent)}\n\nOpen the discussion: the owner is reading this chat.`;
}

/** What Done sends: the discussion is over, its summary goes into the activity. */
export const DISCUSSION_DONE = "We're done for now: write the summary of our discussion into the ticket's activity.";

/** The text of a transcript message's content: a string, or its text blocks (none for tool results and tool calls). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c: { type?: string; text?: unknown }) => c?.type === 'text' && typeof c.text === 'string')
    .map((c: { text: string }) => c.text)
    .join('');
}

/**
 * A kept discussion's chat, read back from its transcript (JSON lines): each of the owner's messages and the answer it
 * got (its last message with text, as a finished answer is shown). The first message is the opener, not shown.
 */
export function discussionTurns(jsonl: string): AskTurn[] {
  const turns: AskTurn[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let m: { type?: string; isMeta?: boolean; isSidechain?: boolean; message?: { content?: unknown } };
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.isMeta || m.isSidechain) continue;
    if (m.type === 'user') {
      // A tool's result is the agent's turn going on, not a message of the owner's.
      const content = m.message?.content;
      if (Array.isArray(content) && content.some((c: { type?: string }) => c?.type === 'tool_result')) continue;
      const question = textOf(content).trim();
      if (!question) continue;
      turns.push({ question, answer: '', state: 'done', ...(turns.length ? {} : { opener: true }) });
    } else if (m.type === 'assistant') {
      const text = textOf(m.message?.content);
      const turn = turns[turns.length - 1];
      if (turn && text.trim()) turn.answer = text;
    }
  }
  return turns;
}

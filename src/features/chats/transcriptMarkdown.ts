/**
 * A chat's transcript as Markdown, to read it where Claude Code's panel can't open it (an agent's chat, BL-121):
 * its prompts and replies, and its tool calls and their results folded.
 */

/** Tool inputs and results longer than this are cut (a transcript can hold whole files). */
const MAX_DETAIL = 2000;

type Part = { type?: unknown; text?: unknown; name?: unknown; input?: unknown; content?: unknown; is_error?: unknown };
interface Entry {
  type?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  timestamp?: unknown;
  message?: { content?: unknown };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cut(s: string, max = MAX_DETAIL): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s;
}

/** A fenced code block that holds s whatever backticks it contains. */
function fenced(s: string, lang = ''): string {
  const longest = Math.max(2, ...(s.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${s}\n${fence}`;
}

function folded(summary: string, body: string): string {
  return `<details><summary>${escapeHtml(summary)}</summary>\n\n${body}\n\n</details>`;
}

/** A tool call in one line: the tool and what it's for (its command, file or pattern). */
function callSummary(part: Part): string {
  const name = typeof part.name === 'string' ? part.name : 'Tool';
  const input = (part.input && typeof part.input === 'object' ? part.input : {}) as Record<string, unknown>;
  const what = ['description', 'command', 'file_path', 'pattern', 'url', 'query', 'prompt'].map((k) => input[k]).find((v) => typeof v === 'string') as string | undefined;
  return what ? `${name}: ${what.split('\n')[0]!.slice(0, 120)}` : name;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Part[]).map((p) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : p?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
}

function parts(content: unknown): Part[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as Part[]).filter((p) => p && typeof p === 'object') : [];
}

/** Renders a transcript (JSON lines) as Markdown, under a heading with its title. */
export function transcriptMarkdown(raw: string, title: string): string {
  const out: string[] = [`# ${title}`];
  let speaker: 'user' | 'assistant' | undefined;
  const say = (who: 'user' | 'assistant', block: string) => {
    if (speaker !== who) out.push(who === 'user' ? '## You' : '## Claude');
    speaker = who;
    out.push(block);
  };
  for (const line of raw.split('\n')) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (entry.isSidechain === true || (entry.type !== 'user' && entry.type !== 'assistant')) continue;
    for (const part of parts(entry.message?.content)) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        if (entry.type === 'assistant') say('assistant', part.text);
        else if (entry.isMeta !== true) say('user', part.text.split('\n').map((l) => `> ${l}`).join('\n'));
      } else if (part.type === 'tool_use') {
        say('assistant', folded(callSummary(part), fenced(cut(JSON.stringify(part.input ?? {}, null, 2)), 'json')));
      } else if (part.type === 'tool_result') {
        // A tool's result comes back in a user line, but is part of Claude's turn.
        const text = resultText(part.content);
        out.push(folded(part.is_error === true ? 'Failed' : 'Result', text ? fenced(cut(text)) : '_(no output)_'));
      }
    }
  }
  if (out.length === 1) out.push('_This chat has no messages yet._');
  return `${out.join('\n\n')}\n`;
}

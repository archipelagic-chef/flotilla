/**
 * Run blocks: how an agent says to try its work, as a fenced block with the info string `run` (BL-19):
 *
 *   ```run Build and open a test window
 *   npm run build
 *   ```
 *
 *   ```run launch Run Extension
 *   ```
 *
 * Kinds: shell (the default: commands, run one after the other), launch and task (by name), open (a URL, or a file of
 * the worktree), demo (a recorded demo of the worktree played again live: `run demo <name>`, BL-78). Only the entries
 * agents and Flotilla write count (not descriptions, nor comments from others).
 */
import { entryAgent } from './backlog';
import type { TicketEntry } from './ticket';

export type RunKind = 'shell' | 'launch' | 'task' | 'open' | 'demo';

export interface RunBlock {
  kind: RunKind;
  /** The text after the kind: the title, or for launch and task the name of the configuration or task, for demo the demo's. */
  title?: string;
  /** The block's lines, without the blank ones: commands for shell, the URL or file for open. */
  lines: string[];
}

/** Where a run block is: its entry (by key), and its place among that entry's blocks. */
export interface RunBlockRef {
  key: string;
  index: number;
  kind: RunKind;
  title?: string;
}

const KINDS: readonly string[] = ['shell', 'launch', 'task', 'open', 'demo'];
const OPENING = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSING = /^ {0,3}(`{3,}|~{3,})\s*$/;
const RUN = /^run(?:\s+(.*))?$/;
/**
 * How the Markdown renderer emits a fenced block with the info string `run` (its first word is the language). VS Code's
 * renderer adds attributes to the `<pre>` (a class, `data-line`, `dir`) and may add classes to the `<code>`.
 */
const RENDERED_RUN = /<pre\b[^>]*><code\b[^>]*\bclass="[^"]*\blanguage-run\b[^"]*"[^>]*>([\s\S]*?)<\/code><\/pre>/g;

/** Whether an entry's author is one whose run blocks count: an agent, or Flotilla. */
export function isReport(author: string): boolean {
  return !!entryAgent(author) || author.toLowerCase() === 'agent' || author === 'Flotilla';
}

/**
 * The run blocks in a Markdown text, in order. A fence that isn't closed runs to the end, as Markdown renders it, so
 * a block that isn't closed counts too; a fence that isn't a run block is skipped whole, so its lines aren't read.
 */
export function parseRunBlocks(markdown: string): RunBlock[] {
  const blocks: RunBlock[] = [];
  let open: { fence: string; info: string; body: string[] } | undefined;
  const finish = (info: string, body: string[]) => {
    const run = RUN.exec(info.trim());
    if (!run) return;
    const words = (run[1] ?? '').trim();
    const first = /^(\S+)\s*(.*)$/.exec(words);
    const named = !!first && KINDS.includes(first[1]);
    const kind = named ? (first[1] as RunKind) : 'shell';
    const title = (named ? first[2] : words).trim() || undefined;
    blocks.push({ kind, title, lines: body.map((l) => l.trim()).filter(Boolean) });
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (!open) {
      const m = OPENING.exec(line);
      // A backtick fence's info string has no backticks; otherwise the line is text.
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) open = { fence: m[1], info: m[2], body: [] };
      continue;
    }
    const end = CLOSING.exec(line);
    if (end && end[1][0] === open.fence[0] && end[1].length >= open.fence.length) {
      finish(open.info, open.body);
      open = undefined;
      continue;
    }
    open.body.push(line);
  }
  if (open) finish(open.info, open.body);
  return blocks;
}

/** A run block with its place: its entry (by key), and its index among that entry's blocks. */
export interface PlacedRunBlock {
  key: string;
  index: number;
  block: RunBlock;
}

/** The run blocks of a ticket's reports, in order. `key` names an entry (its key in the ticket). */
export function placedRunBlocks(entries: readonly TicketEntry[], key: (entry: TicketEntry) => string): PlacedRunBlock[] {
  return entries.flatMap((e) => (isReport(e.author) ? parseRunBlocks(e.body).map((block, index) => ({ key: key(e), index, block })) : []));
}

/** The block a reference names (an entry's key and index), or the last one without a reference; undefined if it's gone. */
export function pickRunBlock(blocks: readonly PlacedRunBlock[], ref?: { key: string; index: number }): PlacedRunBlock | undefined {
  return ref ? blocks.find((b) => b.key === ref.key && b.index === ref.index) : blocks[blocks.length - 1];
}

/** What a run block runs, as its button's tooltip says it: "Run npm run build", "Launch Run Extension", "Open http://…". */
export function runLabel(run: Pick<RunBlock, 'kind' | 'title' | 'lines'>): string {
  const first = run.lines[0];
  switch (run.kind) {
    case 'shell':
      return `Run ${run.title ?? first ?? 'its commands'}`;
    case 'launch':
      return `Launch ${run.title ?? 'its debug configuration'}`;
    case 'task':
      return `Run task ${run.title ?? 'its task'}`;
    case 'open':
      return `Open ${first ?? run.title ?? 'its link'}`;
    case 'demo':
      return `Play the demo ${run.title ?? ''}`.trim();
  }
}

/** A demo's file in its worktree (demos/<name>.json), or undefined when the name isn't one (it mustn't be a path). */
export function demoPath(name: string | undefined): string | undefined {
  return name && /^[\w-]+$/.test(name) ? `demos/${name}.json` : undefined;
}

/** What a demo block runs in its worktree's terminal: the repository's demo player (npm run demo, scripts/demo.mjs). */
export function demoCommand(name: string): string {
  return `npm run demo -- play ${name}`;
}

/** The ticket's run: the last run block of its reports (the Run buttons run it), or undefined if none. */
export function latestRun(entries: readonly TicketEntry[], key: (entry: TicketEntry) => string): RunBlockRef | undefined {
  const last = pickRunBlock(placedRunBlocks(entries, key));
  if (!last) return undefined;
  const { kind, title } = last.block;
  return { key: last.key, index: last.index, kind, ...(title ? { title } : {}) };
}

/**
 * An entry's rendered Markdown, with a Run button on each of its run blocks (`key`: the entry's key, which the button
 * sends back with the block's index; `first`: the index of the first block, for a part of an entry). The buttons only go in when the rendered code blocks are as many as the blocks
 * parsed, so that a button is never on the wrong block; otherwise the html is as it was.
 */
export function withRunButtons(html: string, blocks: readonly RunBlock[], key: string, first = 0): string {
  if (!blocks.length || [...html.matchAll(RENDERED_RUN)].length !== blocks.length) return html;
  let index = 0;
  return html.replace(RENDERED_RUN, (_m, code: string) => {
    const at = index++;
    const block = blocks[at];
    const label = `${block.kind === 'shell' ? 'commands' : block.kind}${block.title ? ` · ${block.title}` : ''}`;
    const commands = block.lines.length ? `<pre><code>${code}</code></pre>` : '';
    return (
      `<div class="run-block">` +
      `<div class="run-head"><span class="run-label">${escapeHtml(label)}</span>` +
      `<button class="button secondary run-button" data-run-key="${escapeHtml(key)}" data-run-index="${first + at}" ` +
      `title="Runs this block in the ticket's worktree, after asking">Run</button></div>` +
      `${commands}</div>`
    );
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

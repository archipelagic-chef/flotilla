/**
 * The formatting toolbar of the Markdown boxes (BL-129): what a button does to the text and its selection. Each
 * wraps the selection or inserts at the cursor, and takes the formatting off when it's already there. Jira's
 * descriptions are written in Jira's own markup, so the same buttons write that.
 */

export type Format = 'bold' | 'italic' | 'code' | 'codeBlock' | 'link' | 'bullets' | 'numbers' | 'quote' | 'mention';
export type Markup = 'markdown' | 'jira';

/** Replaces from..to with insert, then selects selStart..selEnd (in the new text). */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
  selStart: number;
  selEnd: number;
}

const INLINE: Record<Markup, Record<'bold' | 'italic' | 'code', [string, string]>> = {
  markdown: { bold: ['**', '**'], italic: ['_', '_'], code: ['`', '`'] },
  jira: { bold: ['*', '*'], italic: ['_', '_'], code: ['{{', '}}'] },
};

const FENCE: Record<Markup, [string, string]> = { markdown: ['```', '```'], jira: ['{code}', '{code}'] };

// A line's list or quote mark, in either markup.
const LINE_MARK: Record<Markup, Record<'bullets' | 'numbers' | 'quote', RegExp>> = {
  markdown: { bullets: /^[-*+] /, numbers: /^\d+[.)] /, quote: /^> ?/ },
  jira: { bullets: /^\*+ /, numbers: /^#+ /, quote: /^bq\. / },
};

const URL = /^https?:\/\/\S+$/i;

/** What the button (or its key) does to text, whose selection is start..end. */
export function formatEdit(text: string, start: number, end: number, format: Format, markup: Markup = 'markdown', mention = ''): TextEdit {
  switch (format) {
    case 'bold':
    case 'italic':
    case 'code':
      return wrap(text, start, end, ...INLINE[markup][format]);
    case 'codeBlock':
      return codeBlock(text, start, end, markup);
    case 'link':
      return link(text, start, end, markup);
    case 'bullets':
    case 'numbers':
    case 'quote':
      return lines(text, start, end, format, markup);
    case 'mention': {
      // Before the selection (a number becomes BL-102), after a space when it follows a word.
      const insert = start > 0 && /\S/.test(text[start - 1]) ? ` ${mention}` : mention;
      return { from: start, to: start, insert, selStart: start + insert.length, selEnd: end + insert.length };
    }
  }
}

/** A URL pasted over selected text links it; undefined for any other paste. */
export function pasteLink(text: string, start: number, end: number, pasted: string, markup: Markup = 'markdown'): TextEdit | undefined {
  const url = pasted.trim();
  const selected = text.slice(start, end);
  if (start === end || !URL.test(url) || URL.test(selected.trim()) || selected.includes('\n')) return undefined;
  const insert = markup === 'jira' ? `[${selected}|${url}]` : `[${selected}](${url})`;
  return { from: start, to: end, insert, selStart: start + insert.length, selEnd: start + insert.length };
}

function wrap(text: string, start: number, end: number, open: string, close: string): TextEdit {
  const selected = text.slice(start, end);
  // Marked inside the selection: unwrapped.
  if (selected.length >= open.length + close.length && selected.startsWith(open) && selected.endsWith(close)) {
    const inner = selected.slice(open.length, selected.length - close.length);
    return { from: start, to: end, insert: inner, selStart: start, selEnd: start + inner.length };
  }
  // Marked around it (or the cursor between empty marks): the marks go.
  if (text.slice(start - open.length, start) === open && text.slice(end, end + close.length) === close && !isDoubled(text, start, end, open, close)) {
    return { from: start - open.length, to: end + close.length, insert: selected, selStart: start - open.length, selEnd: end - open.length };
  }
  return { from: start, to: end, insert: open + selected + close, selStart: start + open.length, selEnd: end + open.length };
}

// Italic's "_" next to "__", or bold's "*" inside Jira's "**": a different mark, not this one.
function isDoubled(text: string, start: number, end: number, open: string, close: string): boolean {
  if (open.length !== 1) return false;
  return text[start - open.length - 1] === open && text[end + close.length] === close;
}

function link(text: string, start: number, end: number, markup: Markup): TextEdit {
  const selected = text.slice(start, end);
  const linked = markup === 'jira' ? /^\[([^\]|]*)\|[^\]]*\]$/.exec(selected) : /^\[([^\]]*)\]\([^)]*\)$/.exec(selected);
  if (linked) return { from: start, to: end, insert: linked[1], selStart: start, selEnd: start + linked[1].length };
  const url = URL.test(selected.trim());
  const label = url ? 'text' : selected || 'text';
  const target = url ? selected.trim() : 'url';
  const insert = markup === 'jira' ? `[${label}|${target}]` : `[${label}](${target})`;
  // The part still to fill in is selected: the address after a label, the label after an address.
  const at = url || !selected ? start + 1 : start + 1 + label.length + (markup === 'jira' ? 1 : 2);
  const length = url || !selected ? label.length : target.length;
  return { from: start, to: end, insert, selStart: at, selEnd: at + length };
}

function codeBlock(text: string, start: number, end: number, markup: Markup): TextEdit {
  const [open, close] = FENCE[markup];
  const selected = text.slice(start, end);
  const fenced = new RegExp(`^${escape(open)}[^\\n]*\\n([\\s\\S]*?)\\n?${escape(close)}$`).exec(selected);
  if (fenced) return { from: start, to: end, insert: fenced[1], selStart: start, selEnd: start + fenced[1].length };
  // On lines of its own.
  const before = start > 0 && text[start - 1] !== '\n' ? '\n' : '';
  const after = end < text.length && text[end] !== '\n' ? '\n' : '';
  const body = selected.replace(/\n$/, '');
  const insert = `${before}${open}\n${body}\n${close}${after}`;
  const at = start + before.length + open.length + 1;
  return { from: start, to: end, insert, selStart: at, selEnd: at + body.length };
}

function lines(text: string, start: number, end: number, format: 'bullets' | 'numbers' | 'quote', markup: Markup): TextEdit {
  // The whole lines the selection touches (a selection ending at a line's start leaves that line out).
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const next = text.indexOf('\n', last);
  const to = next === -1 ? text.length : next;
  const rows = text.slice(from, to).split('\n');
  const mark = LINE_MARK[markup][format];
  const filled = rows.filter((r) => r.trim());
  const off = filled.length > 0 && filled.every((r) => mark.test(r));
  // Any list or quote mark is replaced: a bulleted list becomes numbered.
  const marks = Object.values(LINE_MARK[markup]);
  const bare = (r: string) => marks.reduce((s, m) => s.replace(m, ''), r);
  let n = 0;
  const prefix = () => {
    n++;
    if (format === 'numbers') return markup === 'jira' ? '# ' : `${n}. `;
    if (format === 'bullets') return markup === 'jira' ? '* ' : '- ';
    return markup === 'jira' ? 'bq. ' : '> ';
  };
  const out = off ? rows.map((r) => r.replace(mark, '')) : rows.map((r) => (r.trim() || rows.length === 1 ? prefix() + bare(r) : r));
  const insert = out.join('\n');
  // The cursor alone stays where it was in its line's text; a selection becomes the lines.
  if (start === end && rows.length === 1) {
    const shift = insert.length - rows[0].length;
    const at = Math.max(from, start + shift);
    return { from, to, insert, selStart: at, selEnd: at };
  }
  return { from, to, insert, selStart: from, selEnd: from + insert.length };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

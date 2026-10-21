import { describe, expect, it } from 'vitest';
import { formatEdit, pasteLink, type Format, type Markup, type TextEdit } from '../../../src/webview/ticket/format';

/** Applies a format to text whose selection is marked with « and » (or a cursor, |); returns it marked the same way. */
function apply(marked: string, format: Format, markup: Markup = 'markdown', mention = 'BL-'): string {
  return show(read(marked), (t, s, e) => formatEdit(t, s, e, format, markup, mention));
}

function read(marked: string): { text: string; start: number; end: number } {
  const cursor = marked.indexOf('|');
  if (!marked.includes('«')) return { text: marked.replace('|', ''), start: cursor, end: cursor };
  const start = marked.indexOf('«');
  const end = marked.indexOf('»') - 1;
  return { text: marked.slice(0, start) + marked.slice(start + 1, end + 1) + marked.slice(end + 2), start, end };
}

function show({ text, start, end }: { text: string; start: number; end: number }, edit: (t: string, s: number, e: number) => TextEdit | undefined): string {
  const e = edit(text, start, end);
  if (!e) return 'unchanged';
  const out = text.slice(0, e.from) + e.insert + text.slice(e.to);
  return e.selStart === e.selEnd
    ? `${out.slice(0, e.selStart)}|${out.slice(e.selStart)}`
    : `${out.slice(0, e.selStart)}«${out.slice(e.selStart, e.selEnd)}»${out.slice(e.selEnd)}`;
}

describe('formatEdit: inline marks', () => {
  it('wraps the selection, and inserts marks around the cursor', () => {
    expect(apply('a «word» b', 'bold')).toBe('a **«word»** b');
    expect(apply('a «word» b', 'italic')).toBe('a _«word»_ b');
    expect(apply('a «word» b', 'code')).toBe('a `«word»` b');
    expect(apply('a | b', 'bold')).toBe('a **|** b');
  });

  it('toggles off: marks around the selection, inside it, or empty around the cursor', () => {
    expect(apply('a **«word»** b', 'bold')).toBe('a «word» b');
    expect(apply('a «**word**» b', 'bold')).toBe('a «word» b');
    expect(apply('a **|** b', 'bold')).toBe('a | b');
    expect(apply('a _«word»_ b', 'italic')).toBe('a «word» b');
  });

  it("doesn't take italic's mark from a bold one", () => {
    expect(apply('a __«word»__ b', 'italic')).toBe('a ___«word»___ b');
  });

  it("writes Jira's markup", () => {
    expect(apply('a «word» b', 'bold', 'jira')).toBe('a *«word»* b');
    expect(apply('a «word» b', 'code', 'jira')).toBe('a {{«word»}} b');
    expect(apply('a {{«word»}} b', 'code', 'jira')).toBe('a «word» b');
  });
});

describe('formatEdit: links', () => {
  it('links the selection and selects the address to fill in', () => {
    expect(apply('see «the docs» now', 'link')).toBe('see [the docs](«url») now');
    expect(apply('see | now', 'link')).toBe('see [«text»](url) now');
  });

  it('takes a selected address as the target and selects the label', () => {
    expect(apply('«https://x.io»', 'link')).toBe('[«text»](https://x.io)');
  });

  it('unlinks a selected link, and writes Jira links', () => {
    expect(apply('«[docs](https://x.io)»', 'link')).toBe('«docs»');
    expect(apply('«docs»', 'link', 'jira')).toBe('[docs|«url»]');
    expect(apply('«[docs|https://x.io]»', 'link', 'jira')).toBe('«docs»');
  });
});

describe('formatEdit: code blocks', () => {
  it('fences the selection on lines of its own, and unfences it', () => {
    expect(apply('run «npm test» now', 'codeBlock')).toBe('run \n```\n«npm test»\n```\n now');
    expect(apply('|', 'codeBlock')).toBe('```\n|\n```');
    expect(apply('«```\nnpm test\n```»', 'codeBlock')).toBe('«npm test»');
    expect(apply('«x»', 'codeBlock', 'jira')).toBe('{code}\n«x»\n{code}');
  });
});

describe('formatEdit: lists and quotes', () => {
  it('marks every line the selection touches, skipping empty ones', () => {
    expect(apply('«one\ntwo\n\nthree»', 'bullets')).toBe('«- one\n- two\n\n- three»');
    expect(apply('«one\ntwo»', 'numbers')).toBe('«1. one\n2. two»');
    expect(apply('a\nb«c\nd»e\nf', 'quote')).toBe('a\n«> bc\n> de»\nf');
  });

  it('marks the line at the cursor, keeping the cursor in its text', () => {
    expect(apply('fi|rst', 'bullets')).toBe('- fi|rst');
    expect(apply('|', 'bullets')).toBe('- |');
  });

  it('toggles off, and turns one kind of list into another', () => {
    expect(apply('«- one\n- two»', 'bullets')).toBe('«one\ntwo»');
    expect(apply('- fi|rst', 'bullets')).toBe('fi|rst');
    expect(apply('«- one\n- two»', 'numbers')).toBe('«1. one\n2. two»');
  });

  it("writes Jira's markup", () => {
    expect(apply('«one\ntwo»', 'numbers', 'jira')).toBe('«# one\n# two»');
    expect(apply('«one»', 'quote', 'jira')).toBe('«bq. one»');
  });
});

describe('formatEdit: mentions', () => {
  it('inserts the prefix at the cursor, after a space when it follows a word', () => {
    expect(apply('see|', 'mention')).toBe('see BL-|');
    expect(apply('see |', 'mention')).toBe('see BL-|');
    expect(apply('see «102»', 'mention')).toBe('see BL-«102»');
  });
});

describe('pasteLink', () => {
  const paste = (marked: string, pasted: string) => show(read(marked), (t, s, e) => pasteLink(t, s, e, pasted));

  it('links the selected text to a pasted address', () => {
    expect(paste('see «the docs»', ' https://x.io/a?b=1 ')).toBe('see [the docs](https://x.io/a?b=1)|');
  });

  it('leaves other pastes alone: no selection, not an address, or an address selected', () => {
    expect(paste('see |', 'https://x.io')).toBe('unchanged');
    expect(paste('see «docs»', 'some text')).toBe('unchanged');
    expect(paste('see «https://old.io»', 'https://x.io')).toBe('unchanged');
  });
});

/**
 * Markdown (as people and agents write tickets) to Jira wiki markup (as Jira's API v2 takes comments and
 * descriptions). Covers what tickets use: headings, emphasis, code, links, lists, task lists, quotes, rules, tables.
 * Images that only exist next to the local ticket can't go along; they become a note.
 */
export function markdownToJira(markdown: string): string {
  const out: string[] = [];
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Code blocks pass through untouched.
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      out.push(fence[2] ? `{code:${fence[2]}}` : '{code}', ...body, '{code}');
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push(`h${heading[1].length}. ${inline(heading[2])}`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('----');
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      out.push(`bq. ${inline(quote[1])}`);
      continue;
    }
    // Lists: two spaces (or a tab) of indent per level; Jira repeats the marker instead.
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const depth = Math.floor(item[1].replace(/\t/g, '  ').length / 2) + 1;
      const marker = /\d/.test(item[2]) ? '#' : '*';
      const task = /^\[([ xX])\]\s+(.*)$/.exec(item[3]);
      const text = task ? `${task[1] === ' ' ? '☐' : '☑'} ${task[2]}` : item[3];
      out.push(`${marker.repeat(depth)} ${inline(text)}`);
      continue;
    }
    // Tables: the header row gets ||, the |---| separator goes.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line)) continue;
      const cells = line
        .trim()
        .slice(1, -1)
        .split('|')
        .map((c) => inline(c.trim()));
      const header = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(lines[i + 1] ?? '');
      out.push(header ? `||${cells.join('||')}||` : `|${cells.join('|')}|`);
      continue;
    }
    out.push(inline(line));
  }
  return out.join('\n');
}

/** Inline Markdown: code, images, links, bold, italics, strikethrough. */
function inline(text: string): string {
  // Code spans first, kept out of the other rules.
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_m, code: string) => `\u0000${codes.push(code) - 1}\u0000`);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt: string, src: string) =>
    /^https?:/.test(src) ? `!${src}!` : `(image: ${alt || src.split('/').pop()})`,
  );
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, label: string, url: string) => `[${label}|${url}]`);
  // Bold (** or __) and italics (* or _), through placeholders so bold's * isn't read as italics.
  s = s.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '\u0001$2\u0001');
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)/g, '$1_$2_');
  s = s.replace(/\u0001/g, '*');
  s = s.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '-$1-');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => `{{${codes[Number(n)]}}}`);
}

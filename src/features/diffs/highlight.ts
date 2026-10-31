import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import type { DiffHunk, DiffToken } from '../../webview/ticketProtocol';

// Only these languages are bundled (BL-208), not highlight.js with every grammar.
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
};

/** A side's text longer than this isn't highlighted: the panel stays quick, and the lines show plain. */
const MAX_HIGHLIGHT_CHARS = 500_000;

/** The language a file's code is highlighted in, from its extension; undefined for others and for none. */
export function languageOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? BY_EXTENSION[name.slice(dot + 1).toLowerCase()] : undefined;
}

/**
 * Each line of text highlighted in language, as its tokens: highlighted as a whole, so a line inside a multi-line
 * comment or string is coloured as one. A token's kind is highlight.js's scope (keyword, string, title…), the
 * innermost one it's in; plain text has none.
 */
export function highlightLines(text: string, language: string): DiffToken[][] {
  return htmlLines(hljs.highlight(text, { language, ignoreIllegals: true }).value);
}

/** highlight.js's HTML split back into lines of tokens, its spans carried across the line breaks. */
function htmlLines(html: string): DiffToken[][] {
  const lines: DiffToken[][] = [[]];
  const scopes: (string | undefined)[] = [];
  const push = (text: string) => {
    if (!text) return;
    const kind = scopes[scopes.length - 1];
    const line = lines[lines.length - 1];
    const last = line[line.length - 1];
    if (last && last.kind === kind) last.text += text;
    else line.push(kind ? { text, kind } : { text });
  };
  for (const m of html.matchAll(/<span class="([^"]*)">|<\/span>|([^<]+)/g)) {
    if (m[1] !== undefined) scopes.push(scopeOf(m[1]) ?? scopes[scopes.length - 1]);
    else if (m[2] === undefined) scopes.pop();
    else {
      const parts = unescape(m[2]).split('\n');
      parts.forEach((part, i) => {
        if (i) lines.push([]);
        push(part);
      });
    }
  }
  return lines;
}

/** "hljs-title function_" → "title"; classes without the prefix (language-xml) aren't a scope. */
function scopeOf(classes: string): string | undefined {
  return /(?:^|\s)hljs-([\w-]+)/.exec(classes)?.[1];
}

function unescape(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#x27);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'" })[e] ?? _);
}

/**
 * The hunks' lines given their tokens, in path's language (BL-208): each hunk's old side (context and deleted lines)
 * and new side (context and added lines) highlighted as a whole, a deleted line taking the old side's tokens, the
 * others the new side's. Hunks in an unknown language, or too long, are left plain.
 */
export function highlightHunks(path: string, hunks: DiffHunk[]): DiffHunk[] {
  const language = languageOf(path);
  if (!language) return hunks;
  return hunks.map((h) => {
    const oldSide = h.lines.filter((l) => l.kind !== 'added');
    const newSide = h.lines.filter((l) => l.kind !== 'deleted');
    const oldTokens = side(
      oldSide.map((l) => l.text),
      language,
    );
    const newTokens = side(
      newSide.map((l) => l.text),
      language,
    );
    if (!oldTokens && !newTokens) return h;
    let o = 0;
    let n = 0;
    const lines = h.lines.map((l) => {
      const tokens = l.kind === 'deleted' ? oldTokens?.[o++] : newTokens?.[n++];
      if (l.kind === 'context') o++;
      return tokens ? { ...l, tokens } : l;
    });
    return { ...h, lines };
  });
}

function side(texts: string[], language: string): DiffToken[][] | undefined {
  if (!texts.length) return undefined;
  const text = texts.join('\n');
  return text.length > MAX_HIGHLIGHT_CHARS ? undefined : highlightLines(text, language);
}

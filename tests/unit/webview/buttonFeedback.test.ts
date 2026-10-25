import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * BL-118: a button whose action the host works on shows it's working (an ActionButton, act, a BusyButton) from the
 * click until the host's done. A plain send in a click is only for what's instant: opening something (a ticket, a chat,
 * a file, a link, a view) that shows its result, or copying.
 */
const INSTANT = new Set([
  // Opening things: they show their result.
  'openChange',
  'expandChange',
  'openTicketChange',
  'backToTicket',
  'openChat',
  'openCommit',
  'openFile',
  'openHref',
  'openLink',
  'openRemote',
  'openSite',
  'openTicket',
  'openUrl',
  'openView',
  'openWorktree',
  'mergeChecksTerminal',
  'ciShow',
  'backlog:open',
  'backlog:comment',
  'backlog:demo',
  'note:open',
  // Opening a prompt or a form of VS Code's: the user goes on there.
  'backlog:new',
  'note:new',
  'backlog:integrations',
  'ci:signIn',
  'copy',
  'copyText',
  // Its spinner comes from the host's view (the CI's "starting").
  'runWorkflow',
]);

const root = join(__dirname, '../../../src/webview');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.tsx') ? [join(dir, e.name)] : [],
  );
}

/** The handler of each onClick and onSelect in a file: the balanced braces' text after it. */
function handlers(source: string): Array<{ line: number; code: string }> {
  const out: Array<{ line: number; code: string }> = [];
  for (const m of source.matchAll(/\b(onClick=\{|onSelect: )/g)) {
    const start = m.index! + m[0].length;
    let depth = m[0].endsWith('{') ? 1 : 0;
    let end = start;
    // onSelect: up to the end of the property (a comma or a brace closing at its depth).
    for (; end < source.length; end++) {
      const c = source[end];
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') {
        if (depth === 0) break;
        if (--depth === 0 && m[0].endsWith('{')) break;
      } else if (c === ',' && depth === 0) break;
    }
    out.push({ line: source.slice(0, m.index).split('\n').length, code: source.slice(start, end) });
  }
  return out;
}

/** Every send in a click, as "file:line type[:op]". */
function plainSends(): string[] {
  return files(root).flatMap((file) =>
    handlers(readFileSync(file, 'utf8'))
      .flatMap(({ line, code }) =>
        [...code.matchAll(/\bsend\(\{\s*type: '(\w+)'(?:, op: '(\w+)')?/g)].map((s) => ({
          at: `${relative(root, file)}:${line}`,
          kind: s[2] ? `${s[1]}:${s[2]}` : s[1],
        })),
      )
      .map((s) => `${s.at} ${s.kind}`),
  );
}

describe('buttons without feedback (BL-118)', () => {
  it('finds the sends in clicks (the scan works)', () => {
    expect(plainSends().some((s) => s.endsWith(' openTicket'))).toBe(true);
  });

  it('has none: every click the host works on is an ActionButton, act or a BusyButton', () => {
    const slow = plainSends().filter((s) => !INSTANT.has(s.slice(s.lastIndexOf(' ') + 1)));
    expect(slow, 'Use ActionButton or act (the ticket), BusyButton or act (the backlog), or add an instant one to INSTANT').toEqual([]);
  });
});

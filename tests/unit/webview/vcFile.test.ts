import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { vcFileContext, vcFileDiffOf } from '../../../src/webview/vcFile';

type Menu = { command: string; when: string };
const menus = (JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8')) as { contributes: { menus: { 'webview/context': Menu[] } } })
  .contributes.menus['webview/context'];

/** The when clauses these menus use: `&&` of `key == 'value'`, `key` and `!key`. */
function holds(when: string, context: Record<string, unknown>): boolean {
  return when.split('&&').every((term) => {
    const t = term.trim();
    const eq = /^(\w+) == '([^']*)'$/.exec(t);
    if (eq) return context[eq[1]] === eq[2];
    if (/^!\w+$/.test(t)) return !context[t.slice(1)];
    if (/^\w+$/.test(t)) return !!context[t];
    throw new Error(`Unexpected when clause: ${t}`);
  });
}

/** The commands a right-click on a row with that context shows. */
function shown(section: string, fields: Record<string, unknown>): string[] {
  const context = { webviewId: 'flotilla.sidebar', webviewSection: section, ...fields };
  return menus.filter((m) => m.when.includes(`webviewSection == '${section}'`) && holds(m.when, context)).map((m) => m.command);
}

const commit = { type: 'openCommit', key: 'wt', hash: 'abc123', path: 'src/a.ts' } as const;

describe('vcFileContext', () => {
  it('passes the row’s worktree, path and diff to the commands', () => {
    expect(vcFileContext('wt', { path: 'src/a.ts', kind: 'modified' }, commit, ';ctx;')).toEqual({
      key: 'wt',
      path: 'src/a.ts',
      onDisk: true,
      diff: commit,
      flotillaWs: ';ctx;',
    });
  });

  it('shows Open Changes, Open File and Reveal in Explorer View for a file on disk', () => {
    expect(shown('vcFile', vcFileContext('wt', { path: 'src/a.ts', kind: 'added' }, commit))).toEqual([
      'flotilla.openVcFileChanges',
      'flotilla.openFile',
      'flotilla.revealInExplorer',
    ]);
  });

  it('shows only Open Changes for a deleted file, or a comparison no worktree has checked out', () => {
    expect(shown('vcFile', vcFileContext('wt', { path: 'src/a.ts', kind: 'deleted' }, commit))).toEqual(['flotilla.openVcFileChanges']);
    const compare = { type: 'openCompare', base: 'main', head: 'v1', path: 'src/a.ts' } as const;
    const context = vcFileContext(undefined, { path: 'src/a.ts', kind: 'modified' }, compare);
    expect(context).not.toHaveProperty('key');
    expect(shown('vcFile', context)).toEqual(['flotilla.openVcFileChanges']);
  });

  it('leaves the menu under Changes as it was', () => {
    expect(shown('change', { key: 'wt', path: 'a.ts', group: 'unstaged', discardable: true })).toEqual([
      'flotilla.openFileDiff',
      'flotilla.openFile',
      'flotilla.revealInExplorer',
      'flotilla.stage',
      'flotilla.discard',
    ]);
  });
});

describe('vcFileDiffOf', () => {
  it('takes the diffs a row’s click sends, and nothing else', () => {
    expect(vcFileDiffOf({ key: 'wt', diff: commit })).toBe(commit);
    const ticket = { type: 'openTicketChange', id: 'BL-1', group: 0, path: 'a.ts' };
    expect(vcFileDiffOf({ diff: ticket })).toBe(ticket);
    expect(vcFileDiffOf({ diff: { type: 'move', from: {}, to: {} } })).toBeUndefined();
    expect(vcFileDiffOf({ key: 'wt' })).toBeUndefined();
    expect(vcFileDiffOf(undefined)).toBeUndefined();
  });
});

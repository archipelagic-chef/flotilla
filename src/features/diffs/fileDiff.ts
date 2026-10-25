import * as fs from 'node:fs';
import * as path from 'node:path';
import { runGit } from '../../core/git/gitCli';
import { WORKING } from '../../core/diff/refs';
import type { ChangedFile, DiffHunk, DiffLine, FileDiff } from '../../webview/ticketProtocol';

export type { DiffHunk, DiffLine, FileDiff };

/** More changed lines than this, and a file's diff isn't shown inline: the diff editor is the place for it. */
export const MAX_INLINE_LINES = 2000;

/**
 * A file's diff between left and right (WORKING: its worktree's files, uncommitted changes and all) in dir, as the
 * ticket's Changes shows it inline (BL-171): its hunks with 3 lines of context. Read from git without touching the index.
 */
export async function fileDiff(dir: string, file: ChangedFile, left: string, right: string): Promise<FileDiff> {
  if (file.binary) return { note: 'A binary file: its diff shows only in the diff editor.' };
  const changed = file.added + file.deleted;
  if (changed > MAX_INLINE_LINES) return { note: `${changed.toLocaleString('en-US')} changed lines: too many to show here.` };
  if (file.kind === 'untracked') {
    const text = await fs.promises.readFile(path.join(dir, file.path), 'utf8');
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return { hunks: lines.length ? [{ oldStart: 0, newStart: 1, lines: lines.map((t, i) => ({ kind: 'added', text: t, new: i + 1 })) }] : [] };
  }
  const paths = file.origPath ? [file.origPath, file.path] : [file.path];
  const out = await runGit(['diff', '--no-color', '--no-ext-diff', '-U3', '-M', left, ...(right === WORKING ? [] : [right]), '--', ...paths], { cwd: dir });
  const hunks = parseHunks(out);
  if (!hunks.length) return { note: file.kind === 'renamed' ? 'Renamed, its lines unchanged.' : 'No lines changed.' };
  return { hunks };
}

/** The hunks of a unified diff (git diff's output), with each line's numbers on either side. */
export function parseHunks(out: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | undefined;
  let old = 0;
  let next = 0;
  for (const line of out.split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) {
      old = Number(m[1]);
      next = Number(m[2]);
      hunk = { oldStart: old, newStart: next, lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const text = line.slice(1);
    let l: DiffLine | undefined;
    if (line[0] === ' ') l = { kind: 'context', text, old: old++, new: next++ };
    else if (line[0] === '+') l = { kind: 'added', text, new: next++ };
    else if (line[0] === '-') l = { kind: 'deleted', text, old: old++ };
    // Anything else ends the hunk: "\ No newline at end of file", the next file's header.
    if (l) hunk.lines.push(l);
    else if (line[0] !== '\\') hunk = undefined;
  }
  return hunks;
}

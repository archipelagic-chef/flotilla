import { runGit } from '../../core/git/gitCli';
import { commitChanges } from '../history/log';
import type {
  ChangedFile,
  FileDiff,
} from '../../webview/ticketProtocol';
import {
  fileDiff,
  WHOLE_FILE,
} from './fileDiff';
import { parseNumstat } from './ticketChange';

/**
 * A file as one commit changed it (BL-213), against the commit's first parent, all of the file: the file is found by
 * either of its paths (its name before a rename too). A note when the commit doesn't change it.
 */
export async function commitFileDiff(cwd: string, hash: string, paths: readonly string[]): Promise<{ file?: ChangedFile; diff: FileDiff }> {
  const { changes, parent } = await commitChanges(cwd, hash);
  const change = changes.find((c) => paths.includes(c.path) || (c.origPath !== undefined && paths.includes(c.origPath)));
  if (!change) return { diff: { note: "This commit doesn't change it." } };
  const both = change.origPath ? [change.origPath, change.path] : [change.path];
  const counts = parseNumstat(await runGit(['diff', '--numstat', '-z', '-M', parent, hash, '--', ...both], { cwd })).get(change.path);
  const file: ChangedFile = { ...change, ...(counts ?? { added: 0, deleted: 0 }) };
  return { file, diff: await fileDiff(cwd, file, parent, hash, WHOLE_FILE) };
}

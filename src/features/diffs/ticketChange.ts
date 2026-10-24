import * as fs from 'node:fs';
import * as path from 'node:path';
import { runGit } from '../../core/git/gitCli';
import { parseNameStatus, type FileChange } from '../../core/git/porcelain';
import { WORKING } from '../../core/diff/refs';
import { withTempIndex } from './compare';
import type { ChangedFile, ChangeGroup, TicketChange } from '../../webview/ticketProtocol';

export type { ChangedFile, ChangeGroup, TicketChange };

/** What the change of a ticket is read from: its own branches (with the worktree each is checked out in), and its merge. */
export interface TicketChangeInput {
  /** The ticket's id: its own commits' messages start with "<id>: ". */
  id: string;
  /** What its work merges into (main). */
  base: string;
  branches: ReadonlyArray<{ branch: string; worktree?: string }>;
  merged?: { commit: string; into: string };
}

/** git's empty tree: the parent side of a root commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const short = (hash: string) => hash.slice(0, 7);

/**
 * The ticket's change: what its work changes compared with main, read from git without touching any index.
 *
 * - Work on its branches (in progress, in review): each branch against its merge base with main, a branch checked
 *   out in a worktree with its uncommitted changes (marked), one group per branch.
 * - Else, merged: the latest merge commit (merged.commit, or the merge under the fixes on top of it) against its first
 *   parent.
 * - Else (a merge that recorded no commit, a branch deleted): the ticket's own commits on main ("<id>: …") combined.
 *
 * Commits that only mention the ticket elsewhere don't count.
 */
export async function ticketChange(cwd: string, o: TicketChangeInput): Promise<TicketChange> {
  const branches = (await Promise.all(o.branches.map((b) => branchGroup(cwd, o.base, b).catch(() => undefined)))).filter(
    (g): g is ChangeGroup => !!g && g.files.length > 0,
  );
  if (branches.length) return summarize('work', branches);
  const merged = o.merged && (await mergedGroup(cwd, o.id, o.merged).catch(() => undefined));
  if (merged) return summarize('merged', [merged]);
  const commits = await commitsGroup(cwd, o.id, o.base).catch(() => undefined);
  if (commits?.files.length) return summarize('commits', [commits]);
  return { stage: 'none', groups: [], files: 0, added: 0, deleted: 0 };
}

function summarize(stage: TicketChange['stage'], groups: ChangeGroup[]): TicketChange {
  return {
    stage,
    groups,
    files: groups.reduce((n, g) => n + g.files.length, 0),
    added: groups.reduce((n, g) => n + g.added, 0),
    deleted: groups.reduce((n, g) => n + g.deleted, 0),
  };
}

function group(g: Omit<ChangeGroup, 'added' | 'deleted' | 'uncommitted'>): ChangeGroup {
  const files = [...g.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    ...g,
    files,
    added: files.reduce((n, f) => n + f.added, 0),
    deleted: files.reduce((n, f) => n + f.deleted, 0),
    uncommitted: files.filter((f) => f.uncommitted).length,
  };
}

const baseName = (base: string) => base.replace(/^origin\//, '');

/** A branch against its merge base with base; checked out in a worktree, its working tree (uncommitted changes marked). */
async function branchGroup(cwd: string, base: string, b: { branch: string; worktree?: string }): Promise<ChangeGroup | undefined> {
  const tip = (await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${b.branch}^{commit}`], { cwd })).trim();
  const mergeBase = (await runGit(['merge-base', base, tip], { cwd })).trim();
  const compared = `${b.branch} against ${baseName(base)} where it branched off (${short(mergeBase)})`;
  const dir = b.worktree;
  if (!dir || !fs.existsSync(dir)) {
    const files = await diffFiles(cwd, [mergeBase, tip]);
    return group({ label: b.branch, branch: b.branch, dir: cwd, left: mergeBase, right: tip, compared, files });
  }
  const files = await withTempIndex(dir, async (env) => {
    const [tracked, uncommitted, untracked] = await Promise.all([
      diffFiles(dir, [mergeBase], env),
      runGit(['diff', '--name-only', '-z', 'HEAD'], { cwd: dir, env }).then((out) => new Set(out.split('\0').filter(Boolean))),
      runGit(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: dir, env }).then((out) => out.split('\0').filter(Boolean)),
    ]);
    const marked = tracked.map((f) => (uncommitted.has(f.path) || (f.origPath && uncommitted.has(f.origPath)) ? { ...f, uncommitted: true as const } : f));
    const added = await Promise.all(untracked.map(async (p) => ({ path: p, kind: 'untracked' as const, uncommitted: true as const, ...(await countLines(path.join(dir, p))) })));
    return [...marked, ...added];
  });
  return group({ label: b.branch, branch: b.branch, dir, left: mergeBase, right: WORKING, compared: `${compared}, with its uncommitted changes`, files });
}

/** The latest merge: from merged.commit down its first parents, past the ticket's fixes on top, to the merge commit. */
async function mergedGroup(cwd: string, id: string, merged: { commit: string; into: string }): Promise<ChangeGroup | undefined> {
  const log = await runGit(['log', '--first-parent', '-n', '50', '--format=%H%x09%P%x09%s', merged.commit, '--'], { cwd });
  const own = ownSubject(id);
  let fixes = 0;
  for (const line of log.split('\n').filter(Boolean)) {
    const [hash, parents, subject] = line.split('\t');
    const ps = parents.split(' ').filter(Boolean);
    if (ps.length >= 2) {
      // Another ticket's merge: this one's was a fast-forward.
      if (!subject.toLowerCase().startsWith(`merge ${id.toLowerCase()}:`)) return undefined;
      const right = log.split('\n')[0].split('\t')[0];
      const files = await diffFiles(cwd, [ps[0], right]);
      const onTop = fixes ? `, with the ${fixes === 1 ? 'fix' : `${fixes} fixes`} on top of it` : '';
      return group({ label: `merged into ${baseName(merged.into)}`, dir: cwd, left: ps[0], right, compared: `the merge ${short(hash)} into ${baseName(merged.into)}${onTop}, against its first parent`, files });
    }
    if (!own(subject)) return undefined;
    fixes++;
  }
  return undefined;
}

/** "BL-12: …", the ticket's own commits (the commit hook's prefix), not those that only mention it. */
function ownSubject(id: string): (subject: string) => boolean {
  const prefix = `${id.toLowerCase()}:`;
  return (subject) => subject.toLowerCase().startsWith(prefix);
}

/**
 * The ticket's own commits on base, combined: each file from before the first of them that touches it to the last.
 * Commits of others in between show too, but only in the files the ticket's commits touch.
 */
async function commitsGroup(cwd: string, id: string, base: string): Promise<ChangeGroup | undefined> {
  const own = ownSubject(id);
  const log = await runGit(['log', '--no-merges', '--reverse', '-n', '500', '-F', '-i', `--grep=${id}:`, '--format=%H%x09%P%x09%s', base, '--'], { cwd });
  const commits = log
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .filter(([, , subject]) => own(subject ?? ''))
    .map(([hash, parents]) => ({ hash, parent: parents.split(' ').filter(Boolean)[0] ?? EMPTY_TREE }));
  if (!commits.length) return undefined;
  const changes = await Promise.all(commits.map((c) => runGit(['diff', '--name-status', '-z', '-M', c.parent, c.hash], { cwd }).then(parseNameStatus)));
  const files = combine(commits.map((c, i) => ({ ...c, changes: changes[i] })));
  // The counts from each file's first side to its last: files with the same two sides in one git call.
  const pairs = new Map<string, Array<(typeof files)[number]>>();
  for (const f of files) pairs.set(`${f.left} ${f.right}`, [...(pairs.get(`${f.left} ${f.right}`) ?? []), f]);
  const counted: ChangedFile[] = [];
  for (const list of pairs.values()) {
    const { left, right } = list[0];
    const counts = parseNumstat(await runGit(['diff', '--numstat', '-z', '-M', left, right, '--', ...list.flatMap((f) => (f.origPath ? [f.origPath, f.path] : [f.path]))], { cwd }));
    for (const f of list) counted.push({ ...f, ...(counts.get(f.path) ?? { added: 0, deleted: 0 }) });
  }
  const n = commits.length;
  return group({
    label: `${n} commit${n === 1 ? '' : 's'} of ${id}`,
    dir: cwd,
    left: commits[0].parent,
    right: commits[n - 1].hash,
    compared: `${id}'s own ${n === 1 ? 'commit' : `${n} commits`} on ${baseName(base)}, combined (it was merged without a merge commit)`,
    files: counted,
  });
}

type Combined = FileChange & { left: string; right: string };

/** The files of commits (oldest first) as one change: renames followed, a file added then deleted gone. */
export function combine(commits: ReadonlyArray<{ hash: string; parent: string; changes: readonly FileChange[] }>): Combined[] {
  const files = new Map<string, Combined>();
  for (const c of commits) {
    for (const ch of c.changes) {
      if (ch.kind === 'renamed' && ch.origPath) {
        const prev = files.get(ch.origPath);
        files.delete(ch.origPath);
        if (!prev) files.set(ch.path, { path: ch.path, origPath: ch.origPath, kind: 'renamed', left: c.parent, right: c.hash });
        else if (prev.kind === 'added') files.set(ch.path, { path: ch.path, kind: 'added', left: prev.left, right: c.hash });
        else files.set(ch.path, { path: ch.path, origPath: prev.origPath ?? ch.origPath, kind: 'renamed', left: prev.left, right: c.hash });
        continue;
      }
      const prev = files.get(ch.path);
      if (!prev) {
        files.set(ch.path, { path: ch.path, kind: ch.kind, left: c.parent, right: c.hash });
      } else if (ch.kind === 'deleted') {
        if (prev.kind === 'added') files.delete(ch.path);
        else files.set(ch.path, { ...prev, kind: 'deleted', right: c.hash });
      } else {
        files.set(ch.path, { ...prev, kind: prev.kind === 'deleted' ? 'modified' : prev.kind, right: c.hash });
      }
    }
  }
  return [...files.values()];
}

/** A diff's files with their line counts (name-status and numstat, joined by path). */
async function diffFiles(cwd: string, refs: string[], env?: Record<string, string>): Promise<ChangedFile[]> {
  const [names, counts] = await Promise.all([
    runGit(['diff', '--name-status', '-z', '-M', ...refs, '--'], { cwd, env }).then(parseNameStatus),
    runGit(['diff', '--numstat', '-z', '-M', ...refs, '--'], { cwd, env }).then(parseNumstat),
  ]);
  return names.map((f) => ({ ...f, ...(counts.get(f.path) ?? { added: 0, deleted: 0 }) }));
}

/** `git diff --numstat -z`: lines added and deleted by path (the new path of a rename); binary files have no counts. */
export function parseNumstat(out: string): Map<string, { added: number; deleted: number; binary?: true }> {
  const result = new Map<string, { added: number; deleted: number; binary?: true }>();
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i]);
    if (!m) continue;
    let p = m[3];
    if (p === '') {
      p = tokens[i + 2] ?? '';
      i += 2;
    }
    const binary = m[1] === '-';
    result.set(p, { added: binary ? 0 : Number(m[1]), deleted: binary ? 0 : Number(m[2]), ...(binary ? { binary: true as const } : {}) });
  }
  return result;
}

const COUNT_LIMIT = 2 * 1024 * 1024;

/** An untracked file's lines (all added); a binary or very large one isn't counted. */
async function countLines(file: string): Promise<{ added: number; deleted: number; binary?: true }> {
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > COUNT_LIMIT) return { added: 0, deleted: 0, binary: true };
    const data = await fs.promises.readFile(file);
    if (data.includes(0)) return { added: 0, deleted: 0, binary: true };
    let lines = 0;
    for (const byte of data) if (byte === 10) lines++;
    if (data.length && data[data.length - 1] !== 10) lines++;
    return { added: lines, deleted: 0 };
  } catch {
    return { added: 0, deleted: 0 };
  }
}

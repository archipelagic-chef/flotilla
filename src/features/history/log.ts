import { runGit } from '../../core/git/gitCli';
import { parseNameStatus, type FileChange } from '../../core/git/porcelain';
import { idMatcher, type RefMoves } from '../backlog/refresh';
import type { CommitView } from '../../webview/protocol';

const FIELD = '\x1f';
const RECORD = '\x1e';
const FORMAT = ['%H', '%h', '%P', '%an', '%aI', '%D', '%s', '%b'].join('%x1f') + '%x1e';
/** At most this many outgoing commits are marked; more than that is unusual and the marks are only a hint. */
const OUTGOING_LIMIT = 1000;

export function parseLog(out: string): Omit<CommitView, 'outgoing'>[] {
  return out
    .split(RECORD)
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.length)
    .map((r) => {
      const [hash, short, parents, author, date, refs, subject, body] = r.split(FIELD);
      return {
        hash,
        short,
        parents: parents ? parents.split(' ') : [],
        author,
        date,
        refs: refs
          ? refs
              .split(', ')
              .map((x) => x.replace(/^HEAD -> /, ''))
              .filter((x) => x && x !== 'HEAD')
          : [],
        subject,
        body: (body ?? '').trim(),
      };
    });
}

/** Commits on HEAD that aren't pushed: not on the upstream, or, for an unpublished branch, on no remote. */
async function outgoing(cwd: string, upstream: string | undefined, hasRemote: boolean): Promise<Set<string>> {
  const not = upstream ? ['@{upstream}'] : hasRemote ? ['--remotes'] : undefined;
  if (!not) return new Set();
  try {
    const out = await runGit(['rev-list', '-n', String(OUTGOING_LIMIT), 'HEAD', '--not', ...not], { cwd });
    return new Set(out.split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

/** A page of the worktree's history, newest first; more tells whether older commits follow. */
export async function readLog(
  cwd: string,
  opts: { skip: number; limit: number; upstream: string | undefined; hasRemote: boolean },
): Promise<{ commits: CommitView[]; more: boolean }> {
  const [out, ahead] = await Promise.all([
    runGit(
      [
        '-c',
        'log.showSignature=false',
        'log',
        `--format=${FORMAT}`,
        '--decorate=short',
        `--skip=${opts.skip}`,
        '-n',
        String(opts.limit + 1),
        'HEAD',
        '--',
      ],
      { cwd },
    ),
    outgoing(cwd, opts.upstream, opts.hasRemote),
  ]);
  const commits = parseLog(out).map((c) => ({ ...c, outgoing: ahead.has(c.hash) }));
  return { commits: commits.slice(0, opts.limit), more: commits.length > opts.limit };
}

/** The empty tree, to diff a root commit against. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** The files a commit changed, against its first parent; the ref to show their old versions from. */
export async function commitChanges(cwd: string, hash: string): Promise<{ changes: FileChange[]; parent: string }> {
  const parents = (await runGit(['rev-list', '--parents', '-n', '1', hash, '--'], { cwd })).trim().split(' ').slice(1);
  const parent = parents[0] ?? EMPTY_TREE;
  const changes = parseNameStatus(await runGit(['diff', '--name-status', '-z', '-M', parent, hash, '--'], { cwd }));
  return { changes, parent };
}

/** A commit linked to a ticket: on one of its branches, or mentioning it (or a linked issue) in its message. */
export interface TicketCommit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  /** ISO 8601. */
  date: string;
  /** The ticket's branches it's on (not yet on the base). */
  branches: string[];
}

/** The refs' tips (HEAD included), by name. One git process. */
async function readRefs(cwd: string): Promise<Map<string, string>> {
  // The same refs as `log --all --exclude=refs/flotilla/*` reads.
  const out = await runGit(['show-ref', '--head'], { cwd }).catch(() => '');
  const refs = new Map<string, string>();
  for (const line of out.split('\n')) {
    const m = /^(\S+) (.+)$/.exec(line);
    if (m && !m[2].startsWith('refs/flotilla/')) refs.set(m[2], m[1]);
  }
  return refs;
}

const keyOf = (refs: ReadonlyMap<string, string>): string => [...refs].map(([name, sha]) => `${sha} ${name}`).join('\n');

/** Refs read recently, shared by the tickets of one refresh (each git process costs; a refresh asks for many). */
const recentRefs = new Map<string, { at: number; refs: Promise<Map<string, string>> }>();
const REFS_SHARE_MS = 1000;

/** The refs as read in the last second when `fresh` isn't asked for. */
function refsOf(cwd: string, fresh: boolean): Promise<Map<string, string>> {
  const known = recentRefs.get(cwd);
  if (!fresh && known && Date.now() - known.at < REFS_SHARE_MS) return known.refs;
  const refs = readRefs(cwd);
  recentRefs.set(cwd, { at: Date.now(), refs });
  return refs;
}

/** The mention index: the commits read for the refs of one key (what the tickets' ids are looked for in). */
interface MentionIndex {
  key: string;
  refs: Map<string, string>;
  commits: Promise<Array<Omit<CommitView, 'outgoing'>>>;
}

/** One index per repository, shared by every ticket: a ticket's commits are looked up in memory, not in git. */
const mentionIndexes = new Map<string, MentionIndex>();

/** Every commit of the repository's refs (not Flotilla's own), newest first; read again only when a ref moved. */
async function mentionable(cwd: string): Promise<Array<Omit<CommitView, 'outgoing'>>> {
  const refs = await refsOf(cwd, false);
  const key = keyOf(refs);
  const cached = mentionIndexes.get(cwd);
  if (cached?.key === key) return cached.commits;
  const commits = runGit(['-c', 'log.showSignature=false', 'log', '--exclude=refs/flotilla/*', '--all', `--format=${FORMAT}`, '--'], { cwd })
    .then(parseLog)
    .catch(() => []);
  const index: MentionIndex = { key, refs, commits };
  mentionIndexes.set(cwd, index);
  // A failed read (it comes back empty) is tried again at the next look.
  void commits.then((c) => {
    if (!c.length && mentionIndexes.get(cwd) === index) mentionIndexes.delete(cwd);
  });
  return commits;
}

/**
 * What moved since the mention index was read (fresh read of the refs), or undefined when nothing did: the local
 * branches whose tips moved, and the commits that came in (the index is brought up to date).
 */
export async function movesSince(cwd: string): Promise<RefMoves | undefined> {
  // Read now, not shared: a change a moment ago must not be missed.
  const refs = await refsOf(cwd, true);
  const index = mentionIndexes.get(cwd);
  if (index?.key === keyOf(refs)) return undefined;
  const before = index?.refs ?? new Map<string, string>();
  const branches = [...new Set([...refs.keys(), ...before.keys()])]
    .filter((name) => name.startsWith('refs/heads/') && refs.get(name) !== before.get(name))
    .map((name) => name.slice('refs/heads/'.length));
  if (!index) return { branches, commits: [] };
  const known = new Set((await index.commits).map((c) => c.hash));
  const commits = (await mentionable(cwd)).filter((c) => !known.has(c.hash));
  return { branches, commits };
}

/**
 * The commits whose message mentions one of the ids, newest first. Whole ids only: "BL-1" doesn't match "BL-12"; the
 * match is case-insensitive.
 */
export async function mentioningCommits(cwd: string, ids: string[], limit: number): Promise<Array<Omit<CommitView, 'outgoing'>>> {
  if (!ids.length) return [];
  const mentioned = idMatcher(ids);
  const found: Array<Omit<CommitView, 'outgoing'>> = [];
  for (const c of await mentionable(cwd)) {
    if (mentioned(`${c.subject}\n${c.body}`)) found.push(c);
    if (found.length === limit) break;
  }
  return found;
}

/**
 * The commits linked to a ticket, newest first: those on its branches that the base doesn't have, and those anywhere
 * whose message mentions one of ids (the ticket's, its linked issues').
 */
export async function ticketCommits(cwd: string, opts: { branches: string[]; base?: string; ids: string[]; limit: number }): Promise<TicketCommit[]> {
  const log = (args: string[]) =>
    runGit(['-c', 'log.showSignature=false', 'log', `--format=${FORMAT}`, '-n', String(opts.limit), ...args], { cwd })
      .then(parseLog)
      .catch(() => []);
  const not = opts.base ? ['--not', opts.base] : [];
  const [onBranches, mentions] = await Promise.all([
    Promise.all(opts.branches.map(async (b) => ({ branch: b, commits: await log([`refs/heads/${b}`, ...not, '--']) }))),
    // Histories kept from clean-ups aren't the work anymore: they show as the ticket's versions (versionCommits).
    mentioningCommits(cwd, opts.ids, opts.limit),
  ]);
  const byHash = new Map<string, TicketCommit>();
  const add = (c: Pick<TicketCommit, 'hash' | 'short' | 'subject' | 'author' | 'date'>, branch?: string) => {
    const known = byHash.get(c.hash) ?? { hash: c.hash, short: c.short, subject: c.subject, author: c.author, date: c.date, branches: [] };
    if (branch && !known.branches.includes(branch)) known.branches.push(branch);
    byHash.set(c.hash, known);
  };
  for (const { branch, commits } of onBranches) commits.forEach((c) => add(c, branch));
  mentions.forEach((c) => add(c));
  return [...byHash.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, opts.limit);
}

/** The commits of a history kept from a clean-up (from where it started to its tip), newest first. */
export async function versionCommits(cwd: string, base: string, tip: string, limit: number): Promise<TicketCommit[]> {
  const commits = await runGit(['-c', 'log.showSignature=false', 'log', `--format=${FORMAT}`, '-n', String(limit), `${base}..${tip}`, '--'], { cwd })
    .then(parseLog)
    .catch(() => []);
  return commits.map((c) => ({ hash: c.hash, short: c.short, subject: c.subject, author: c.author, date: c.date, branches: [] }));
}

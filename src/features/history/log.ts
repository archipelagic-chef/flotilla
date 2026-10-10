import { runGit } from '../../core/git/gitCli';
import { parseNameStatus, type FileChange } from '../../core/git/porcelain';
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

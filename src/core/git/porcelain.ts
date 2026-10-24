export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface FileChange {
  path: string;
  origPath?: string;
  kind: ChangeKind;
  /** A folder of untracked files summarised as one entry (see summariseUntracked): how many files it holds. */
  files?: number;
}

export interface StatusBranch {
  oid?: string;
  head?: string;
  upstream?: string;
  ahead: number;
  behind: number;
}

/** Splits s into at most n parts; the last part keeps the remainder (paths may contain spaces). */
function splitN(s: string, sep: string, n: number): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let k = 0; k < n - 1; k++) {
    const idx = s.indexOf(sep, start);
    if (idx < 0) break;
    parts.push(s.slice(start, idx));
    start = idx + 1;
  }
  parts.push(s.slice(start));
  return parts;
}

function kindFromXY(xy: string): ChangeKind {
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('A')) return 'added';
  return 'modified';
}

/** Kind of one side (index or worktree) of a status entry; undefined when that side is unchanged ('.'). */
function kindFromCode(code: string): ChangeKind | undefined {
  switch (code) {
    case '.':
      return undefined;
    case 'A':
    case 'C':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    default:
      return 'modified';
  }
}

export interface StatusResult {
  branch: StatusBranch;
  /** One entry per path, combining index and worktree state. */
  changes: FileChange[];
  /** Changes in the index (HEAD ↔ index). */
  staged: FileChange[];
  /** Changes in the worktree (index ↔ files), including untracked and conflicted files. */
  unstaged: FileChange[];
}

export function parseStatusV2(out: string): StatusResult {
  const branch: StatusBranch = { ahead: 0, behind: 0 };
  const changes: FileChange[] = [];
  const staged: FileChange[] = [];
  const unstaged: FileChange[] = [];
  const addSides = (xy: string, p: string) => {
    const x = kindFromCode(xy[0]);
    const y = kindFromCode(xy[1]);
    if (x) staged.push({ path: p, kind: x });
    if (y) unstaged.push({ path: p, kind: y });
  };
  const records = out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec === '') continue;
    if (rec.startsWith('# ')) {
      const [key, ...rest] = rec.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') branch.oid = value === '(initial)' ? undefined : value;
      else if (key === 'branch.head') branch.head = value === '(detached)' ? undefined : value;
      else if (key === 'branch.upstream') branch.upstream = value;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          branch.ahead = Number(m[1]);
          branch.behind = Number(m[2]);
        }
      }
      continue;
    }
    const type = rec[0];
    if (type === '1') {
      const parts = splitN(rec, ' ', 9);
      changes.push({ path: parts[8], kind: kindFromXY(parts[1]) });
      addSides(parts[1], parts[8]);
    } else if (type === '2') {
      const parts = splitN(rec, ' ', 10);
      const origPath = records[++i];
      const kind: ChangeKind = parts[8].startsWith('C') ? 'added' : 'renamed';
      changes.push({ path: parts[9], origPath, kind });
      staged.push({ path: parts[9], origPath, kind });
      const y = kindFromCode(parts[1][1]);
      if (y) unstaged.push({ path: parts[9], kind: y });
    } else if (type === 'u') {
      const parts = splitN(rec, ' ', 11);
      changes.push({ path: parts[10], kind: 'conflicted' });
      unstaged.push({ path: parts[10], kind: 'conflicted' });
    } else if (type === '?') {
      changes.push({ path: rec.slice(2), kind: 'untracked' });
      unstaged.push({ path: rec.slice(2), kind: 'untracked' });
    }
  }
  return { branch, changes, staged, unstaged };
}

export function parseNameStatus(out: string): FileChange[] {
  const tokens = out.split('\0');
  const result: FileChange[] = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i++];
    if (!status) continue;
    const c = status[0];
    if (c === 'R' || c === 'C') {
      const origPath = tokens[i++];
      const p = tokens[i++];
      result.push({ path: p, origPath, kind: c === 'R' ? 'renamed' : 'added' });
    } else {
      const p = tokens[i++];
      result.push({ path: p, kind: c === 'A' ? 'added' : c === 'D' ? 'deleted' : 'modified' });
    }
  }
  return result;
}

export function sumNumstat(out: string): { added: number; deleted: number } {
  const tokens = out.split('\0');
  let added = 0;
  let deleted = 0;
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i]);
    if (!m) continue;
    if (m[1] !== '-') added += Number(m[1]);
    if (m[2] !== '-') deleted += Number(m[2]);
    if (m[3] === '') i += 2;
  }
  return { added, deleted };
}

/** From this many untracked files on, those in a folder are listed as the folder (status.showUntrackedFiles=all). */
export const UNTRACKED_SUMMARY_AT = 1000;

/**
 * Lists the untracked files of each top-level folder as one entry ("node_modules/", with its count) when there are
 * thousands, so a worktree whose .gitignore is gone doesn't send ten thousand rows to the sidebar.
 */
export function summariseUntracked(status: StatusResult): StatusResult {
  if (status.unstaged.filter((c) => c.kind === 'untracked').length < UNTRACKED_SUMMARY_AT) return status;
  const summarise = (list: FileChange[]): FileChange[] => {
    const folders = new Map<string, FileChange>();
    const result: FileChange[] = [];
    for (const c of list) {
      const slash = c.path.indexOf('/');
      if (c.kind !== 'untracked' || slash < 0) {
        result.push(c);
        continue;
      }
      const folder = c.path.slice(0, slash + 1);
      const entry = folders.get(folder);
      const files = c.files ?? 1;
      if (entry) entry.files! += files;
      else {
        const summary: FileChange = { path: folder, kind: 'untracked', files };
        folders.set(folder, summary);
        result.push(summary);
      }
    }
    return result;
  };
  return { ...status, changes: summarise(status.changes), unstaged: summarise(status.unstaged) };
}

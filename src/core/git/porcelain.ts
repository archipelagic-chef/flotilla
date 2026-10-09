export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface FileChange {
  path: string;
  origPath?: string;
  kind: ChangeKind;
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

export function parseStatusV2(out: string): { branch: StatusBranch; changes: FileChange[] } {
  const branch: StatusBranch = { ahead: 0, behind: 0 };
  const changes: FileChange[] = [];
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
    } else if (type === '2') {
      const parts = splitN(rec, ' ', 10);
      const origPath = records[++i];
      changes.push({ path: parts[9], origPath, kind: parts[8].startsWith('C') ? 'added' : 'renamed' });
    } else if (type === 'u') {
      const parts = splitN(rec, ' ', 11);
      changes.push({ path: parts[10], kind: 'conflicted' });
    } else if (type === '?') {
      changes.push({ path: rec.slice(2), kind: 'untracked' });
    }
  }
  return { branch, changes };
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

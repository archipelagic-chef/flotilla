import type {
  ChangedFile,
  TicketChange,
} from '../ticketProtocol';

/**
 * The changed file a link points at (BL-174): a path from the repository's root (as reports link them, "src/x.ts#L42",
 * "src/x.ts:42", "./src/x.ts"), with the group it's in (the first that has it) and the line, if any. Web links, anchors
 * and other files: none.
 */
export function changeLink(href: string, change: TicketChange | undefined): { group: number; path: string; line?: number } | undefined {
  if (!change || !href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return undefined;
  let rest = href;
  let line: number | undefined;
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    const m = /^L(\d+)/i.exec(rest.slice(hash + 1));
    if (m) line = Number(m[1]);
    rest = rest.slice(0, hash);
  } else {
    const m = /^(.*?):(\d+)(?:[:-]\d+)?$/.exec(rest);
    if (m) {
      rest = m[1];
      line = Number(m[2]);
    }
  }
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // As written.
  }
  const path = rest.replace(/^\.\//, '').replace(/^\/+/, '');
  const group = change.groups.findIndex((g) => g.files.some((f) => f.path === path));
  if (group < 0) return undefined;
  return { group, path, ...(line ? { line } : {}) };
}

/** The letter of a file's change, as Source Control shows it. */
export function changeLetter(f: Pick<ChangedFile, 'kind'>): string {
  switch (f.kind) {
    case 'added':
    case 'untracked':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'conflicted':
      return '!';
    default:
      return 'M';
  }
}

/** How many of the ticket's files Changes lists (BL-276): the rest are in View Version Control. */
export const BIGGEST = 3;

export interface BigFile {
  group: number;
  file: ChangedFile;
  /** The branch or worktree it's on, when the ticket's files are on more than one. */
  branch?: string;
}

/**
 * The ticket's biggest files (BL-276), by lines changed (a binary file last), from all its branches and worktrees,
 * and how many more there are. A file changed on two branches is listed once, the bigger one.
 */
export function biggestFiles(change: TicketChange, n = BIGGEST): { files: BigFile[]; more: number } {
  const several = change.groups.length > 1;
  const all = change.groups.flatMap((g, group) => g.files.map((file) => ({ group, file, ...(several ? { branch: g.label } : {}) })));
  const size = (f: ChangedFile) => (f.binary ? -1 : f.added + f.deleted);
  all.sort((a, b) => size(b.file) - size(a.file) || a.file.path.localeCompare(b.file.path));
  const seen = new Set<string>();
  const files = all.filter((f) => !seen.has(f.file.path) && !!seen.add(f.file.path));
  return { files: files.slice(0, n), more: Math.max(0, files.length - n) };
}

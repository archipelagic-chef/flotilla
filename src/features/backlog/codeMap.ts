import { runGit } from '../../core/git/gitCli';
import type { BacklogItem } from './backlog';
import { dependsOn } from './mainDrift';

/**
 * A ticket's map of the code (BL-73): the files it likely changes, from what's known before an agent starts. Agents
 * get it as a place to start, so they spend fewer turns finding the code; the autopilot uses its firm part to keep
 * clashing tickets apart (BL-71).
 *
 * - firm: the paths its description names, and the files changed by the tickets it's part of or depends on;
 * - loose: the files changed by tickets with a similar title (the place to start, not a reason to wait).
 */
export interface CodeMap {
  /** Most likely first, at most MAP_SIZE. */
  files: string[];
  /** The firm ones (see above). */
  firm: string[];
}

export const MAP_SIZE = 10;

/** Files every ticket touches: they say nothing about where its work is. */
const EVERYWHERE = /^(package(-lock)?\.json|README\.md|CHANGELOG\.md|\.flotilla\/|\.vscode\/|\.gitignore$)/;

/** Words of a title that say what it's about (not "the", "and", "when"...). */
const SKIP = new Set([
  'with',
  'from',
  'that',
  'this',
  'when',
  'into',
  'their',
  'there',
  'than',
  'they',
  'what',
  'which',
  'without',
  'doesn',
  'isn',
  'aren',
  'don',
  'every',
  'once',
  'each',
  'more',
  'less',
  'only',
  'also',
  'make',
  'show',
  'shows',
  'keep',
  'keeps',
  'ticket',
  'tickets',
]);
export function titleWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !SKIP.has(w))
      // A crude stem, so "shaping" meets "shape" and "agents" meets "agent".
      .map((w) => w.replace(/(ing|ies|ed|es|s|e)$/, '')),
  );
}

/** The paths a description names: `src/a.ts`, [a.ts](src/a.ts#L3), src/a.ts:12. */
export function namedPaths(description: string): string[] {
  const found = new Set<string>();
  for (const m of description.matchAll(/(?:^|[\s(`[])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,6})(?=[\s)`\]:#,.;]|$)/gm)) found.add(m[1].replace(/^\.\//, ''));
  return [...found];
}

/**
 * The tickets whose work says where this one's is: firm (its parts, what it depends on) and loose (its parent, often a
 * broad epic, and done tickets with similar titles).
 */
export function relatedTickets(
  item: Pick<BacklogItem, 'id' | 'title' | 'parent'>,
  description: string,
  items: readonly BacklogItem[],
): { firm: string[]; loose: string[] } {
  const firm = new Set<string>([...items.filter((i) => i.parent === item.id).map((i) => i.id), ...dependsOn(description, item.id)]);
  firm.delete(item.id);
  // Similar: the done tickets whose titles share its title's or description's words, rare words counting most (a word in
  // every other title, like "agent", says little). Enough to share one rare word, or a few common ones.
  const words = new Set([...titleWords(item.title), ...titleWords(description)]);
  const titles = items.map((i) => ({ id: i.id, done: i.status === 'done', words: titleWords(i.title) }));
  const df = new Map<string, number>();
  for (const t of titles) for (const w of t.words) df.set(w, (df.get(w) ?? 0) + 1);
  const weight = (w: string) => Math.log(titles.length / (df.get(w) ?? 1));
  const enough = Math.log(titles.length / 3);
  const loose = titles
    .filter((t) => t.id !== item.id && !firm.has(t.id) && t.done)
    .map((t) => ({ id: t.id, score: [...t.words].filter((w) => words.has(w)).reduce((n, w) => n + weight(w), 0) }))
    .filter((s) => s.score > enough)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.id);
  const parent = item.parent && !firm.has(item.parent) ? [item.parent] : [];
  return { firm: [...firm], loose: [...loose, ...parent] };
}

/** The files the commits of these tickets changed ("BL-3: ..." messages), most often changed first; still there in cwd. */
export async function ticketFiles(cwd: string, ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return [];
  const grep = ids.flatMap((id) => ['--grep', `^${id}:`]);
  let out: string;
  try {
    out = await runGit(['log', '--all', '-n', '200', '--format=', '--name-only', '--no-renames', ...grep], { cwd });
  } catch {
    return [];
  }
  const count = new Map<string, number>();
  for (const f of out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean))
    if (!EVERYWHERE.test(f)) count.set(f, (count.get(f) ?? 0) + 1);
  return existing(
    cwd,
    [...count].sort((a, b) => b[1] - a[1]).map(([f]) => f),
  );
}

/** Those of the paths git tracks in cwd now. */
async function existing(cwd: string, files: string[]): Promise<string[]> {
  if (!files.length) return [];
  try {
    const out = await runGit(['ls-files', '--', ...files.slice(0, 60)], { cwd });
    const tracked = new Set(out.split('\n').map((l) => l.trim()));
    return files.filter((f) => tracked.has(f));
  } catch {
    return [];
  }
}

/** A ticket's map (see CodeMap), read in cwd (the main worktree). */
export async function codeMap(
  cwd: string,
  item: Pick<BacklogItem, 'id' | 'title' | 'parent'>,
  description: string,
  items: readonly BacklogItem[],
): Promise<CodeMap> {
  const related = relatedTickets(item, description, items);
  const named = await existing(
    cwd,
    namedPaths(description).filter((f) => !EVERYWHERE.test(f)),
  );
  const firm = [...new Set([...named, ...(await ticketFiles(cwd, related.firm))])];
  const loose = (await ticketFiles(cwd, related.loose)).filter((f) => !firm.includes(f));
  return { files: [...firm, ...loose].slice(0, MAP_SIZE), firm: firm.slice(0, MAP_SIZE) };
}

/** What an agent is told of the map: where to start, not a limit. Undefined for an empty map. */
export function mapNote(map: CodeMap | undefined): string | undefined {
  if (!map?.files.length) return undefined;
  return `Places to start (the files its description names, and those its related tickets changed; a guide, not a limit): ${map.files.join(', ')}.`;
}

/** A ticket's map, from the backlog as it is now (undefined when it can't be read: the agent starts without one). */
export async function mapFor(
  backlog: { read(): Promise<{ items: BacklogItem[] }>; readTicketCached(item: BacklogItem): Promise<{ description: string }> },
  cwd: string,
  item: BacklogItem,
): Promise<CodeMap | undefined> {
  try {
    const [data, ticket] = await Promise.all([backlog.read(), backlog.readTicketCached(item)]);
    return await codeMap(cwd, item, ticket.description, data.items);
  } catch {
    return undefined;
  }
}

/** The files a worktree changes against base: its commits since they parted, and what isn't committed yet. */
export async function changedFiles(cwd: string, base: string): Promise<string[]> {
  const files = new Set<string>();
  for (const args of [
    ['diff', '--name-only', '--no-renames', `${base}...HEAD`],
    ['diff', '--name-only', '--no-renames', 'HEAD'],
  ]) {
    try {
      for (const f of (await runGit(args, { cwd })).split('\n').map((l) => l.trim())) if (f && !EVERYWHERE.test(f)) files.add(f);
    } catch {
      // Unknown: no clash is found with it.
    }
  }
  return [...files];
}

/** A ticket's clash (BL-71): the ticket in progress that changes files its map is firm about, and those files. */
export interface Clash {
  with: string;
  files: string[];
}

/** A clash's files for a ticket's activity: the first three, and how many more. */
export function clashFiles(clash: Clash): string {
  const shown = clash.files
    .slice(0, 3)
    .map((f) => `\`${f}\``)
    .join(', ');
  return clash.files.length > 3 ? `${shown} and ${clash.files.length - 3} more` : shown;
}

/** The first ticket in progress (busy: its id and the files it changes) that changes one of the firm files. */
export function findClash(firm: readonly string[], busy: ReadonlyMap<string, ReadonlySet<string>>, self: string): Clash | undefined {
  for (const [id, files] of busy) {
    if (id === self) continue;
    const shared = firm.filter((f) => files.has(f));
    if (shared.length) return { with: id, files: shared };
  }
  return undefined;
}

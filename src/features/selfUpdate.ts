/**
 * Flotilla updating itself from main (BL-151). The build records the commit it's from (dist/build.json, written by
 * esbuild.mjs); in Flotilla's own repository the window counts what main has merged since, and offers to build and
 * install main. Pure, but for the git runner the caller passes in.
 */

/** What dist/build.json says about the build. */
export interface BuildStamp {
  commit: string;
  /** Built with uncommitted changes. */
  dirty: boolean;
  builtAt?: string;
}

/** The build's stamp from dist/build.json's text; undefined when it's missing or has no commit. */
export function parseBuildStamp(text: string | undefined): BuildStamp | undefined {
  if (!text) return undefined;
  try {
    const o = JSON.parse(text) as { commit?: unknown; dirty?: unknown; builtAt?: unknown };
    if (typeof o.commit !== 'string' || !/^[0-9a-f]{7,64}$/.test(o.commit)) return undefined;
    return { commit: o.commit, dirty: o.dirty === true, builtAt: typeof o.builtAt === 'string' ? o.builtAt : undefined };
  } catch {
    return undefined;
  }
}

/** Whether a repository is Flotilla's own: its package.json (text) names it `flotilla`. */
export function isFlotillaRepo(packageJson: string | undefined): boolean {
  if (!packageJson) return false;
  try {
    return (JSON.parse(packageJson) as { name?: unknown }).name === 'flotilla';
  } catch {
    return false;
  }
}

/**
 * How many commits base has after the build's (on its first-parent line: one per merge), or undefined when that can't
 * be told (the commit isn't in this repository, or git fails).
 */
export async function mergesSince(git: (args: string[]) => Promise<string>, commit: string, base: string): Promise<number | undefined> {
  try {
    const n = Number.parseInt((await git(['rev-list', '--count', '--first-parent', `${commit}..refs/heads/${base}`])).trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** "1 merge" / "10 merges". */
export function mergesLabel(n: number): string {
  return `${n} merge${n === 1 ? '' : 's'}`;
}

/** The build, said in a line: "Flotilla 0.2.0, built from 814b863 (with uncommitted changes) on 2026-10-20 16:15". */
export function describeBuild(version: string, stamp: BuildStamp | undefined, formatDate: (iso: string) => string = (iso) => iso): string {
  if (!stamp) return `Flotilla ${version} (its commit isn't recorded)`;
  return `Flotilla ${version}, built from ${stamp.commit.slice(0, 7)}${stamp.dirty ? ' with uncommitted changes' : ''}${stamp.builtAt ? ` on ${formatDate(stamp.builtAt)}` : ''}`;
}

/** The agents running, said in a phrase: "Byte-7", "Byte-7 and Nova-2", "Byte-7, Nova-2 and 3 more". */
export function agentsPhrase(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? 'no agent';
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

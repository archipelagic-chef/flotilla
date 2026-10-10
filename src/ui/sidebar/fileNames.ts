import * as path from 'node:path';

const INVALID_CHARS = /[<>:"|?*\x00-\x1f]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * Checks a name typed into the inline box. Like the Explorer, "a/b/c.ts" creates the folders on the way.
 * Returns the problem, or undefined when the name is fine.
 */
export function nameProblem(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return 'A file or folder name must be provided.';
  if (/^[\\/]/.test(trimmed) || path.isAbsolute(trimmed)) return 'The name must be relative to the folder.';
  for (const part of trimmed.split(/[\\/]/)) {
    if (part === '' || part === '.' || part === '..') return `'${trimmed}' is not a valid name.`;
    if (INVALID_CHARS.test(part)) return `'${part}' contains characters that are not allowed in file names.`;
    if (WINDOWS_RESERVED.test(part)) return `'${part}' is a reserved name on Windows.`;
    if (/[. ]$/.test(part)) return `'${part}' can't end with a dot or a space.`;
  }
  return undefined;
}

/** A free name for a pasted copy, the way the Explorer names them: "a.ts" → "a copy.ts" → "a copy 2.ts". */
export function copyName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const ext = path.extname(name);
  const base = ext && ext !== name ? name.slice(0, -ext.length) : name;
  const suffix = ext && ext !== name ? ext : '';
  for (let n = 1; ; n++) {
    const candidate = `${base} copy${n === 1 ? '' : ` ${n}`}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** True when target is source or inside it (a folder can't be moved or copied into itself). */
export function isSelfOrInside(source: string, target: string): boolean {
  const rel = path.relative(path.resolve(source), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

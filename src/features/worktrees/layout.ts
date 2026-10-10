import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ensureExcludeLine } from '../../core/git/exclude';

export const WORKTREES_DIR = '.worktrees';
const EXCLUDE_LINE = '/.worktrees/';
const EXCLUDE_VARIANTS = ['.worktrees', '.worktrees/', '/.worktrees', '/.worktrees/'];
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const INVALID_BRANCH = /^[-./]|[./]$|\.\.|[\s~^:?*[\\\x00-\x1f\x7f]|@\{|\.lock(\/|$)|\/\/|\/\./;

export function worktreesRoot(mainRoot: string): string {
  return path.join(mainRoot, WORKTREES_DIR);
}

export function sanitizeName(branch: string): string {
  const cleaned = branch.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (!cleaned) return 'worktree';
  return WINDOWS_RESERVED.test(cleaned) ? `${cleaned}-wt` : cleaned;
}

export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

export async function existingNames(mainRoot: string): Promise<Set<string>> {
  try {
    const entries = await fs.readdir(worktreesRoot(mainRoot), { withFileTypes: true });
    return new Set(entries.map((e) => e.name));
  } catch {
    return new Set();
  }
}

export function ensureExcluded(commonDir: string): Promise<boolean> {
  return ensureExcludeLine(commonDir, EXCLUDE_LINE, EXCLUDE_VARIANTS);
}

export function branchNameProblem(name: string, existing: readonly string[]): string | undefined {
  if (!name.trim()) return 'Enter a branch name.';
  if (existing.includes(name)) return `A branch named '${name}' already exists.`;
  if (INVALID_BRANCH.test(name)) return `'${name}' is not a valid branch name.`;
  return undefined;
}

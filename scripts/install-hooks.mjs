// `npm install` (its `prepare` script) installs the pre-commit hook that formats the staged files with Prettier
// (scripts/format-staged.mjs, BL-155). Git runs hooks from the main repository's hooks folder in every worktree, so the
// agents' worktrees get it too. A branch from before the hook (no script, or no Prettier installed) commits as it did.
// An existing pre-commit hook is kept, and still runs after the formatting.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARK = '# pre-commit hook of scripts/install-hooks.mjs';
export const PREVIOUS_HOOK = 'pre-commit.pre-format';

export const PRE_COMMIT_HOOK = `#!/bin/sh
${MARK}: formats the staged files with Prettier.
root=$(git rev-parse --show-toplevel)
if [ -f "$root/scripts/format-staged.mjs" ] && [ -d "$root/node_modules/prettier" ]; then
  (cd "$root" && node scripts/format-staged.mjs) || exit 1
fi
previous="$(dirname "$0")/${PREVIOUS_HOOK}"
if [ -x "$previous" ]; then exec "$previous" "$@"; fi
exit 0
`;

/** Installs the hook in `hooksDir` (once; an existing one is kept and chained). */
export function installPreCommit(hooksDir) {
  fs.mkdirSync(hooksDir, { recursive: true });
  const hook = path.join(hooksDir, 'pre-commit');
  const existing = fs.existsSync(hook) ? fs.readFileSync(hook, 'utf8') : undefined;
  if (existing === PRE_COMMIT_HOOK) return 'unchanged';
  if (existing !== undefined && !existing.includes(MARK)) {
    const previous = path.join(hooksDir, PREVIOUS_HOOK);
    if (!fs.existsSync(previous)) fs.renameSync(hook, previous);
  }
  fs.writeFileSync(hook, PRE_COMMIT_HOOK, { mode: 0o755 });
  fs.chmodSync(hook, 0o755);
  return 'installed';
}

function main() {
  const cwd = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  let dir;
  try {
    dir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return; // Not a git checkout (an installed package): no hooks.
  }
  // Hooks kept in the repository's own files (core.hooksPath, as Husky sets it) are the repository's to change.
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' }).trim();
  if (path.relative(common, dir).startsWith('..')) return;
  if (installPreCommit(dir) === 'installed') console.log(`Installed the pre-commit hook that formats staged files: ${path.join(dir, 'pre-commit')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

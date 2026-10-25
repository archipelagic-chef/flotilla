// The pre-commit hook's work (`scripts/install-hooks.mjs` installs it): formats the staged files with Prettier, so
// every commit keeps the repository's one format and no merge conflicts over wrapping (BL-155). It formats what's
// staged, not the file on disk: a file with unstaged changes keeps them, and only its staged version is formatted.
// A file Prettier can't parse is committed as it is (the typecheck tells what's wrong).
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

function git(args, input) {
  return execFileSync('git', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
}

/** The staged files Prettier formats (added, copied, modified or renamed; not deleted ones). */
async function stagedFiles(root) {
  const names = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);
  const out = [];
  for (const name of names) {
    const info = await prettier.getFileInfo(path.join(root, name), { ignorePath: path.join(root, '.prettierignore') });
    if (!info.ignored && info.inferredParser) out.push(name);
  }
  return out;
}

/** Formats a staged file in the index; also on disk when the file there is what's staged. Whether it changed. */
async function formatStaged(root, name) {
  const file = path.join(root, name);
  const staged = git(['show', `:${name}`]);
  const options = { ...(await prettier.resolveConfig(file)), filepath: file };
  const formatted = await prettier.format(staged, options);
  if (formatted === staged) return false;
  const [mode] = git(['ls-files', '-s', '--', name]).split(' ');
  const blob = git(['hash-object', '-w', '--stdin', '--path', name], formatted).trim();
  git(['update-index', '--cacheinfo', `${mode},${blob},${name}`]);
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === staged) fs.writeFileSync(file, formatted);
  return true;
}

export async function main() {
  const root = git(['rev-parse', '--show-toplevel']).trim();
  const changed = [];
  for (const name of await stagedFiles(root)) {
    try {
      if (await formatStaged(root, name)) changed.push(name);
    } catch (e) {
      console.warn(`Prettier skipped ${name}: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
    }
  }
  if (changed.length) console.log(`Formatted ${changed.length} staged file${changed.length === 1 ? '' : 's'} with Prettier: ${changed.join(', ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

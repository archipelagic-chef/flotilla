// Creates .playground/: a throwaway git repo inside this project, so the host and the
// devcontainer see the same repo (C:\...\worktree_extension\.playground and
// /workspaces/worktree_extension/.playground). Does nothing if it already exists, but says so
// if it was built by another version of this script. `--reset` moves the old one aside
// (.playground.old-<date>, never deleted) and builds a fresh one.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Bump when this script changes what a new playground looks like or how it is built.
const PLAYGROUND_VERSION = 1;

const dir = path.resolve('.playground');
const reset = process.argv.includes('--reset');
const exists = fs.existsSync(path.join(dir, '.git'));

const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const configured = (key) => {
  try {
    return git('config', key) !== '';
  } catch {
    return false;
  }
};
const recordedVersion = () => {
  try {
    return Number(git('config', 'flotilla.playgroundVersion'));
  } catch {
    return null;
  }
};

// Unregisters the old playground's linked worktrees, then renames the playground aside.
// If any linked worktree has changes or is locked, nothing is removed or moved.
const moveAside = () => {
  git('worktree', 'prune');
  const linked = git('worktree', 'list', '--porcelain')
    .split('\n\n')
    .slice(1)
    .map((block) => ({
      path: block.split('\n').find((line) => line.startsWith('worktree ')).slice('worktree '.length),
      locked: block.split('\n').some((line) => line.startsWith('locked')),
    }));
  const busy = linked.filter(({ path: worktree, locked }) => locked || execFileSync('git', ['-C', worktree, 'status', '--porcelain'], { encoding: 'utf8' }).trim() !== '');
  if (busy.length > 0) {
    throw new Error(`these worktrees have changes or are locked, so nothing was moved: ${busy.map(({ path: worktree }) => worktree).join(', ')}`);
  }
  for (const { path: worktree } of linked) git('worktree', 'remove', worktree);

  const now = new Date();
  const day = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  let target = path.resolve(`.playground.old-${day}`);
  for (let n = 2; fs.existsSync(target); n++) target = path.resolve(`.playground.old-${day}-${n}`);
  fs.renameSync(dir, target);
  console.log(`Moved the old playground aside: ${target}`);
};

const create = () => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git('init', '-q');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  git('config', 'core.autocrlf', 'false');
  if (!configured('user.name')) git('config', 'user.name', 'Flotilla Playground');
  if (!configured('user.email')) git('config', 'user.email', 'playground@flotilla.invalid');
  fs.writeFileSync(path.join(dir, '.gitattributes'), '* text=auto eol=lf\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Flotilla playground\n\nA throwaway repo for testing Flotilla on the host and in the devcontainer.\n');
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), "console.log('hello from the playground');\n");
  git('add', '.');
  git('commit', '-q', '-m', 'Initial playground commit');
  git('config', 'flotilla.playgroundVersion', String(PLAYGROUND_VERSION));
  console.log(`Created playground: ${dir}`);
};

try {
  if (exists && !reset) {
    const built = recordedVersion();
    if (built === PLAYGROUND_VERSION) {
      console.log(`Playground already exists: ${dir}`);
    } else {
      const from = built === null ? 'an older version of this script' : `version ${built} of this script`;
      console.log(`The playground is outdated: it was built by ${from}, the current version is ${PLAYGROUND_VERSION}.`);
      console.log('It was not reset, because you may have changed things in it.');
      console.log('To start over with a fresh one, run `npm run playground -- --reset` (or launch "Run Extension (fresh playground)").');
      console.log('The old one is moved to .playground.old-<date>.');
    }
    process.exit(0);
  }
  if (exists) moveAside();
  create();
} catch (err) {
  console.error(`Couldn't ${exists ? 'reset' : 'create'} the playground: ${err.stderr?.toString().trim() || err.message}`);
  process.exit(1);
}

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
// Set once the old playground has been renamed, so a later failure can say where it is.
let movedTo = null;

const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (...args) => gitIn(dir, ...args);
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

// The linked worktrees of the repo at `repo` (not the main one), with whether git has them locked.
const linkedWorktrees = (repo) =>
  gitIn(repo, 'worktree', 'list', '--porcelain')
    .split('\n\n')
    .slice(1)
    .map((block) => ({
      path: block.split('\n').find((line) => line.startsWith('worktree ')).slice('worktree '.length),
      locked: block.split('\n').some((line) => line.startsWith('locked')),
    }));

// Moves the playground aside, then forgets its worktrees in git. The worktree folders stay where
// they are (inside the moved-aside playground), so nothing in them is deleted, ignored files included.
// Nothing is moved if a linked worktree is locked or has uncommitted changes.
const moveAside = () => {
  git('worktree', 'prune');
  const linked = linkedWorktrees(dir);
  const busy = linked.filter(({ path: worktree, locked }) => locked || gitIn(worktree, 'status', '--porcelain') !== '');
  if (busy.length > 0) {
    throw new Error(`these worktrees have changes or are locked, so nothing was moved: ${busy.map(({ path: worktree }) => worktree).join(', ')}`);
  }

  const now = new Date();
  const day = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  let target = path.resolve(`.playground.old-${day}`);
  for (let n = 2; fs.existsSync(target); n++) target = path.resolve(`.playground.old-${day}-${n}`);
  fs.renameSync(dir, target);
  movedTo = target;

  // Git's records of the worktrees (their admin dirs) go; the folders stay.
  try {
    fs.rmSync(path.join(target, '.git', 'worktrees'), { recursive: true, force: true });
  } catch (err) {
    throw new Error(`the old playground was moved to ${target}, but its worktree records couldn't be removed: ${err.message}`);
  }
  console.log(`Moved the old playground aside: ${target}`);
  if (linked.length > 0) {
    const kept = linked.map(({ path: worktree }) => worktree.replace(dir, target));
    console.log(`Kept ${kept.length} worktree folder(s), no longer registered with git: ${kept.join(', ')}`);
    console.log('Their branches are still in the moved-aside repo. To use one with git again, `git worktree add <new path> <branch>` from there.');
  }
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
  const where = movedTo ? ` The old playground is at ${movedTo}.` : '';
  console.error(`Couldn't ${exists ? 'reset' : 'create'} the playground: ${err.stderr?.toString().trim() || err.message}.${where}`);
  process.exit(1);
}

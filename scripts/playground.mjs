// Creates .playground/: a throwaway git repo inside this project, so the host and the
// devcontainer see the same repo (C:\...\worktree_extension\.playground and
// /workspaces/worktree_extension/.playground). Does nothing if it already exists, but says so
// if it was built by another version of this script. `--reset` moves the old one aside
// (.playground.old-<date>, never deleted) and builds a fresh one: a small Node app (playground-app/), a branch whose
// test fails, and a backlog with worktrees in every state Flotilla handles (playground-seed.mjs).
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeDebugProfile, fakesArg, syncDebugProfile } from './debug-profile.mjs';

// Every run, the debug window's own profile is made ready (it doesn't use the user's VS Code profile); --fakes and
// --no-fakes switch the fake Claude and GitHub on and off.
console.log(describeDebugProfile(syncDebugProfile({ fakes: fakesArg() })));

// The seed takes the app's code from dist/, which `npm run build` makes (the launch configurations run it first).
if (!fs.existsSync(fileURLToPath(new URL('../dist/playground-seed-kit.mjs', import.meta.url)))) {
  console.error('The playground needs the build first: run `npm run build`, then `npm run playground` again.');
  process.exit(1);
}
const { seedPlayground } = await import('./playground-seed.mjs');

// Bump when this script changes what a new playground looks like or how it is built.
const PLAYGROUND_VERSION = 2;

// The playground's files (a small Node app, its tests and launch configurations) live in playground-app/.
const app = fileURLToPath(new URL('playground-app/', import.meta.url));
const dir = path.resolve('.playground');
// The playground's origin: a local bare repository whose path ends like a GitHub address, so the CI/CD view takes it for
// GitHub's playground/app, while fetches and pushes (Flotilla's push on approval, BL-104) never leave the machine
// (BL-113). The debug window reads its runs from the fake GitHub (npm run fake-github, switched on in the debug profile:
// npm run debug-profile -- --fakes).
// Forward slashes, on Windows too: git takes them, and the address reads as GitHub's.
const REMOTE = path.join(dir, '.git', 'origin', 'github.com', 'playground', 'app.git').split(path.sep).join('/');
const reset = process.argv.includes('--reset');
const exists = fs.existsSync(path.join(dir, '.git'));
// Set once the old playground has been renamed, so a later failure can say where it is.
let movedTo = null;

const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (...args) => gitIn(dir, ...args);
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
      path: block
        .split('\n')
        .find((line) => line.startsWith('worktree '))
        .slice('worktree '.length),
      locked: block.split('\n').some((line) => line.startsWith('locked')),
    }));

// Moves the playground aside, its worktrees with it, and points git at where they are now (git worktree repair), so
// nothing in them is lost: their files, staged changes (kept in git's records of them) and branches stay usable there.
const moveAside = () => {
  git('worktree', 'prune');
  const linked = linkedWorktrees(dir);

  const now = new Date();
  const day = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  let target = path.resolve(`.playground.old-${day}`);
  for (let n = 2; fs.existsSync(target); n++) target = path.resolve(`.playground.old-${day}-${n}`);
  fs.renameSync(dir, target);
  movedTo = target;
  console.log(`Moved the old playground aside: ${target}`);
  if (linked.length === 0) return;

  // Worktrees inside the playground moved with it; any elsewhere stayed where they were.
  // git lists them with / (C:/… on Windows); path.resolve gives them dir's separators to compare with.
  const moved = linked.map(({ path: listed }) => {
    const worktree = path.resolve(listed);
    return worktree === dir || worktree.startsWith(dir + path.sep) ? target + worktree.slice(dir.length) : worktree;
  });
  try {
    gitIn(target, 'worktree', 'repair', ...moved);
  } catch (err) {
    throw new Error(
      `the old playground was moved to ${target}, but its worktrees couldn't be pointed at their new place (run \`git worktree repair\` there): ${err.stderr?.toString().trim() || err.message}`,
    );
  }
  console.log(`Its ${linked.length} worktree(s) moved with it and still work there: ${moved.join(', ')}`);
};

// The playground looks like a GitHub repository to the CI/CD view: origin is REMOTE, and the checked-out branch is
// published there (its commit pushed, and its upstream), so its runs can be read. A playground made before REMOTE was
// local (it was https://github.com/playground/app.git) gets it too, with what it had marked as pushed.
const asGitHubRepository = () => {
  if (!fs.existsSync(REMOTE)) gitIn(dir, 'init', '-q', '--bare', REMOTE);
  const remotes = git('remote').split('\n');
  if (!remotes.includes('origin')) git('remote', 'add', 'origin', REMOTE);
  else if (git('remote', 'get-url', 'origin') !== REMOTE) git('remote', 'set-url', 'origin', REMOTE);
  const branch = git('symbolic-ref', '--short', 'HEAD');
  try {
    git('rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`);
  } catch {
    git('update-ref', `refs/remotes/origin/${branch}`, `refs/heads/${branch}`);
  }
  git('branch', `--set-upstream-to=origin/${branch}`, branch);
  // The seed marks branches as pushed with remote-tracking refs alone: origin gets their commits.
  git('push', '-q', '--force', 'origin', 'refs/remotes/origin/*:refs/heads/*');
};

const create = () => {
  fs.cpSync(app, dir, { recursive: true });
  git('init', '-q');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  git('config', 'core.autocrlf', 'false');
  // Its own identity, always: the demo window's home has no git config, so its merges need one here (BL-65).
  git('config', 'user.name', 'Flotilla Playground');
  git('config', 'user.email', 'playground@flotilla.invalid');
  fs.writeFileSync(path.join(dir, '.gitattributes'), '* text=auto eol=lf\n');
  git('add', '.');
  git('commit', '-q', '-m', 'Initial playground commit');
  // One test fails here, so failures can be tried too; main stays green.
  git('checkout', '-q', '-b', 'feature/greeting-without-comma');
  const greeting = path.join(dir, 'src', 'greeting.js');
  fs.writeFileSync(greeting, fs.readFileSync(greeting, 'utf8').replace('Hello, ', 'Hello '));
  git('commit', '-q', '-am', 'Drop the comma from the greeting');
  git('checkout', '-q', 'main');
  seedPlayground(dir);
  asGitHubRepository();
  git('config', 'flotilla.playgroundVersion', String(PLAYGROUND_VERSION));
  console.log(`Created playground: ${dir}`);
};

try {
  if (exists && !reset) {
    if (seedPlayground(dir)) console.log(`Seeded the playground's backlog and worktrees: ${dir}`);
    asGitHubRepository();
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

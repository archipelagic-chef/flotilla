// Creates .playground/: a throwaway git repo inside this project, so the host and the
// devcontainer see the same repo (C:\...\worktree_extension\.playground and
// /workspaces/worktree_extension/.playground). Does nothing if it already exists.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// The playground's files (a small Node app, its tests and launch configurations) live in playground-app/.
const app = fileURLToPath(new URL('playground-app/', import.meta.url));
const dir = path.resolve('.playground');
if (fs.existsSync(path.join(dir, '.git'))) {
  console.log(`Playground already exists: ${dir}`);
  process.exit(0);
}

const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const configured = (key) => {
  try {
    return git('config', key) !== '';
  } catch {
    return false;
  }
};

fs.cpSync(app, dir, { recursive: true });
git('init', '-q');
git('symbolic-ref', 'HEAD', 'refs/heads/main');
git('config', 'core.autocrlf', 'false');
if (!configured('user.name')) git('config', 'user.name', 'Flotilla Playground');
if (!configured('user.email')) git('config', 'user.email', 'playground@flotilla.invalid');
fs.writeFileSync(path.join(dir, '.gitattributes'), '* text=auto eol=lf\n');
git('add', '.');
git('commit', '-q', '-m', 'Initial playground commit');
// One test fails here, so failures can be tried too; main stays green.
git('checkout', '-q', '-b', 'feature/greeting-without-comma');
const greeting = path.join(dir, 'src', 'greeting.js');
fs.writeFileSync(greeting, fs.readFileSync(greeting, 'utf8').replace('Hello, ', 'Hello '));
git('commit', '-q', '-am', 'Drop the comma from the greeting');
git('checkout', '-q', 'main');
console.log(`Created playground: ${dir}`);

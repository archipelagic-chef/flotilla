// Creates .playground/: a throwaway git repo inside this project, so the host and the
// devcontainer see the same repo (C:\...\worktree_extension\.playground and
// /workspaces/worktree_extension/.playground). Does nothing if it already exists.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
console.log(`Created playground: ${dir}`);

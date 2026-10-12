// Creates .playground/: a throwaway git repo inside this project, so the host and the
// devcontainer see the same repo (C:\...\worktree_extension\.playground and
// /workspaces/worktree_extension/.playground). Does nothing if it already exists.
// Also seeds the playground's backlog with one sample ticket, when it has none, so the test window has a ticket to read.
// Every run makes the playground look like a GitHub repository to the CI/CD view (a remote that's never pushed to), and
// points the debug window at the fake GitHub (npm run fake-github).
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_PORT } from './fake-github.mjs';

const dir = path.resolve('.playground');
const REMOTE = 'https://github.com/playground/app.git';

/** A sample ticket whose last report has two run blocks: the ticket's run is the last one, "Run the app". */
const sampleTicket = (date) => `# Try the playground

A sample ticket, made by scripts/playground.mjs. Its agent's report has two run blocks to try: "Open the README" opens
the file in the playground, and "Run the app" (the ticket's run, the last one reported) runs its code.

## Activity

### ${date} · Agent Ada-1
Sample report.

\`\`\`run Open the README
open README.md
\`\`\`

\`\`\`run Run the app
node src/app.js
\`\`\`

Ready for review.
`;

/** Writes the sample backlog into the playground, unless it has a backlog already. */
function seedBacklog() {
  const backlog = path.join(dir, '.flotilla', 'backlog');
  if (fs.existsSync(path.join(backlog, 'backlog.json'))) return;
  fs.mkdirSync(backlog, { recursive: true });
  const item = { id: 'BL-1', title: 'Try the playground', status: 'todo', created: new Date().toISOString() };
  fs.writeFileSync(path.join(backlog, 'backlog.json'), `${JSON.stringify({ version: 1, next: 2, items: [item] }, null, 2)}\n`);
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
  fs.writeFileSync(path.join(backlog, 'BL-1.md'), sampleTicket(date));
}

const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const configured = (key) => {
  try {
    return git('config', key) !== '';
  } catch {
    return false;
  }
};
const hasRef = (ref) => {
  try {
    git('rev-parse', '--verify', '-q', ref);
    return true;
  } catch {
    return false;
  }
};

if (fs.existsSync(path.join(dir, '.git'))) {
  seedBacklog();
  console.log(`Playground already exists: ${dir}`);
} else {
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
  seedBacklog();
  console.log(`Created playground: ${dir}`);
}

// A GitHub remote that's never fetched from or pushed to, and the checked-out branch as published on it (so its runs
// can be read). The playground's branch isn't always main (an older playground's is master).
const remotes = git('remote').split('\n');
if (!remotes.includes('origin')) git('remote', 'add', 'origin', REMOTE);
else if (git('remote', 'get-url', 'origin') !== REMOTE) git('remote', 'set-url', 'origin', REMOTE);
const branch = git('symbolic-ref', '--short', 'HEAD');
if (!hasRef(`refs/remotes/origin/${branch}`)) git('update-ref', `refs/remotes/origin/${branch}`, `refs/heads/${branch}`);
git('branch', `--set-upstream-to=origin/${branch}`, branch);

// The debug window reads its CI/CD runs from the fake GitHub. Kept out of the playground's history.
const settings = path.join(dir, '.vscode', 'settings.json');
fs.mkdirSync(path.dirname(settings), { recursive: true });
fs.writeFileSync(settings, `${JSON.stringify({ 'flotilla.dev.githubApi': `http://127.0.0.1:${DEFAULT_PORT}` }, null, 2)}\n`);
const exclude = path.join(dir, '.git', 'info', 'exclude');
const excluded = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
if (!excluded.split('\n').includes('/.vscode/')) fs.appendFileSync(exclude, `${excluded && !excluded.endsWith('\n') ? '\n' : ''}/.vscode/\n`);

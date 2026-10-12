// Creates .playground/: a throwaway git repo inside this project, so the host and the
// devcontainer see the same repo (C:\...\worktree_extension\.playground and
// /workspaces/worktree_extension/.playground). Does nothing if it already exists.
// Also seeds the playground's backlog with one sample ticket, when it has none, so the test window has a ticket to read.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const dir = path.resolve('.playground');

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

if (fs.existsSync(path.join(dir, '.git'))) {
  seedBacklog();
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
seedBacklog();
console.log(`Created playground: ${dir}`);

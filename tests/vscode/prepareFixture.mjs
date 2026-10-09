import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const dir = path.resolve('.vscode-test/fixture-repo');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
git('init', '-q');
git('symbolic-ref', 'HEAD', 'refs/heads/main');
git('config', 'user.name', 'Test');
git('config', 'user.email', 'test@example.com');
git('config', 'commit.gpgsign', 'false');
git('config', 'core.autocrlf', 'false');
fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
git('add', '.');
git('commit', '-q', '-m', 'initial');

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  guard,
  guardScript,
} from '../../../src/features/backlog/agentGuard';
import {
  makeTempDir,
  removeDir,
  writeFile,
} from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function repo(): string {
  const dir = makeTempDir();
  cleanup.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  writeFile(dir, 'small.ts', lines(10));
  writeFile(dir, 'big.ts', lines(900));
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

describe('the agent guard', () => {
  it('refuses a whole read of a big file, with how to read it instead; small files and ranges pass', () => {
    const cwd = repo();
    expect(guard({ tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'big.ts') }, cwd }, 400, 600)).toMatch(/has 900 lines.*limit: 900/);
    expect(guard({ tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'big.ts'), limit: 900 }, cwd }, 400, 600)).toBeUndefined();
    expect(guard({ tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'big.ts'), offset: 100 }, cwd }, 400, 600)).toBeUndefined();
    expect(guard({ tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'small.ts') }, cwd }, 400, 600)).toBeUndefined();
    expect(guard({ tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'missing.ts') }, cwd }, 400, 600)).toBeUndefined();
  });

  it('refuses a plain cat of a big file, not a piped or ranged one', () => {
    const cwd = repo();
    expect(guard({ tool_name: 'Bash', tool_input: { command: 'cat big.ts' }, cwd }, 400, 600)).toMatch(/sed -n '1,900p' big\.ts/);
    expect(guard({ tool_name: 'Bash', tool_input: { command: 'cat "big.ts"' }, cwd }, 400, 600)).toMatch(/900 lines/);
    expect(guard({ tool_name: 'Bash', tool_input: { command: 'cat big.ts | grep 5' }, cwd }, 400, 600)).toBeUndefined();
    expect(guard({ tool_name: 'Bash', tool_input: { command: 'cat small.ts' }, cwd }, 400, 600)).toBeUndefined();
  });

  it('refuses a whole diff of many lines, not a summary or one with paths', () => {
    const cwd = repo();
    writeFile(cwd, 'big.ts', lines(900).replace(/line/g, 'row'));
    expect(guard({ tool_name: 'Bash', tool_input: { command: 'git diff' }, cwd }, 400, 600)).toMatch(/changes 1800 lines in 1 files/);
    expect(guard({ tool_name: 'Bash', tool_input: { command: 'git diff --stat' }, cwd }, 400, 600)).toBeUndefined();
    expect(guard({ tool_name: 'Bash', tool_input: { command: 'git diff -- .' }, cwd }, 400, 600)).toBeUndefined();
    expect(guard({ tool_name: 'Bash', tool_input: { command: 'git show HEAD' }, cwd }, 400, 600)).toMatch(/commit changes 910 lines in 2 files/);
    expect(guard({ tool_name: 'Bash', tool_input: { command: 'git show HEAD:big.ts' }, cwd }, 400, 600)).toBeUndefined();
    expect(guard({ tool_name: 'Bash', tool_input: { command: 'git log --oneline' }, cwd }, 400, 600)).toBeUndefined();
  });

  it('runs as a hook script: exit code 2 and the reason on stderr, or nothing', () => {
    const cwd = repo();
    const script = path.join(cwd, 'guard.js');
    fs.writeFileSync(script, guardScript(400, 600));
    const run = (input: unknown) => {
      try {
        execFileSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        return { code: 0, err: '' };
      } catch (e) {
        const x = e as { status: number; stderr: string };
        return { code: x.status, err: x.stderr };
      }
    };
    expect(run({ tool_name: 'Bash', tool_input: { command: 'cat big.ts' }, cwd })).toMatchObject({ code: 2, err: expect.stringMatching(/900 lines/) });
    expect(run({ tool_name: 'Bash', tool_input: { command: 'cat small.ts' }, cwd })).toEqual({ code: 0, err: '' });
    expect(run('not a tool call')).toEqual({ code: 0, err: '' });
  });
});

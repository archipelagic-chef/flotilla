import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as prettier from 'prettier';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { installPreCommit, PRE_COMMIT_HOOK, PREVIOUS_HOOK } from '../../../scripts/install-hooks.mjs';
import * as imports from '../../../scripts/prettier-imports.mjs';

const ROOT = path.resolve(__dirname, '../../..');
const temps: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flotilla-format-'));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const format = (code: string) => prettier.format(code, { parser: 'typescript', printWidth: 160, singleQuote: true, plugins: [imports] });

describe('the repository format', () => {
  it('has every file Prettier formats formatted (npm run format fixes it)', async () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
    const unformatted: string[] = [];
    for (const name of files) {
      const file = path.join(ROOT, name);
      const info = await prettier.getFileInfo(file, { ignorePath: path.join(ROOT, '.prettierignore') });
      if (info.ignored || !info.inferredParser || !fs.existsSync(file)) continue;
      const options = { ...(await prettier.resolveConfig(file)), filepath: file };
      if (!(await prettier.check(fs.readFileSync(file, 'utf8'), options))) unformatted.push(name);
    }
    expect(unformatted, 'Run `npm run format` to format them').toEqual([]);
  }, 120_000);
});

describe('the import plugin', () => {
  it('lists the names of a long import one per line, sorted', async () => {
    expect(await format("import x, { type Zed, b, A, c } from './x';\n")).toBe("import x, {\n  A,\n  b,\n  c,\n  type Zed,\n} from './x';\n");
  });

  it('does the same for a re-export, sorted by the exported module name', async () => {
    expect(await format("export { d, b, c, a as e } from './z';\n")).toBe("export {\n  a as e,\n  b,\n  c,\n  d,\n} from './z';\n");
  });

  it('keeps a short import on one line, in its order', async () => {
    expect(await format("import {\n  b,\n  a,\n  c,\n} from './x';\n")).toBe("import { b, a, c } from './x';\n");
  });

  it('is stable: formatting its output again changes nothing', async () => {
    const once = await format("import { q, p, r, s } from './y';\nexport { x, w, v, u };\n");
    expect(await format(once)).toBe(once);
  });

  it('sorts case-insensitively, uppercase first on a tie', () => {
    expect(['b', 'B', 'a', 'C'].sort(imports.compareNames)).toEqual(['a', 'B', 'b', 'C']);
  });
});

describe('the pre-commit hook', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

  it('formats the staged version of a file, keeping its unstaged changes', () => {
    const repo = temp();
    git(repo, 'init', '-q');
    fs.writeFileSync(path.join(repo, '.prettierrc.json'), '{ "singleQuote": true }\n');
    fs.copyFileSync(path.join(ROOT, '.prettierignore'), path.join(repo, '.prettierignore'));
    fs.writeFileSync(path.join(repo, 'a.ts'), 'const a = "x"\n');
    fs.writeFileSync(path.join(repo, 'b.ts'), 'const b = "y"\n');
    fs.writeFileSync(path.join(repo, 'notes.md'), 'a  *b*\n');
    git(repo, 'add', '.');
    fs.appendFileSync(path.join(repo, 'b.ts'), 'const unstaged = "z"\n');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/format-staged.mjs')], { cwd: repo });
    expect(git(repo, 'show', ':a.ts')).toBe("const a = 'x';\n");
    expect(fs.readFileSync(path.join(repo, 'a.ts'), 'utf8')).toBe("const a = 'x';\n");
    expect(git(repo, 'show', ':b.ts')).toBe("const b = 'y';\n");
    expect(fs.readFileSync(path.join(repo, 'b.ts'), 'utf8')).toBe('const b = "y"\nconst unstaged = "z"\n');
    expect(git(repo, 'show', ':notes.md')).toBe('a  *b*\n');
  });

  it('is installed once, keeping an existing pre-commit hook to run after it', () => {
    const hooks = temp();
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho mine\n');
    expect(installPreCommit(hooks)).toBe('installed');
    expect(fs.readFileSync(path.join(hooks, 'pre-commit'), 'utf8')).toBe(PRE_COMMIT_HOOK);
    expect(fs.readFileSync(path.join(hooks, PREVIOUS_HOOK), 'utf8')).toBe('#!/bin/sh\necho mine\n');
    expect(installPreCommit(hooks)).toBe('unchanged');
  });
});

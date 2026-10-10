> **Renamed:** this project was later renamed from Switchyard to **Flotilla** (identifiers `switchyard.*` became `flotilla.*`). This document is kept as the historical record.

# Switchyard (Sub-project 1: Core + Workstreams) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Switchyard VS Code extension: a workstream overview of git worktrees that works on Windows/Linux/macOS hosts and in devcontainers at the same time, with portable worktrees, agent status, and worktree diffs.

**Architecture:** A workspace extension (`extensionKind: ["workspace"]`) that calls the `git` CLI through `execFile`. Everything under `src/core` and `src/features` is plain Node (no `vscode` import, except the three files listed in Global Constraints), so it's tested with vitest against real git repos in temp dirs, including a "second environment" simulation. `src/ui` + `src/extension.ts` are thin VS Code wiring, checked by typecheck, an `@vscode/test-cli` smoke test and a manual run.

**Tech Stack:** TypeScript, esbuild, vitest, `@vscode/test-cli`, `tinyglobby`, git ≥ 2.17, Node 22 (target node20).

**Spec:** `docs/superpowers/specs/2026-10-09-switchyard-design.md`

## Global Constraints

- Minimum git **2.17**. Never set or depend on `extensions.relativeWorktrees`; never call `git worktree repair` or `git worktree move`.
- `"extensionKind": ["workspace"]`, `"engines": { "vscode": "^1.95.0" }`, esbuild target `node20`.
- Managed worktrees live at `<mainRoot>/.worktrees/<name>`; `.worktrees/` is ignored through `.git/info/exclude` (line `/.worktrees/`), never `.gitignore`.
- Lock reason text: `switchyard: portable`. The lock is written as the file `<adminDir>/locked` (the same thing `git worktree lock` writes).
- Files in a worktree's git dir: agent status `workstream.json`, heartbeat `switchyard-window.json`.
- Paths written into `.git` files use forward slashes.
- All git calls go through `runGit` (`execFile`, no shell) with `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`; parse `-z` output formats.
- Only `src/core/uris.ts`, `src/core/diff/gitContentProvider.ts` and `src/core/diff/openDiff.ts` under `src/core`/`src/features` may import `vscode`.
- Settings prefix `switchyard.`: `openAfterCreate` (`"newWindow"`), `copyFiles` (`[]`), `setupCommand` (`""`), `autoAdopt` (`true`), `defaultBase` (`""`), `activeWindowMinutes` (`5`), `staleAfterDays` (`7`), `agentStatusStaleMinutes` (`10`), `notifyOnAttention` (`true`), `pollSeconds` (`15`).
- Switchyard never writes agent configuration files (it only copies a snippet to the clipboard).
- Every test must pass on the Windows host **and** inside the devcontainer (Linux). Shell snippets in this plan are POSIX (Git Bash on Windows).
- Commits end with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Repo paths with spaces and non-ASCII characters** (the user's own name contains `ö`): create/resolve/remove must work in `…/my repo ö/` → pinned in Task 8.
2. **Refreshing must not change the repo**: `git status` would normally rewrite `.git/index`, which would make every worktree look "active" and would race with the user's own git. Expect the index mtime to stay the same after a refresh → pinned in Task 13.
3. **A worktree folder deleted by hand** (or a worktree that only exists in the other environment) must show as unreachable and be removable from the list ("Forget") without touching files → pinned in Task 8.
4. **Empty repos and detached HEADs** must not break progress or diffs (no commits → zeros, not an exception) → pinned in Tasks 7 and 11.
5. **Agent status files written by Windows tools** (UTF-8 BOM, CRLF) must still parse → pinned in Task 10.

## Deviations from the spec (deliberate, small)

- Branch/HEAD per worktree are read from `<adminDir>/HEAD` instead of `git worktree list --porcelain` (same data, no path matching needed, and `locked` isn't in porcelain output before git 2.31).
- Refresh orchestration (watchers, focus, polling) lives in `extension.ts` instead of a separate `core/refresh.ts`; the debounced store is `core/repository.ts`.
- Diff tree nodes live in `ui/workstreamsView.ts`; diff *data* lives in `features/diffs/compare.ts` and `core/diff/refs.ts`.
- The hygiene prompt writes **relative** patterns (`.worktrees/**` for `files.watcherExclude`, `.worktrees` for `search.exclude`) so a user-level setting doesn't hide everything inside a window that is opened *on* a worktree; it recommends user settings so no repo file changes.
- Claude Code hooks also map `PostToolUse` → `working`, so the state returns to *working* after you approve a permission prompt.
- An extra **Forget** action removes git's record of an unreachable worktree (Review Focus 3).
- Besides polling while the view is visible, a slow 60 s background poll keeps the status bar and notifications current when the view is hidden.

## File Structure

```
.devcontainer/devcontainer.json      dev container (Node 22, latest git, xvfb)
.vscode/launch.json                  F5 "Run Extension"
.github/workflows/ci.yml             unit (3 OS), old-git (docker), vscode smoke
test/docker/old-git.Dockerfile       git 2.17 built from source for compatibility tests
package.json, tsconfig.json, tsconfig.vscode-test.json, esbuild.mjs, vitest.config.ts, .vscode-test.mjs
media/switchyard.svg                 activity-bar icon
src/
  extension.ts                       activation + wiring + refresh triggers + heartbeat timer
  core/
    paths.ts                         pathKey, samePath, isInside, toGitPath
    git/gitCli.ts                    runGit, GitError, version helpers
    git/porcelain.ts                 parseStatusV2, parseNameStatus, sumNumstat
    repoLocator.ts                   locateRepo
    repository.ts                    Repository<T>: debounced snapshot store with change events
    diff/refs.ts                     WORKING/EMPTY refs, sideRefsFor, readFileAtRef
    uris.ts                          toWorkspaceUri (vscode)
    diff/gitContentProvider.ts       switchyard-git: scheme (vscode)
    diff/openDiff.ts                 openChangeDiff (vscode)
  features/
    worktrees/layout.ts              names, .worktrees dir, info/exclude, branch-name validation
    worktrees/portability.ts         relative .git file, lock, back-pointer retarget
    worktrees/resolver.ts            resolveWorktrees
    worktrees/worktreeService.ts     list/create/remove/adopt/forget/branches
    worktrees/setup.ts               copySetupFiles
    workstreams/agentStatus.ts       workstream.json
    workstreams/heartbeat.ts         switchyard-window.json
    workstreams/activity.ts          lastActivity, classifyActivity
    workstreams/progress.ts          resolveBase, computeProgress
    workstreams/attention.ts         computeAttention, sortByAttention, attentionTransitions
    workstreams/workstream.ts        Workstream type + buildWorkstreams
    diffs/compare.ts                 compareWithBase
  ui/
    settings.ts                      readSettings (vscode)
    format.ts                        pure label/description/context helpers
    claudeHooks.ts                   pure hook snippet generator
    workstreamsView.ts               TreeDataProvider
    statusBar.ts                     status bar item
    notifications.ts                 attention notifications
    hygiene.ts                       one-time settings offer
    commands.ts                      all commands
tests/
  helpers/gitRepo.ts                 temp repos, git helper, second-environment simulation
  unit/**                            vitest tests mirroring src/
  vscode/prepareFixture.mjs, vscode/extension.test.ts   smoke test
```

---

### Task 1: Project scaffold, devcontainer and test helpers

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.mjs`, `vitest.config.ts`, `.gitignore`, `.gitattributes`, `.vscodeignore`, `.devcontainer/devcontainer.json`, `.vscode/launch.json`, `media/switchyard.svg`, `src/extension.ts`, `tests/helpers/gitRepo.ts`
- Test: `tests/unit/helpers.test.ts`

**Interfaces:**
- Produces (`tests/helpers/gitRepo.ts`): `git(cwd: string, ...args: string[]): string` (trimmed stdout, throws on failure), `makeTempDir(prefix?: string): string` (real path), `initRepo(dir?: string): string` (repo on `main` with one commit containing `README.md` = `"hello\n"`), `writeFile(root: string, rel: string, content: string): void`, `removeDir(dir: string): void`, `simulateOtherEnvironment(repo: string): string` (copies the repo to a new absolute path and renames the original to `<repo>-gone`; returns the new path), `expectSamePath(actual: string | undefined, expected: string): void`.

- [ ] **Step 1: Create config files**

`package.json`:
```json
{
  "name": "switchyard",
  "displayName": "Switchyard",
  "description": "Run parallel workstreams in git worktrees, across host and devcontainer.",
  "version": "0.0.1",
  "publisher": "archipelagic",
  "license": "MIT",
  "engines": { "vscode": "^1.95.0" },
  "categories": ["SCM Providers", "Other"],
  "extensionKind": ["workspace"],
  "main": "./dist/extension.js",
  "activationEvents": ["workspaceContains:.git"],
  "contributes": {},
  "scripts": {
    "build": "node esbuild.mjs",
    "watch": "node esbuild.mjs --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:vscode": "npm run build && node tests/vscode/prepareFixture.mjs && tsc -p tsconfig.vscode-test.json && vscode-test",
    "package": "vsce package"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true
  },
  "include": ["src", "tests/unit", "tests/helpers", "vitest.config.ts"]
}
```

`esbuild.mjs`:
```js
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
});
if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
```

`.gitignore`:
```
node_modules/
dist/
out/
.vscode-test/
*.vsix
```

`.gitattributes`:
```
* text=auto eol=lf
*.png binary
```

`.vscodeignore`:
```
**
!dist/**
!media/**
!package.json
!README.md
!LICENSE
```

`.devcontainer/devcontainer.json`:
```json
{
  "name": "switchyard-dev",
  "image": "mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm",
  "features": {
    "ghcr.io/devcontainers/features/git:1": { "version": "latest" }
  },
  "postCreateCommand": "git config --global --add safe.directory '*' && sudo apt-get update && sudo apt-get install -y --no-install-recommends xvfb libasound2 libgbm1 libgtk-3-0 libnss3 libxss1 libxkbfile1 libsecret-1-0 && npm ci",
  "customizations": {
    "vscode": {
      "extensions": ["vitest.explorer"]
    }
  }
}
```

`.vscode/launch.json`:
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "preLaunchTask": "npm: build"
    }
  ]
}
```

`media/switchyard.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 3v18M18 3v5c0 4-12 4-12 8M18 14v7"/><circle cx="18" cy="11" r="1.5"/></svg>
```

`src/extension.ts`:
```ts
import type * as vscode from 'vscode';

export function activate(_context: vscode.ExtensionContext): void {}

export function deactivate(): void {}
```

- [ ] **Step 2: Install dependencies**

Run:
```bash
npm install -D typescript esbuild vitest @types/node@22 @types/vscode@1.95.0 @types/mocha @vscode/test-cli @vscode/test-electron @vscode/vsce
npm install tinyglobby
```
Expected: `package.json` gains `devDependencies` and `dependencies`; `package-lock.json` is created.

- [ ] **Step 3: Write the test helpers**

`tests/helpers/gitRepo.ts`:
```ts
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect } from 'vitest';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

export function makeTempDir(prefix = 'switchyard-'): string {
  const base = fs.realpathSync.native(os.tmpdir());
  return fs.realpathSync.native(fs.mkdtempSync(path.join(base, prefix)));
}

export function initRepo(dir: string = makeTempDir()): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial');
  return fs.realpathSync.native(dir);
}

export function writeFile(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // best effort: temp dirs are cleaned by the OS eventually
  }
}

/** Copies the repo to a new absolute path and renames the original away, like a second environment seeing the repo at a different mount path. */
export function simulateOtherEnvironment(repo: string): string {
  const other = makeTempDir('switchyard-other-');
  fs.rmSync(other, { recursive: true, force: true });
  fs.cpSync(repo, other, { recursive: true });
  fs.renameSync(repo, `${repo}-gone`);
  return other;
}

function key(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function expectSamePath(actual: string | undefined, expected: string): void {
  expect(actual).toBeDefined();
  expect(key(actual as string)).toBe(key(expected));
}
```

- [ ] **Step 4: Write the helper test**

`tests/unit/helpers.test.ts`:
```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, initRepo, removeDir, simulateOtherEnvironment } from '../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

describe('test helpers', () => {
  it('creates a repo on main with one commit', () => {
    const repo = initRepo();
    cleanup.push(repo);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(repo, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('hello\n');
  });

  it('simulates a second environment by moving the repo', () => {
    const repo = initRepo();
    const other = simulateOtherEnvironment(repo);
    cleanup.push(other, `${repo}-gone`);
    expect(fs.existsSync(repo)).toBe(false);
    expect(git(other, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });
});
```

- [ ] **Step 5: Run tests, typecheck and build**

Run: `npm test && npm run typecheck && npm run build`
Expected: 2 tests PASS; typecheck has no errors; `dist/extension.js` is created.

- [ ] **Step 6: Normalize line endings and commit**

```bash
git add -A
git add --renormalize .
git commit -m "$(cat <<'EOF'
chore: scaffold extension, devcontainer and test helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Path helpers and git CLI wrapper

**Files:**
- Create: `src/core/paths.ts`, `src/core/git/gitCli.ts`
- Test: `tests/unit/core/paths.test.ts`, `tests/unit/core/gitCli.test.ts`

**Interfaces:**
- Produces (`paths.ts`): `pathKey(p: string): string`, `samePath(a: string, b: string): boolean`, `isInside(parent: string, child: string): boolean` (strictly inside), `toGitPath(p: string): string` (backslashes → `/`).
- Produces (`gitCli.ts`): `class GitError extends Error { args: readonly string[]; exitCode: number | null; stderr: string }`, `interface RunGitOptions { cwd: string; timeoutMs?: number }`, `runGit(args: readonly string[], opts: RunGitOptions): Promise<string>` (raw stdout), `type GitVersion = readonly [number, number, number]`, `MIN_GIT_VERSION: GitVersion` (= `[2, 17, 0]`), `parseGitVersion(output: string): GitVersion | undefined`, `versionAtLeast(v: GitVersion, min: GitVersion): boolean`, `getGitVersion(cwd: string): Promise<GitVersion | undefined>`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/core/paths.test.ts`:
```ts
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isInside, samePath, toGitPath } from '../../../src/core/paths';
import { makeTempDir } from '../../helpers/gitRepo';

describe('paths', () => {
  const tmp = makeTempDir();

  it('samePath ignores redundant segments', () => {
    expect(samePath(path.join(tmp, 'a'), path.join(tmp, 'a', '..', 'a'))).toBe(true);
    expect(samePath(path.join(tmp, 'a'), path.join(tmp, 'b'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('samePath is case-insensitive on Windows', () => {
    expect(samePath('C:\\Repo\\x', 'c:\\repo\\X')).toBe(true);
  });

  it('isInside is strict', () => {
    expect(isInside(tmp, path.join(tmp, 'x', 'y'))).toBe(true);
    expect(isInside(tmp, tmp)).toBe(false);
    expect(isInside(path.join(tmp, 'x'), tmp)).toBe(false);
    expect(isInside(path.join(tmp, 'x'), path.join(tmp, 'xy'))).toBe(false);
  });

  it('toGitPath uses forward slashes', () => {
    expect(toGitPath('a\\b\\c')).toBe('a/b/c');
    expect(toGitPath('a/b')).toBe('a/b');
  });
});
```

`tests/unit/core/gitCli.test.ts`:
```ts
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitError, getGitVersion, MIN_GIT_VERSION, parseGitVersion, runGit, versionAtLeast } from '../../../src/core/git/gitCli';
import { initRepo, makeTempDir, removeDir } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

describe('git version helpers', () => {
  it('parses version strings from different platforms', () => {
    expect(parseGitVersion('git version 2.31.1.windows.1\n')).toEqual([2, 31, 1]);
    expect(parseGitVersion('git version 2.39.5 (Apple Git-154)')).toEqual([2, 39, 5]);
    expect(parseGitVersion('git version 2.17')).toEqual([2, 17, 0]);
    expect(parseGitVersion('nonsense')).toBeUndefined();
  });

  it('compares versions', () => {
    expect(versionAtLeast([2, 17, 0], MIN_GIT_VERSION)).toBe(true);
    expect(versionAtLeast([2, 16, 9], MIN_GIT_VERSION)).toBe(false);
    expect(versionAtLeast([3, 0, 0], MIN_GIT_VERSION)).toBe(true);
    expect(versionAtLeast([2, 48, 1], [2, 48, 0])).toBe(true);
  });

  it('reads the installed git version', async () => {
    const v = await getGitVersion(makeTempDir());
    expect(v).toBeDefined();
    expect(versionAtLeast(v!, MIN_GIT_VERSION)).toBe(true);
  });
});

describe('runGit', () => {
  it('returns stdout', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    expect((await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo })).trim()).toBe('main');
  });

  it('throws GitError with exit code and stderr on failure', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const error = await runGit(['rev-parse', '--verify', 'does-not-exist'], { cwd: repo }).catch((e) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error.exitCode).toBe(128);
    expect(error.stderr).toMatch(/fatal/);
  });

  it('throws GitError with null exit code when the cwd is missing', async () => {
    const error = await runGit(['status'], { cwd: path.join(makeTempDir(), 'missing') }).catch((e) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error.exitCode).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/core`
Expected: FAIL, cannot resolve `src/core/paths` / `src/core/git/gitCli`.

- [ ] **Step 3: Implement**

`src/core/paths.ts`:
```ts
import * as path from 'node:path';

/** Normalized key for comparing paths in the current environment. */
export function pathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** True when child is strictly inside parent. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function toGitPath(p: string): string {
  return p.replace(/\\/g, '/');
}
```

`src/core/git/gitCli.ts`:
```ts
import { execFile } from 'node:child_process';

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed${exitCode === null ? '' : ` (exit ${exitCode})`}: ${stderr.trim() || 'no output'}`);
    this.name = 'GitError';
  }
}

export interface RunGitOptions {
  cwd: string;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

export function runGit(args: readonly string[], opts: RunGitOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as { code?: unknown }).code;
          reject(new GitError(args, typeof code === 'number' ? code : null, stderr || error.message));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

export type GitVersion = readonly [number, number, number];

export const MIN_GIT_VERSION: GitVersion = [2, 17, 0];

export function parseGitVersion(output: string): GitVersion | undefined {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
}

export function versionAtLeast(v: GitVersion, min: GitVersion): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

export async function getGitVersion(cwd: string): Promise<GitVersion | undefined> {
  try {
    return parseGitVersion(await runGit(['--version'], { cwd }));
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core tests/unit/core
git commit -m "$(cat <<'EOF'
feat(core): add path helpers and git CLI wrapper

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Porcelain parsers

**Files:**
- Create: `src/core/git/porcelain.ts`
- Test: `tests/unit/core/porcelain.test.ts`

**Interfaces:**
- Produces: `type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'`, `interface FileChange { path: string; origPath?: string; kind: ChangeKind }` (paths are repo-relative with `/`), `interface StatusBranch { oid?: string; head?: string; upstream?: string; ahead: number; behind: number }`, `parseStatusV2(out: string): { branch: StatusBranch; changes: FileChange[] }` (input: `git status --porcelain=v2 [--branch] -z`), `parseNameStatus(out: string): FileChange[]` (input: `git diff --name-status -z [-M]`), `sumNumstat(out: string): { added: number; deleted: number }` (input: `git diff --numstat -z`).

- [ ] **Step 1: Write the failing tests**

`tests/unit/core/porcelain.test.ts`:
```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseNameStatus, parseStatusV2, sumNumstat } from '../../../src/core/git/porcelain';
import { git, initRepo, removeDir } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

describe('parseStatusV2', () => {
  it('parses branch headers and every entry type, including spaces in paths', () => {
    const out = [
      '# branch.oid 1234567890abcdef',
      '# branch.head feature/x',
      '# branch.upstream origin/feature/x',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb src/a file.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts',
      'old name.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
      '? untracked file.txt',
      '1 D. N... 100644 000000 000000 aaa 000 gone.ts',
      '1 A. N... 000000 100644 100644 000 bbb added.ts',
      '',
    ].join('\0');
    const result = parseStatusV2(out);
    expect(result.branch).toEqual({ oid: '1234567890abcdef', head: 'feature/x', upstream: 'origin/feature/x', ahead: 2, behind: 1 });
    expect(result.changes).toEqual([
      { path: 'src/a file.ts', kind: 'modified' },
      { path: 'new name.ts', origPath: 'old name.ts', kind: 'renamed' },
      { path: 'conflict.txt', kind: 'conflicted' },
      { path: 'untracked file.txt', kind: 'untracked' },
      { path: 'gone.ts', kind: 'deleted' },
      { path: 'added.ts', kind: 'added' },
    ]);
  });

  it('handles initial and detached heads', () => {
    const result = parseStatusV2('# branch.oid (initial)\0# branch.head (detached)\0');
    expect(result.branch).toEqual({ oid: undefined, head: undefined, ahead: 0, behind: 0 });
  });

  it('parses real git output', () => {
    const repo = initRepo();
    cleanup.push(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'changed\n');
    fs.writeFileSync(path.join(repo, 'new ö.txt'), 'x\n');
    const out = git(repo, 'status', '--porcelain=v2', '--branch', '-z');
    const result = parseStatusV2(out);
    expect(result.branch.head).toBe('main');
    expect(result.changes).toEqual([
      { path: 'README.md', kind: 'modified' },
      { path: 'new ö.txt', kind: 'untracked' },
    ]);
  });
});

describe('parseNameStatus', () => {
  it('parses modifications, renames, additions and deletions', () => {
    const out = ['M', 'a.ts', 'R087', 'old.ts', 'new.ts', 'A', 'b.ts', 'D', 'c.ts', 'C75', 'src.ts', 'copy.ts', ''].join('\0');
    expect(parseNameStatus(out)).toEqual([
      { path: 'a.ts', kind: 'modified' },
      { path: 'new.ts', origPath: 'old.ts', kind: 'renamed' },
      { path: 'b.ts', kind: 'added' },
      { path: 'c.ts', kind: 'deleted' },
      { path: 'copy.ts', origPath: 'src.ts', kind: 'added' },
    ]);
  });

  it('returns an empty list for empty output', () => {
    expect(parseNameStatus('')).toEqual([]);
  });
});

describe('sumNumstat', () => {
  it('sums text changes, ignores binary files and skips rename path pairs', () => {
    const out = ['3\t1\ta.ts', '-\t-\tbin.png', '5\t0\t', 'old.ts', 'new.ts', ''].join('\0');
    expect(sumNumstat(out)).toEqual({ added: 8, deleted: 1 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/core/porcelain.test.ts`
Expected: FAIL, cannot resolve `src/core/git/porcelain`.

- [ ] **Step 3: Implement**

`src/core/git/porcelain.ts`:
```ts
export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface FileChange {
  path: string;
  origPath?: string;
  kind: ChangeKind;
}

export interface StatusBranch {
  oid?: string;
  head?: string;
  upstream?: string;
  ahead: number;
  behind: number;
}

/** Splits s into at most n parts; the last part keeps the remainder (paths may contain spaces). */
function splitN(s: string, sep: string, n: number): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let k = 0; k < n - 1; k++) {
    const idx = s.indexOf(sep, start);
    if (idx < 0) break;
    parts.push(s.slice(start, idx));
    start = idx + 1;
  }
  parts.push(s.slice(start));
  return parts;
}

function kindFromXY(xy: string): ChangeKind {
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('A')) return 'added';
  return 'modified';
}

export function parseStatusV2(out: string): { branch: StatusBranch; changes: FileChange[] } {
  const branch: StatusBranch = { ahead: 0, behind: 0 };
  const changes: FileChange[] = [];
  const records = out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec === '') continue;
    if (rec.startsWith('# ')) {
      const [key, ...rest] = rec.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') branch.oid = value === '(initial)' ? undefined : value;
      else if (key === 'branch.head') branch.head = value === '(detached)' ? undefined : value;
      else if (key === 'branch.upstream') branch.upstream = value;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          branch.ahead = Number(m[1]);
          branch.behind = Number(m[2]);
        }
      }
      continue;
    }
    const type = rec[0];
    if (type === '1') {
      const parts = splitN(rec, ' ', 9);
      changes.push({ path: parts[8], kind: kindFromXY(parts[1]) });
    } else if (type === '2') {
      const parts = splitN(rec, ' ', 10);
      const origPath = records[++i];
      changes.push({ path: parts[9], origPath, kind: parts[8].startsWith('C') ? 'added' : 'renamed' });
    } else if (type === 'u') {
      const parts = splitN(rec, ' ', 11);
      changes.push({ path: parts[10], kind: 'conflicted' });
    } else if (type === '?') {
      changes.push({ path: rec.slice(2), kind: 'untracked' });
    }
  }
  return { branch, changes };
}

export function parseNameStatus(out: string): FileChange[] {
  const tokens = out.split('\0');
  const result: FileChange[] = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i++];
    if (!status) continue;
    const c = status[0];
    if (c === 'R' || c === 'C') {
      const origPath = tokens[i++];
      const p = tokens[i++];
      result.push({ path: p, origPath, kind: c === 'R' ? 'renamed' : 'added' });
    } else {
      const p = tokens[i++];
      result.push({ path: p, kind: c === 'A' ? 'added' : c === 'D' ? 'deleted' : 'modified' });
    }
  }
  return result;
}

export function sumNumstat(out: string): { added: number; deleted: number } {
  const tokens = out.split('\0');
  let added = 0;
  let deleted = 0;
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i]);
    if (!m) continue;
    if (m[1] !== '-') added += Number(m[1]);
    if (m[2] !== '-') deleted += Number(m[2]);
    if (m[3] === '') i += 2;
  }
  return { added, deleted };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/core/porcelain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/git/porcelain.ts tests/unit/core/porcelain.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add porcelain parsers for status, name-status and numstat

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Repo locator

**Files:**
- Create: `src/core/repoLocator.ts`
- Test: `tests/unit/core/repoLocator.test.ts`

**Interfaces:**
- Consumes: `runGit` (Task 2).
- Produces: `interface RepoLocation { mainRoot: string; commonDir: string; worktreeRoot: string; gitDir: string }` (all absolute, native separators), `locateRepo(folder: string): Promise<RepoLocation | undefined>` (undefined for non-repos and bare repos).

- [ ] **Step 1: Write the failing test**

`tests/unit/core/repoLocator.test.ts`:
```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { locateRepo } from '../../../src/core/repoLocator';
import { expectSamePath, git, initRepo, makeTempDir, removeDir } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

describe('locateRepo', () => {
  it('locates the main worktree from its root and from a subfolder', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    fs.mkdirSync(path.join(repo, 'src'));
    for (const folder of [repo, path.join(repo, 'src')]) {
      const loc = await locateRepo(folder);
      expectSamePath(loc?.mainRoot, repo);
      expectSamePath(loc?.commonDir, path.join(repo, '.git'));
      expectSamePath(loc?.worktreeRoot, repo);
      expectSamePath(loc?.gitDir, path.join(repo, '.git'));
    }
  });

  it('locates the main repo from a linked worktree', async () => {
    const repo = initRepo();
    const wt = path.join(makeTempDir(), 'wt');
    cleanup.push(repo, path.dirname(wt));
    git(repo, 'worktree', 'add', '-b', 'feat', wt);
    const loc = await locateRepo(wt);
    expectSamePath(loc?.mainRoot, repo);
    expectSamePath(loc?.worktreeRoot, wt);
    expectSamePath(loc?.gitDir, path.join(repo, '.git', 'worktrees', 'wt'));
  });

  it('returns undefined outside a repository', async () => {
    const dir = makeTempDir();
    cleanup.push(dir);
    expect(await locateRepo(dir)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/repoLocator.test.ts`
Expected: FAIL, cannot resolve `src/core/repoLocator`.

- [ ] **Step 3: Implement**

`src/core/repoLocator.ts`:
```ts
import * as path from 'node:path';
import { runGit } from './git/gitCli';

export interface RepoLocation {
  /** Root of the main worktree (parent of the common .git dir). */
  mainRoot: string;
  /** The shared .git directory. */
  commonDir: string;
  /** Root of the worktree that contains the folder. */
  worktreeRoot: string;
  /** Git dir of that worktree (commonDir for the main worktree). */
  gitDir: string;
}

export async function locateRepo(folder: string): Promise<RepoLocation | undefined> {
  let out: string;
  try {
    out = await runGit(['rev-parse', '--show-toplevel', '--git-common-dir', '--git-dir'], { cwd: folder });
  } catch {
    return undefined;
  }
  const [top, common, gitDir] = out.split(/\r?\n/);
  if (!top || !common || !gitDir) return undefined;
  const commonDir = path.resolve(folder, common);
  if (path.basename(commonDir) !== '.git') return undefined;
  return {
    mainRoot: path.dirname(commonDir),
    commonDir,
    worktreeRoot: path.resolve(top),
    gitDir: path.resolve(folder, gitDir),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/core/repoLocator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/repoLocator.ts tests/unit/core/repoLocator.test.ts
git commit -m "$(cat <<'EOF'
feat(core): locate main repo from any worktree folder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Worktree layout (names, exclude, branch-name validation)

**Files:**
- Create: `src/features/worktrees/layout.ts`
- Test: `tests/unit/features/layout.test.ts`

**Interfaces:**
- Produces: `WORKTREES_DIR = '.worktrees'`, `worktreesRoot(mainRoot: string): string`, `sanitizeName(branch: string): string`, `uniqueName(base: string, taken: ReadonlySet<string>): string` (case-insensitive), `existingNames(mainRoot: string): Promise<Set<string>>`, `ensureExcluded(commonDir: string): Promise<boolean>` (true when it added the line), `branchNameProblem(name: string, existing: readonly string[]): string | undefined`.

- [ ] **Step 1: Write the failing test**

`tests/unit/features/layout.test.ts`:
```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { branchNameProblem, ensureExcluded, existingNames, sanitizeName, uniqueName, worktreesRoot } from '../../../src/features/worktrees/layout';
import { git, initRepo, removeDir } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

describe('sanitizeName', () => {
  it.each([
    ['feature/login', 'feature-login'],
    ['fix: thing?', 'fix-thing'],
    ['feat/ö-test', 'feat-ö-test'],
    ['..', 'worktree'],
    ['CON', 'CON-wt'],
    ['a\\b', 'a-b'],
  ])('%s -> %s', (input, expected) => {
    expect(sanitizeName(input)).toBe(expected);
  });
});

describe('uniqueName', () => {
  it('appends a numeric suffix, case-insensitively', () => {
    expect(uniqueName('a', new Set())).toBe('a');
    expect(uniqueName('a', new Set(['A']))).toBe('a-2');
    expect(uniqueName('a', new Set(['a', 'A-2']))).toBe('a-3');
  });
});

describe('existingNames', () => {
  it('lists folders under .worktrees, or nothing when it is missing', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    expect(await existingNames(repo)).toEqual(new Set());
    fs.mkdirSync(path.join(worktreesRoot(repo), 'x'), { recursive: true });
    expect(await existingNames(repo)).toEqual(new Set(['x']));
  });
});

describe('ensureExcluded', () => {
  it('adds /.worktrees/ to info/exclude once and git ignores the folder', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const commonDir = path.join(repo, '.git');
    fs.writeFileSync(path.join(commonDir, 'info', 'exclude'), '# existing\nfoo');
    expect(await ensureExcluded(commonDir)).toBe(true);
    expect(await ensureExcluded(commonDir)).toBe(false);
    expect(fs.readFileSync(path.join(commonDir, 'info', 'exclude'), 'utf8')).toBe('# existing\nfoo\n/.worktrees/\n');
    fs.mkdirSync(path.join(repo, '.worktrees', 'x'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.worktrees', 'x', 'f.txt'), 'x');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});

describe('branchNameProblem', () => {
  it('accepts normal names', () => {
    expect(branchNameProblem('feat/x', ['main'])).toBeUndefined();
  });
  it.each(['', '   '])('rejects empty %j', (name) => {
    expect(branchNameProblem(name, [])).toBe('Enter a branch name.');
  });
  it('rejects existing names', () => {
    expect(branchNameProblem('main', ['main'])).toBe("A branch named 'main' already exists.");
  });
  it.each(['a b', '-x', 'x.lock', 'a..b', 'x/', 'a//b', 'a~1', 'a:b', 'a@{1}', '.x'])('rejects invalid %j', (name) => {
    expect(branchNameProblem(name, [])).toBe(`'${name}' is not a valid branch name.`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/features/layout.test.ts`
Expected: FAIL, cannot resolve `layout`.

- [ ] **Step 3: Implement**

`src/features/worktrees/layout.ts`:
```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const WORKTREES_DIR = '.worktrees';
const EXCLUDE_LINE = '/.worktrees/';
const EXCLUDE_VARIANTS = ['.worktrees', '.worktrees/', '/.worktrees', '/.worktrees/'];
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const INVALID_BRANCH = /^[-./]|[./]$|\.\.|[\s~^:?*[\\\x00-\x1f\x7f]|@\{|\.lock(\/|$)|\/\/|\/\./;

export function worktreesRoot(mainRoot: string): string {
  return path.join(mainRoot, WORKTREES_DIR);
}

export function sanitizeName(branch: string): string {
  const cleaned = branch.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (!cleaned) return 'worktree';
  return WINDOWS_RESERVED.test(cleaned) ? `${cleaned}-wt` : cleaned;
}

export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

export async function existingNames(mainRoot: string): Promise<Set<string>> {
  try {
    const entries = await fs.readdir(worktreesRoot(mainRoot), { withFileTypes: true });
    return new Set(entries.map((e) => e.name));
  } catch {
    return new Set();
  }
}

export async function ensureExcluded(commonDir: string): Promise<boolean> {
  const file = path.join(commonDir, 'info', 'exclude');
  let content = '';
  try {
    content = await fs.readFile(file, 'utf8');
  } catch {
    // no exclude file yet
  }
  const lines = content.split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => EXCLUDE_VARIANTS.includes(l))) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const prefix = content === '' || content.endsWith('\n') ? '' : '\n';
  await fs.appendFile(file, `${prefix}${EXCLUDE_LINE}\n`);
  return true;
}

export function branchNameProblem(name: string, existing: readonly string[]): string | undefined {
  if (!name.trim()) return 'Enter a branch name.';
  if (existing.includes(name)) return `A branch named '${name}' already exists.`;
  if (INVALID_BRANCH.test(name)) return `'${name}' is not a valid branch name.`;
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/features/layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/worktrees/layout.ts tests/unit/features/layout.test.ts
git commit -m "$(cat <<'EOF'
feat(worktrees): add layout helpers for .worktrees naming and exclude

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Portability (relative `.git` file, lock, back-pointer retarget)

**Files:**
- Create: `src/features/worktrees/portability.ts`
- Test: `tests/unit/features/portability.test.ts`

**Interfaces:**
- Consumes: `samePath`, `toGitPath` (Task 2).
- Produces: `LOCK_REASON = 'switchyard: portable'`, `readGitFile(worktreeDir: string): Promise<string | undefined>` (raw `gitdir:` value), `resolveGitdir(worktreeDir: string, value: string): string`, `isRelativeGitdir(value: string): boolean`, `relativeGitdir(worktreeDir: string, adminDir: string): string | undefined`, `readLock(adminDir: string): Promise<string | undefined>` (lock reason, `''` when locked without a reason, undefined when unlocked), `isLocked(adminDir: string): Promise<boolean>`, `lock(adminDir: string, reason?: string): Promise<void>`, `unlock(adminDir: string): Promise<void>`, `isPortable(worktreeDir: string, adminDir: string): Promise<boolean>`, `makePortable(worktreeDir: string, adminDir: string): Promise<boolean>` (false when no relative path exists, e.g. different Windows drives), `readBackPointer(adminDir: string): Promise<string | undefined>`, `retargetBackPointer(worktreeDir: string, adminDir: string): Promise<boolean>` (true when it rewrote the file).

- [ ] **Step 1: Write the failing test**

`tests/unit/features/portability.test.ts`:
```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isPortable,
  LOCK_REASON,
  makePortable,
  readGitFile,
  relativeGitdir,
  resolveGitdir,
  retargetBackPointer,
  unlock,
} from '../../../src/features/worktrees/portability';
import { git, initRepo, makeTempDir, removeDir, simulateOtherEnvironment } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

async function addWorktree(repo: string, name: string): Promise<{ dir: string; admin: string }> {
  const dir = path.join(repo, '.worktrees', name);
  git(repo, 'worktree', 'add', '-b', name, dir);
  const value = await readGitFile(dir);
  return { dir, admin: resolveGitdir(dir, value!) };
}

describe('relativeGitdir', () => {
  it('computes a forward-slash relative path', () => {
    const root = makeTempDir();
    cleanup.push(root);
    expect(relativeGitdir(path.join(root, '.worktrees', 'a'), path.join(root, '.git', 'worktrees', 'a'))).toBe('../../.git/worktrees/a');
  });
});

describe('makePortable', () => {
  it('rewrites the .git file to a relative path and locks the worktree', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const { dir, admin } = await addWorktree(repo, 'feat');
    expect(await isPortable(dir, admin)).toBe(false);
    expect(await makePortable(dir, admin)).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.git'), 'utf8')).toBe('gitdir: ../../.git/worktrees/feat\n');
    expect(fs.readFileSync(path.join(admin, 'locked'), 'utf8').trim()).toBe(LOCK_REASON);
    expect(await isPortable(dir, admin)).toBe(true);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat');
  });

  it('keeps an existing lock and its reason', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const { dir, admin } = await addWorktree(repo, 'feat');
    git(repo, 'worktree', 'lock', '--reason', 'mine', dir);
    await makePortable(dir, admin);
    expect(fs.readFileSync(path.join(admin, 'locked'), 'utf8').trim()).toBe('mine');
  });
});

describe('second environment (repo seen at a different absolute path)', () => {
  it('portable worktrees keep working, plain ones break, prune keeps locked entries', async () => {
    const repo = initRepo();
    const portable = await addWorktree(repo, 'feat');
    await makePortable(portable.dir, portable.admin);
    await addWorktree(repo, 'plain');
    const other = simulateOtherEnvironment(repo);
    cleanup.push(other, `${repo}-gone`);

    expect(git(path.join(other, '.worktrees', 'feat'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat');
    expect(() => git(path.join(other, '.worktrees', 'plain'), 'status')).toThrow();

    git(other, 'worktree', 'prune');
    expect(fs.existsSync(path.join(other, '.git', 'worktrees', 'feat'))).toBe(true);
  });

  it('retargeting the back-pointer lets git worktree remove work there', async () => {
    const repo = initRepo();
    const { dir, admin } = await addWorktree(repo, 'feat');
    await makePortable(dir, admin);
    const other = simulateOtherEnvironment(repo);
    cleanup.push(other, `${repo}-gone`);
    const movedDir = path.join(other, '.worktrees', 'feat');
    const movedAdmin = path.join(other, '.git', 'worktrees', 'feat');

    expect(await retargetBackPointer(movedDir, movedAdmin)).toBe(true);
    expect(await retargetBackPointer(movedDir, movedAdmin)).toBe(false);
    await unlock(movedAdmin);
    git(other, 'worktree', 'remove', movedDir);
    expect(fs.existsSync(movedDir)).toBe(false);
    expect(fs.existsSync(movedAdmin)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/features/portability.test.ts`
Expected: FAIL, cannot resolve `portability`.

- [ ] **Step 3: Implement**

`src/features/worktrees/portability.ts`:
```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { samePath, toGitPath } from '../../core/paths';

export const LOCK_REASON = 'switchyard: portable';

/** Returns the raw value of the `gitdir:` line in <worktreeDir>/.git, or undefined if it isn't a gitdir file. */
export async function readGitFile(worktreeDir: string): Promise<string | undefined> {
  try {
    const text = await fs.readFile(path.join(worktreeDir, '.git'), 'utf8');
    return /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
  } catch {
    return undefined; // missing, or .git is a directory
  }
}

export function resolveGitdir(worktreeDir: string, value: string): string {
  return path.resolve(worktreeDir, value);
}

export function isRelativeGitdir(value: string): boolean {
  return !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value);
}

export function relativeGitdir(worktreeDir: string, adminDir: string): string | undefined {
  const rel = path.relative(worktreeDir, adminDir);
  if (path.isAbsolute(rel)) return undefined; // e.g. different drive on Windows
  return toGitPath(rel);
}

export async function readLock(adminDir: string): Promise<string | undefined> {
  try {
    return (await fs.readFile(path.join(adminDir, 'locked'), 'utf8')).trim();
  } catch {
    return undefined;
  }
}

export async function isLocked(adminDir: string): Promise<boolean> {
  return (await readLock(adminDir)) !== undefined;
}

export async function lock(adminDir: string, reason: string = LOCK_REASON): Promise<void> {
  await fs.writeFile(path.join(adminDir, 'locked'), `${reason}\n`);
}

export async function unlock(adminDir: string): Promise<void> {
  await fs.rm(path.join(adminDir, 'locked'), { force: true });
}

export async function isPortable(worktreeDir: string, adminDir: string): Promise<boolean> {
  const value = await readGitFile(worktreeDir);
  return value !== undefined && isRelativeGitdir(value) && (await isLocked(adminDir));
}

export async function makePortable(worktreeDir: string, adminDir: string): Promise<boolean> {
  const rel = relativeGitdir(worktreeDir, adminDir);
  if (!rel) return false;
  await fs.writeFile(path.join(worktreeDir, '.git'), `gitdir: ${rel}\n`);
  if (!(await isLocked(adminDir))) await lock(adminDir);
  return true;
}

export async function readBackPointer(adminDir: string): Promise<string | undefined> {
  try {
    return (await fs.readFile(path.join(adminDir, 'gitdir'), 'utf8')).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Points .git/worktrees/<id>/gitdir at the worktree as seen from this environment (what `git worktree repair` does in 2.29+). */
export async function retargetBackPointer(worktreeDir: string, adminDir: string): Promise<boolean> {
  const target = path.join(worktreeDir, '.git');
  const current = await readBackPointer(adminDir);
  if (current && samePath(current, target)) return false;
  await fs.writeFile(path.join(adminDir, 'gitdir'), `${toGitPath(target)}\n`);
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/features/portability.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/worktrees/portability.ts tests/unit/features/portability.test.ts
git commit -m "$(cat <<'EOF'
feat(worktrees): make worktrees portable across environments

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Worktree resolver

**Files:**
- Create: `src/features/worktrees/resolver.ts`
- Test: `tests/unit/features/resolver.test.ts`

**Interfaces:**
- Consumes: `pathKey`, `samePath`, `isInside` (Task 2); `worktreesRoot` (Task 5); `readGitFile`, `resolveGitdir`, `readBackPointer`, `isLocked`, `isPortable` (Task 6).
- Produces: `interface RepoRoots { mainRoot: string; commonDir: string }`, `interface ResolvedWorktree { id: string | undefined; isMain: boolean; adminDir: string; path: string | undefined; recordedPath: string; branch: string | undefined; head: string | undefined; locked: boolean; portable: boolean; insideRepo: boolean }`, `readHead(adminDir: string): Promise<{ branch?: string; head?: string }>`, `resolveWorktrees(roots: RepoRoots): Promise<ResolvedWorktree[]>` (main first, then linked sorted by id). `adminDir` is also that worktree's git dir (`git rev-parse --git-dir`).

- [ ] **Step 1: Write the failing test**

`tests/unit/features/resolver.test.ts`:
```ts
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makePortable } from '../../../src/features/worktrees/portability';
import { resolveWorktrees, type ResolvedWorktree } from '../../../src/features/worktrees/resolver';
import { expectSamePath, git, initRepo, makeTempDir, removeDir, simulateOtherEnvironment } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

const roots = (repo: string) => ({ mainRoot: repo, commonDir: path.join(repo, '.git') });
const byId = (list: ResolvedWorktree[], id: string) => list.find((w) => w.id === id)!;

describe('resolveWorktrees', () => {
  it('returns only the main worktree for a fresh repo', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const list = await resolveWorktrees(roots(repo));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: undefined, isMain: true, branch: 'main', portable: true, insideRepo: false });
    expectSamePath(list[0].path, repo);
  });

  it('resolves inside, outside and detached worktrees', async () => {
    const repo = initRepo();
    const outsideParent = makeTempDir();
    cleanup.push(repo, outsideParent);
    git(repo, 'worktree', 'add', '-b', 'in', path.join(repo, '.worktrees', 'in'));
    git(repo, 'worktree', 'add', '-b', 'out', path.join(outsideParent, 'out'));
    git(repo, 'worktree', 'add', '--detach', path.join(repo, '.worktrees', 'det'), 'HEAD');

    const list = await resolveWorktrees(roots(repo));
    expect(list.map((w) => w.id)).toEqual([undefined, 'det', 'in', 'out']);
    expect(byId(list, 'in')).toMatchObject({ branch: 'in', insideRepo: true, portable: false, locked: false });
    expectSamePath(byId(list, 'in').path, path.join(repo, '.worktrees', 'in'));
    expect(byId(list, 'out')).toMatchObject({ branch: 'out', insideRepo: false });
    expect(byId(list, 'det').branch).toBeUndefined();
    expect(byId(list, 'det').head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('finds portable worktrees through the .worktrees scan in another environment and marks others unreachable', async () => {
    const repo = initRepo();
    const outsideParent = makeTempDir();
    const inDir = path.join(repo, '.worktrees', 'in');
    git(repo, 'worktree', 'add', '-b', 'in', inDir);
    await makePortable(inDir, path.join(repo, '.git', 'worktrees', 'in'));
    git(repo, 'worktree', 'add', '-b', 'out', path.join(outsideParent, 'out'));
    const other = simulateOtherEnvironment(repo);
    cleanup.push(other, `${repo}-gone`, outsideParent);

    const list = await resolveWorktrees(roots(other));
    const inWt = byId(list, 'in');
    expectSamePath(inWt.path, path.join(other, '.worktrees', 'in'));
    expect(inWt).toMatchObject({ portable: true, locked: true, insideRepo: true });
    expectSamePath(inWt.recordedPath, inDir);
    const outWt = byId(list, 'out');
    expect(outWt.path).toBeUndefined();
    expectSamePath(outWt.recordedPath, path.join(outsideParent, 'out'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/features/resolver.test.ts`
Expected: FAIL, cannot resolve `resolver`.

- [ ] **Step 3: Implement**

`src/features/worktrees/resolver.ts`:
```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isInside, pathKey, samePath } from '../../core/paths';
import { worktreesRoot } from './layout';
import { isLocked, isPortable, readBackPointer, readGitFile, resolveGitdir } from './portability';

export interface RepoRoots {
  mainRoot: string;
  commonDir: string;
}

export interface ResolvedWorktree {
  /** Name of the admin dir under .git/worktrees; undefined for the main worktree. */
  id: string | undefined;
  isMain: boolean;
  /** .git/worktrees/<id> (commonDir for main). Also this worktree's git dir. */
  adminDir: string;
  /** Location in THIS environment; undefined when unreachable. */
  path: string | undefined;
  /** Location as recorded by git (may be another environment's path). */
  recordedPath: string;
  branch: string | undefined;
  head: string | undefined;
  locked: boolean;
  portable: boolean;
  insideRepo: boolean;
}

export async function readHead(adminDir: string): Promise<{ branch?: string; head?: string }> {
  try {
    const text = (await fs.readFile(path.join(adminDir, 'HEAD'), 'utf8')).trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
    return m ? { branch: m[1] } : { head: text };
  } catch {
    return {};
  }
}

async function pointsBackTo(worktreeDir: string, adminDir: string): Promise<boolean> {
  const value = await readGitFile(worktreeDir);
  return value !== undefined && samePath(resolveGitdir(worktreeDir, value), adminDir);
}

async function scanWorktreesDir(mainRoot: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const root = worktreesRoot(mainRoot);
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const value = await readGitFile(dir);
    if (value) found.set(pathKey(resolveGitdir(dir, value)), dir);
  }
  return found;
}

export async function resolveWorktrees(roots: RepoRoots): Promise<ResolvedWorktree[]> {
  const mainHead = await readHead(roots.commonDir);
  const result: ResolvedWorktree[] = [
    {
      id: undefined,
      isMain: true,
      adminDir: roots.commonDir,
      path: roots.mainRoot,
      recordedPath: roots.mainRoot,
      branch: mainHead.branch,
      head: mainHead.head,
      locked: false,
      portable: true,
      insideRepo: false,
    },
  ];

  let ids: string[] = [];
  try {
    const entries = await fs.readdir(path.join(roots.commonDir, 'worktrees'), { withFileTypes: true });
    ids = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return result;
  }
  const scanned = await scanWorktreesDir(roots.mainRoot);

  for (const id of ids) {
    const adminDir = path.join(roots.commonDir, 'worktrees', id);
    const back = await readBackPointer(adminDir);
    const recordedPath = back ? path.dirname(back) : '';
    let location: string | undefined;
    if (back && (await pointsBackTo(recordedPath, adminDir))) location = path.resolve(recordedPath);
    location ??= scanned.get(pathKey(adminDir));
    const head = await readHead(adminDir);
    result.push({
      id,
      isMain: false,
      adminDir,
      path: location,
      recordedPath,
      branch: head.branch,
      head: head.head,
      locked: await isLocked(adminDir),
      portable: location ? await isPortable(location, adminDir) : false,
      insideRepo: location ? isInside(roots.mainRoot, location) : false,
    });
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/features/resolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/worktrees/resolver.ts tests/unit/features/resolver.test.ts
git commit -m "$(cat <<'EOF'
feat(worktrees): resolve worktree locations per environment

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Worktree service

**Files:**
- Create: `src/features/worktrees/worktreeService.ts`
- Test: `tests/unit/features/worktreeService.test.ts`

**Interfaces:**
- Consumes: `runGit` (Task 2), `parseStatusV2` (Task 3), `samePath` (Task 2), layout (Task 5), portability (Task 6), `resolveWorktrees`, `RepoRoots`, `ResolvedWorktree` (Task 7).
- Produces:
  - `type CreateRequest = { kind: 'new'; branch: string; startPoint?: string } | { kind: 'existing'; branch: string } | { kind: 'remote'; remoteRef: string; localBranch?: string }`
  - `interface BranchList { local: string[]; remote: string[] }`
  - `interface RemovalRisks { changedFiles: number; unmergedCommits: number }`
  - `class WorktreeService { constructor(roots: RepoRoots, options: () => { autoAdopt: boolean }); readonly roots: RepoRoots; list(): Promise<ResolvedWorktree[]>; listBranches(): Promise<BranchList>; create(req: CreateRequest): Promise<ResolvedWorktree>; adopt(wt: ResolvedWorktree): Promise<void>; removalRisks(wt: ResolvedWorktree): Promise<RemovalRisks>; remove(wt: ResolvedWorktree, opts: { force: boolean }): Promise<void>; forget(wt: ResolvedWorktree): Promise<void>; deleteBranch(branch: string, force: boolean): Promise<void> }`

- [ ] **Step 1: Write the failing test**

`tests/unit/features/worktreeService.test.ts`:
```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitError } from '../../../src/core/git/gitCli';
import { WorktreeService } from '../../../src/features/worktrees/worktreeService';
import { expectSamePath, git, initRepo, makeTempDir, removeDir, simulateOtherEnvironment, writeFile } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

function service(repo: string, autoAdopt = true): WorktreeService {
  return new WorktreeService({ mainRoot: repo, commonDir: path.join(repo, '.git') }, () => ({ autoAdopt }));
}

describe('WorktreeService.create', () => {
  it('creates a portable worktree for a new branch under .worktrees', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const wt = await service(repo).create({ kind: 'new', branch: 'feature/login' });
    expectSamePath(wt.path, path.join(repo, '.worktrees', 'feature-login'));
    expect(wt).toMatchObject({ branch: 'feature/login', portable: true, insideRepo: true });
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('adds a suffix when the folder name is taken', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const s = service(repo);
    await s.create({ kind: 'new', branch: 'feat/a' });
    const second = await s.create({ kind: 'new', branch: 'feat-a' });
    expectSamePath(second.path, path.join(repo, '.worktrees', 'feat-a-2'));
  });

  it('creates from an existing local branch', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    git(repo, 'branch', 'existing');
    const wt = await service(repo).create({ kind: 'existing', branch: 'existing' });
    expect(wt.branch).toBe('existing');
  });

  it('creates a tracking branch from a remote branch', async () => {
    const repo = initRepo();
    const origin = makeTempDir();
    cleanup.push(repo, origin);
    git(origin, 'init', '-q', '--bare');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'checkout', '-q', '-b', 'remote-only');
    writeFile(repo, 'r.txt', 'r\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'remote work');
    git(repo, 'push', '-q', 'origin', 'remote-only');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'branch', '-q', '-D', 'remote-only');

    const s = service(repo);
    expect((await s.listBranches()).remote).toEqual(['origin/remote-only']);
    const wt = await s.create({ kind: 'remote', remoteRef: 'origin/remote-only' });
    expect(wt.branch).toBe('remote-only');
    expect(git(wt.path!, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/remote-only');
  });

  it('works when the repo path has spaces and non-ASCII characters', async () => {
    const parent = makeTempDir();
    cleanup.push(parent);
    const repo = initRepo(path.join(parent, 'my repo ö'));
    const s = service(repo);
    const wt = await s.create({ kind: 'new', branch: 'feat/ö-test' });
    expectSamePath(wt.path, path.join(repo, '.worktrees', 'feat-ö-test'));
    expect(git(wt.path!, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/ö-test');
    await s.remove(wt, { force: false });
    expect(fs.existsSync(wt.path!)).toBe(false);
  });
});

describe('WorktreeService.list (adoption)', () => {
  it('auto-adopts plain worktrees inside the repo but never touches outside ones', async () => {
    const repo = initRepo();
    const outsideParent = makeTempDir();
    cleanup.push(repo, outsideParent);
    git(repo, 'worktree', 'add', '-b', 'in', path.join(repo, '.worktrees', 'in'));
    git(repo, 'worktree', 'add', '-b', 'out', path.join(outsideParent, 'out'));
    const outGitFile = fs.readFileSync(path.join(outsideParent, 'out', '.git'), 'utf8');

    const list = await service(repo).list();
    expect(list.find((w) => w.id === 'in')!.portable).toBe(true);
    expect(list.find((w) => w.id === 'out')!.portable).toBe(false);
    expect(fs.readFileSync(path.join(outsideParent, 'out', '.git'), 'utf8')).toBe(outGitFile);
  });

  it('leaves worktrees alone when autoAdopt is off, and adopt() makes one portable', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    git(repo, 'worktree', 'add', '-b', 'in', path.join(repo, '.worktrees', 'in'));
    const s = service(repo, false);
    const wt = (await s.list()).find((w) => w.id === 'in')!;
    expect(wt.portable).toBe(false);
    await s.adopt(wt);
    expect((await s.list()).find((w) => w.id === 'in')!.portable).toBe(true);
  });
});

describe('WorktreeService.remove', () => {
  it('reports risks and refuses to remove a dirty worktree without force', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const s = service(repo);
    const wt = await s.create({ kind: 'new', branch: 'feat' });
    writeFile(wt.path!, 'README.md', 'changed\n');
    writeFile(wt.path!, 'new.txt', 'x\n');
    git(wt.path!, 'commit', '-q', '-am', 'branch-only commit');
    writeFile(wt.path!, 'README.md', 'dirty\n');

    expect(await s.removalRisks(wt)).toEqual({ changedFiles: 2, unmergedCommits: 1 });
    await expect(s.remove(wt, { force: false })).rejects.toBeInstanceOf(GitError);
    expect((await s.list()).find((w) => w.id === wt.id)!.locked).toBe(true);

    await s.remove(wt, { force: true });
    expect(fs.existsSync(wt.path!)).toBe(false);
    expect(fs.existsSync(wt.adminDir)).toBe(false);
    await s.deleteBranch('feat', true);
    expect(git(repo, 'branch', '--list', 'feat')).toBe('');
  });

  it('removes a worktree from the other environment', async () => {
    const repo = initRepo();
    const created = await service(repo).create({ kind: 'new', branch: 'feat' });
    expect(created.portable).toBe(true);
    const other = simulateOtherEnvironment(repo);
    cleanup.push(other, `${repo}-gone`);
    const s = service(other);
    const wt = (await s.list()).find((w) => w.branch === 'feat')!;
    expectSamePath(wt.path, path.join(other, '.worktrees', 'feat'));
    await s.remove(wt, { force: false });
    expect(fs.existsSync(path.join(other, '.worktrees', 'feat'))).toBe(false);
  });

  it('forgets an unreachable worktree whose folder was deleted by hand', async () => {
    const repo = initRepo();
    const outsideParent = makeTempDir();
    cleanup.push(repo, outsideParent);
    const dir = path.join(outsideParent, 'gone');
    git(repo, 'worktree', 'add', '-b', 'gone', dir);
    git(repo, 'worktree', 'lock', dir);
    removeDir(dir);
    const s = service(repo);
    const wt = (await s.list()).find((w) => w.branch === 'gone')!;
    expect(wt.path).toBeUndefined();
    await s.forget(wt);
    expect((await s.list()).some((w) => w.branch === 'gone')).toBe(false);
    await expect(s.forget((await s.list())[0])).rejects.toThrow(/unreachable/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/features/worktreeService.test.ts`
Expected: FAIL, cannot resolve `worktreeService`.

- [ ] **Step 3: Implement**

`src/features/worktrees/worktreeService.ts`:
```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runGit } from '../../core/git/gitCli';
import { parseStatusV2 } from '../../core/git/porcelain';
import { samePath } from '../../core/paths';
import { ensureExcluded, existingNames, sanitizeName, uniqueName, worktreesRoot } from './layout';
import { lock, makePortable, readGitFile, readLock, resolveGitdir, retargetBackPointer, unlock } from './portability';
import { resolveWorktrees, type RepoRoots, type ResolvedWorktree } from './resolver';

export type CreateRequest =
  | { kind: 'new'; branch: string; startPoint?: string }
  | { kind: 'existing'; branch: string }
  | { kind: 'remote'; remoteRef: string; localBranch?: string };

export interface BranchList {
  local: string[];
  remote: string[];
}

export interface RemovalRisks {
  /** Uncommitted + untracked entries that would be deleted. */
  changedFiles: number;
  /** Commits only reachable from this worktree's branch. */
  unmergedCommits: number;
}

const ADD_TIMEOUT_MS = 120_000;

export class WorktreeService {
  constructor(
    readonly roots: RepoRoots,
    private readonly options: () => { autoAdopt: boolean },
  ) {}

  async list(): Promise<ResolvedWorktree[]> {
    const worktrees = await resolveWorktrees(this.roots);
    if (!this.options().autoAdopt) return worktrees;
    let adopted = false;
    for (const wt of worktrees) {
      if (!wt.isMain && wt.path && wt.insideRepo && !wt.portable) {
        adopted = (await makePortable(wt.path, wt.adminDir)) || adopted;
      }
    }
    return adopted ? resolveWorktrees(this.roots) : worktrees;
  }

  async listBranches(): Promise<BranchList> {
    const out = await runGit(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], { cwd: this.roots.mainRoot });
    const local: string[] = [];
    const remote: string[] = [];
    for (const ref of out.split(/\r?\n/)) {
      if (ref.startsWith('refs/heads/')) local.push(ref.slice('refs/heads/'.length));
      else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) remote.push(ref.slice('refs/remotes/'.length));
    }
    return { local, remote };
  }

  async create(req: CreateRequest): Promise<ResolvedWorktree> {
    const branch = req.kind === 'remote' ? (req.localBranch ?? req.remoteRef.split('/').slice(1).join('/')) : req.branch;
    const name = uniqueName(sanitizeName(branch), await existingNames(this.roots.mainRoot));
    const dir = path.join(worktreesRoot(this.roots.mainRoot), name);
    await ensureExcluded(this.roots.commonDir);
    const args =
      req.kind === 'new'
        ? ['worktree', 'add', '-b', branch, dir, req.startPoint ?? 'HEAD']
        : req.kind === 'existing'
          ? ['worktree', 'add', dir, branch]
          : ['worktree', 'add', '--track', '-b', branch, dir, req.remoteRef];
    await runGit(args, { cwd: this.roots.mainRoot, timeoutMs: ADD_TIMEOUT_MS });
    const value = await readGitFile(dir);
    if (!value) throw new Error(`git worktree add did not create ${path.join(dir, '.git')}`);
    const adminDir = resolveGitdir(dir, value);
    await makePortable(dir, adminDir);
    const created = (await resolveWorktrees(this.roots)).find((w) => samePath(w.adminDir, adminDir));
    if (!created) throw new Error(`Created worktree at ${dir} but could not resolve it.`);
    return created;
  }

  async adopt(wt: ResolvedWorktree): Promise<void> {
    if (!wt.path) throw new Error('This worktree is not reachable from this environment.');
    if (!(await makePortable(wt.path, wt.adminDir))) {
      throw new Error(`Cannot make ${wt.path} portable: it has no relative path to ${wt.adminDir}.`);
    }
  }

  async removalRisks(wt: ResolvedWorktree): Promise<RemovalRisks> {
    let changedFiles = 0;
    if (wt.path) {
      changedFiles = parseStatusV2(await runGit(['status', '--porcelain=v2', '-z'], { cwd: wt.path })).changes.length;
    }
    let unmergedCommits = 0;
    if (wt.branch) {
      const ref = `refs/heads/${wt.branch}`;
      const out = await runGit(['rev-list', '--count', ref, '--not', `--exclude=${ref}`, '--branches', '--remotes'], { cwd: this.roots.mainRoot });
      unmergedCommits = Number(out.trim());
    }
    return { changedFiles, unmergedCommits };
  }

  async remove(wt: ResolvedWorktree, opts: { force: boolean }): Promise<void> {
    if (wt.isMain) throw new Error('The main worktree cannot be removed.');
    if (!wt.path) throw new Error('This worktree is not reachable from this environment.');
    await retargetBackPointer(wt.path, wt.adminDir);
    const previousLock = await readLock(wt.adminDir);
    await unlock(wt.adminDir);
    try {
      await runGit(['worktree', 'remove', ...(opts.force ? ['--force'] : []), wt.path], { cwd: this.roots.mainRoot, timeoutMs: ADD_TIMEOUT_MS });
    } catch (error) {
      if (previousLock !== undefined) await lock(wt.adminDir, previousLock);
      throw error;
    }
  }

  /** Deletes git's record of a worktree that is unreachable here. Never touches worktree files. */
  async forget(wt: ResolvedWorktree): Promise<void> {
    if (wt.isMain || wt.path) throw new Error('Only worktrees that are unreachable from this environment can be forgotten.');
    await fs.rm(wt.adminDir, { recursive: true, force: true });
  }

  async deleteBranch(branch: string, force: boolean): Promise<void> {
    await runGit(['branch', force ? '-D' : '-d', branch], { cwd: this.roots.mainRoot });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/features/worktreeService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/worktrees/worktreeService.ts tests/unit/features/worktreeService.test.ts
git commit -m "$(cat <<'EOF'
feat(worktrees): add worktree service for create, adopt, remove and forget

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Setup file copying

**Files:**
- Create: `src/features/worktrees/setup.ts`
- Test: `tests/unit/features/setup.test.ts`

**Interfaces:**
- Consumes: `WORKTREES_DIR` (Task 5).
- Produces: `copySetupFiles(mainRoot: string, worktreeDir: string, patterns: readonly string[]): Promise<string[]>` (sorted repo-relative paths that were copied; never overwrites).

- [ ] **Step 1: Write the failing test**

`tests/unit/features/setup.test.ts`:
```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copySetupFiles } from '../../../src/features/worktrees/setup';
import { makeTempDir, removeDir, writeFile } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

describe('copySetupFiles', () => {
  it('copies matching files, keeps relative paths and never overwrites', async () => {
    const main = makeTempDir();
    const wt = makeTempDir();
    cleanup.push(main, wt);
    writeFile(main, '.env', 'A=1\n');
    writeFile(main, '.env.local', 'B=2\n');
    writeFile(main, 'config/local.json', '{}\n');
    writeFile(main, '.worktrees/other/.env', 'nope\n');
    writeFile(main, '.git/config', 'nope\n');
    writeFile(wt, '.env.local', 'keep\n');

    const copied = await copySetupFiles(main, wt, ['.env', '.env.*', 'config/*.json', '**/.env']);
    expect(copied).toEqual(['.env', 'config/local.json']);
    expect(fs.readFileSync(path.join(wt, '.env.local'), 'utf8')).toBe('keep\n');
    expect(fs.readFileSync(path.join(wt, 'config', 'local.json'), 'utf8')).toBe('{}\n');
    expect(fs.existsSync(path.join(wt, '.worktrees'))).toBe(false);
  });

  it('does nothing without patterns', async () => {
    expect(await copySetupFiles(makeTempDir(), makeTempDir(), [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/features/setup.test.ts`
Expected: FAIL, cannot resolve `setup`.

- [ ] **Step 3: Implement**

`src/features/worktrees/setup.ts`:
```ts
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { glob } from 'tinyglobby';
import { WORKTREES_DIR } from './layout';

export async function copySetupFiles(mainRoot: string, worktreeDir: string, patterns: readonly string[]): Promise<string[]> {
  if (patterns.length === 0) return [];
  const files = await glob([...patterns], {
    cwd: mainRoot,
    dot: true,
    onlyFiles: true,
    ignore: ['.git/**', `${WORKTREES_DIR}/**`, '**/node_modules/**'],
  });
  const copied: string[] = [];
  for (const rel of [...new Set(files)].sort()) {
    const target = path.join(worktreeDir, rel);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(mainRoot, rel), target, constants.COPYFILE_EXCL);
      copied.push(rel);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  return copied;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/features/setup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/worktrees/setup.ts tests/unit/features/setup.test.ts
git commit -m "$(cat <<'EOF'
feat(worktrees): copy configured setup files into new worktrees

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Agent status, heartbeat and activity signals

**Files:**
- Create: `src/features/workstreams/agentStatus.ts`, `src/features/workstreams/heartbeat.ts`, `src/features/workstreams/activity.ts`
- Test: `tests/unit/features/signals.test.ts`

**Interfaces:**
- Produces (`agentStatus.ts`): `AGENT_STATES = ['working', 'waiting-for-input', 'done', 'error'] as const`, `type AgentState`, `interface AgentStatus { state: AgentState; message?: string; updatedAt: Date }`, `AGENT_STATUS_FILE = 'workstream.json'`, `parseAgentStatus(text: string): AgentStatus | undefined`, `readAgentStatus(gitDir: string, onInvalid?: (file: string) => void): Promise<AgentStatus | undefined>`, `clearAgentStatus(gitDir: string): Promise<void>`.
- Produces (`heartbeat.ts`): `HEARTBEAT_FILE = 'switchyard-window.json'`, `HEARTBEAT_INTERVAL_MS = 30_000`, `HEARTBEAT_MAX_AGE_MS = 90_000`, `type WindowEnv = 'host' | 'container'`, `interface Heartbeat { env: WindowEnv; os: string; updatedAt: Date }`, `envFromRemoteName(remoteName: string | undefined): WindowEnv`, `writeHeartbeat(gitDir: string, env: WindowEnv, os?: string, now?: Date): Promise<void>`, `readHeartbeat(gitDir: string): Promise<Heartbeat | undefined>`, `isAlive(hb: Heartbeat | undefined, now: Date): boolean`, `deleteHeartbeat(gitDir: string): Promise<void>`.
- Produces (`activity.ts`): `type ActivityLevel = 'active' | 'idle' | 'stale'`, `lastActivity(worktreeDir: string, gitDir: string, changedPaths: readonly string[]): Promise<Date | undefined>`, `classifyActivity(last: Date | undefined, now: Date, activeMinutes: number, staleDays: number): ActivityLevel`.

- [ ] **Step 1: Write the failing test**

`tests/unit/features/signals.test.ts`:
```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyActivity, lastActivity } from '../../../src/features/workstreams/activity';
import { AGENT_STATUS_FILE, clearAgentStatus, parseAgentStatus, readAgentStatus } from '../../../src/features/workstreams/agentStatus';
import { deleteHeartbeat, envFromRemoteName, isAlive, readHeartbeat, writeHeartbeat } from '../../../src/features/workstreams/heartbeat';
import { makeTempDir, removeDir, writeFile } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));
const at = '2026-10-09T10:00:00.000Z';

describe('parseAgentStatus', () => {
  it('parses a valid status', () => {
    expect(parseAgentStatus(JSON.stringify({ state: 'waiting-for-input', message: ' Need approval ', updatedAt: at }))).toEqual({
      state: 'waiting-for-input',
      message: 'Need approval',
      updatedAt: new Date(at),
    });
  });

  it('accepts a UTF-8 BOM and CRLF line endings (Windows tools)', () => {
    const text = `﻿{\r\n  "state": "done",\r\n  "updatedAt": "${at}"\r\n}\r\n`;
    expect(parseAgentStatus(text)).toEqual({ state: 'done', message: undefined, updatedAt: new Date(at) });
  });

  it.each([
    'not json',
    '[]',
    JSON.stringify({ state: 'sleeping', updatedAt: at }),
    JSON.stringify({ state: 'done' }),
    JSON.stringify({ state: 'done', updatedAt: 'yesterday' }),
  ])('rejects %s', (text) => {
    expect(parseAgentStatus(text)).toBeUndefined();
  });

  it('reads, reports invalid files and clears', async () => {
    const dir = makeTempDir();
    cleanup.push(dir);
    expect(await readAgentStatus(dir)).toBeUndefined();
    writeFile(dir, AGENT_STATUS_FILE, 'garbage');
    const invalid: string[] = [];
    expect(await readAgentStatus(dir, (f) => invalid.push(f))).toBeUndefined();
    expect(invalid).toEqual([path.join(dir, AGENT_STATUS_FILE)]);
    writeFile(dir, AGENT_STATUS_FILE, JSON.stringify({ state: 'working', updatedAt: at }));
    expect((await readAgentStatus(dir))?.state).toBe('working');
    await clearAgentStatus(dir);
    expect(fs.existsSync(path.join(dir, AGENT_STATUS_FILE))).toBe(false);
  });
});

describe('heartbeat', () => {
  it('maps remote names to environments', () => {
    expect(envFromRemoteName('dev-container')).toBe('container');
    expect(envFromRemoteName('attached-container')).toBe('container');
    expect(envFromRemoteName(undefined)).toBe('host');
    expect(envFromRemoteName('wsl')).toBe('host');
  });

  it('writes, reads, ages and deletes', async () => {
    const dir = makeTempDir();
    cleanup.push(dir);
    const now = new Date(at);
    await writeHeartbeat(dir, 'container', 'linux', now);
    const hb = await readHeartbeat(dir);
    expect(hb).toEqual({ env: 'container', os: 'linux', updatedAt: now });
    expect(isAlive(hb, new Date(now.getTime() + 90_000))).toBe(true);
    expect(isAlive(hb, new Date(now.getTime() + 90_001))).toBe(false);
    expect(isAlive(undefined, now)).toBe(false);
    await deleteHeartbeat(dir);
    expect(await readHeartbeat(dir)).toBeUndefined();
  });
});

describe('activity', () => {
  it('uses the newest mtime of changed files and logs/HEAD', async () => {
    const wt = makeTempDir();
    const gitDir = makeTempDir();
    cleanup.push(wt, gitDir);
    writeFile(gitDir, 'logs/HEAD', 'x');
    writeFile(wt, 'a.txt', 'a');
    const old = new Date('2026-01-01T00:00:00Z');
    const recent = new Date('2026-10-01T00:00:00Z');
    fs.utimesSync(path.join(gitDir, 'logs', 'HEAD'), old, old);
    fs.utimesSync(path.join(wt, 'a.txt'), recent, recent);
    expect((await lastActivity(wt, gitDir, ['a.txt', 'missing.txt']))?.getTime()).toBe(recent.getTime());
    expect((await lastActivity(wt, gitDir, []))?.getTime()).toBe(old.getTime());
    expect(await lastActivity(wt, makeTempDir(), [])).toBeUndefined();
  });

  it('classifies by age', () => {
    const now = new Date(at);
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
    expect(classifyActivity(minutesAgo(4), now, 5, 7)).toBe('active');
    expect(classifyActivity(minutesAgo(6), now, 5, 7)).toBe('idle');
    expect(classifyActivity(minutesAgo(7 * 24 * 60), now, 5, 7)).toBe('stale');
    expect(classifyActivity(undefined, now, 5, 7)).toBe('stale');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/features/signals.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/features/workstreams/agentStatus.ts`:
```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const AGENT_STATES = ['working', 'waiting-for-input', 'done', 'error'] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export interface AgentStatus {
  state: AgentState;
  message?: string;
  updatedAt: Date;
}

export const AGENT_STATUS_FILE = 'workstream.json';

export function parseAgentStatus(text: string): AgentStatus | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const { state, message, updatedAt } = data as Record<string, unknown>;
  if (typeof state !== 'string' || !(AGENT_STATES as readonly string[]).includes(state)) return undefined;
  if (typeof updatedAt !== 'string') return undefined;
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return undefined;
  const trimmed = typeof message === 'string' ? message.trim() : '';
  return { state: state as AgentState, message: trimmed || undefined, updatedAt: date };
}

export async function readAgentStatus(gitDir: string, onInvalid?: (file: string) => void): Promise<AgentStatus | undefined> {
  const file = path.join(gitDir, AGENT_STATUS_FILE);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  const status = parseAgentStatus(text);
  if (!status) onInvalid?.(file);
  return status;
}

export async function clearAgentStatus(gitDir: string): Promise<void> {
  await fs.rm(path.join(gitDir, AGENT_STATUS_FILE), { force: true });
}
```

`src/features/workstreams/heartbeat.ts`:
```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const HEARTBEAT_FILE = 'switchyard-window.json';
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_MAX_AGE_MS = 90_000;

export type WindowEnv = 'host' | 'container';

export interface Heartbeat {
  env: WindowEnv;
  os: string;
  updatedAt: Date;
}

export function envFromRemoteName(remoteName: string | undefined): WindowEnv {
  return remoteName === 'dev-container' || remoteName === 'attached-container' ? 'container' : 'host';
}

export async function writeHeartbeat(gitDir: string, env: WindowEnv, os: string = process.platform, now: Date = new Date()): Promise<void> {
  const file = path.join(gitDir, HEARTBEAT_FILE);
  const content = JSON.stringify({ env, os, updatedAt: now.toISOString() });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content);
  try {
    await fs.rename(tmp, file); // atomic, so readers never see a half-written file
  } catch {
    await fs.rm(tmp, { force: true });
    await fs.writeFile(file, content);
  }
}

export async function readHeartbeat(gitDir: string): Promise<Heartbeat | undefined> {
  try {
    const data = JSON.parse(await fs.readFile(path.join(gitDir, HEARTBEAT_FILE), 'utf8')) as Record<string, unknown>;
    const updatedAt = new Date(String(data.updatedAt));
    if ((data.env !== 'host' && data.env !== 'container') || Number.isNaN(updatedAt.getTime())) return undefined;
    return { env: data.env, os: String(data.os ?? ''), updatedAt };
  } catch {
    return undefined;
  }
}

export function isAlive(hb: Heartbeat | undefined, now: Date): boolean {
  return hb !== undefined && now.getTime() - hb.updatedAt.getTime() <= HEARTBEAT_MAX_AGE_MS;
}

export async function deleteHeartbeat(gitDir: string): Promise<void> {
  await fs.rm(path.join(gitDir, HEARTBEAT_FILE), { force: true });
}
```

`src/features/workstreams/activity.ts`:
```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type ActivityLevel = 'active' | 'idle' | 'stale';

const MAX_PATHS = 200;

/** Newest mtime among changed files and the worktree's HEAD reflog. Never stats .git/index (git status may touch it). */
export async function lastActivity(worktreeDir: string, gitDir: string, changedPaths: readonly string[]): Promise<Date | undefined> {
  const candidates = [...changedPaths.slice(0, MAX_PATHS).map((p) => path.join(worktreeDir, p)), path.join(gitDir, 'logs', 'HEAD')];
  let latest: number | undefined;
  for (const file of candidates) {
    try {
      const { mtimeMs } = await fs.stat(file);
      if (latest === undefined || mtimeMs > latest) latest = mtimeMs;
    } catch {
      // deleted files have no mtime
    }
  }
  return latest === undefined ? undefined : new Date(latest);
}

export function classifyActivity(last: Date | undefined, now: Date, activeMinutes: number, staleDays: number): ActivityLevel {
  if (!last) return 'stale';
  const age = now.getTime() - last.getTime();
  if (age <= activeMinutes * 60_000) return 'active';
  if (age >= staleDays * 86_400_000) return 'stale';
  return 'idle';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/features/signals.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/workstreams tests/unit/features/signals.test.ts
git commit -m "$(cat <<'EOF'
feat(workstreams): add agent status, heartbeat and activity signals

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Progress and attention ranking

**Files:**
- Create: `src/features/workstreams/progress.ts`, `src/features/workstreams/attention.ts`
- Test: `tests/unit/features/progress.test.ts`, `tests/unit/features/attention.test.ts`

**Interfaces:**
- Consumes: `runGit` (Task 2), `sumNumstat` (Task 3), `AgentStatus` (Task 10), `ActivityLevel` (Task 10).
- Produces (`progress.ts`): `interface Progress { base: string | undefined; ahead: number; behind: number; added: number; deleted: number; lastSubject: string | undefined }`, `resolveBase(cwd: string, configured: string): Promise<string | undefined>`, `computeProgress(worktreeDir: string, base: string | undefined): Promise<Progress>`.
- Produces (`attention.ts`): `type AttentionState = 'waiting-for-input' | 'error' | 'working' | 'done' | 'active' | 'idle' | 'stale' | 'unreachable'`, `ATTENTION_ORDER: readonly AttentionState[]`, `interface AttentionInput { reachable: boolean; agent: AgentStatus | undefined; activity: ActivityLevel; now: Date; agentStaleMinutes: number }`, `computeAttention(input: AttentionInput): { state: AttentionState; agentStale: boolean }`, `sortByAttention<T extends { attention: AttentionState; lastActivity?: Date }>(items: readonly T[]): T[]`, `attentionTransitions(prev: ReadonlyMap<string, AttentionState> | undefined, next: ReadonlyArray<{ key: string; attention: AttentionState }>): string[]`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/features/progress.test.ts`:
```ts
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeProgress, resolveBase } from '../../../src/features/workstreams/progress';
import { git, initRepo, makeTempDir, removeDir, writeFile } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

describe('resolveBase', () => {
  it('prefers a valid configured base, then origin/HEAD, then main/master', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    expect(await resolveBase(repo, 'nope')).toBe('main');
    expect(await resolveBase(repo, 'HEAD')).toBe('HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    expect(await resolveBase(repo, '')).toBe('origin/main');
  });

  it('returns undefined when nothing fits', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    git(repo, 'branch', '-m', 'main', 'trunk');
    expect(await resolveBase(repo, '')).toBeUndefined();
  });
});

describe('computeProgress', () => {
  it('reports ahead/behind, line stats against the merge-base and the last subject', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const wt = path.join(repo, '.worktrees', 'feat');
    git(repo, 'worktree', 'add', '-b', 'feat', wt);
    writeFile(wt, 'a.txt', 'one\ntwo\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'add a');
    writeFile(wt, 'b.txt', 'three\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'add b');
    writeFile(wt, 'README.md', 'changed\n');
    writeFile(repo, 'main.txt', 'm\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main moves');

    expect(await computeProgress(wt, 'main')).toEqual({ base: 'main', ahead: 2, behind: 1, added: 4, deleted: 1, lastSubject: 'add b' });
  });

  it('returns zeros for a repo without commits and for a missing base', async () => {
    const empty = makeTempDir();
    cleanup.push(empty);
    git(empty, 'init', '-q');
    expect(await computeProgress(empty, 'main')).toEqual({ base: 'main', ahead: 0, behind: 0, added: 0, deleted: 0, lastSubject: undefined });
    const repo = initRepo();
    cleanup.push(repo);
    expect(await computeProgress(repo, undefined)).toEqual({ base: undefined, ahead: 0, behind: 0, added: 0, deleted: 0, lastSubject: 'initial' });
  });
});
```

`tests/unit/features/attention.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { attentionTransitions, computeAttention, sortByAttention } from '../../../src/features/workstreams/attention';

const now = new Date('2026-10-09T10:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe('computeAttention', () => {
  const base = { reachable: true, activity: 'idle' as const, now, agentStaleMinutes: 10 };

  it('uses the agent state when present', () => {
    expect(computeAttention({ ...base, agent: { state: 'waiting-for-input', updatedAt: minutesAgo(1) } })).toEqual({ state: 'waiting-for-input', agentStale: false });
  });

  it('falls back to activity when a working report is stale', () => {
    expect(computeAttention({ ...base, agent: { state: 'working', updatedAt: minutesAgo(11) } })).toEqual({ state: 'idle', agentStale: true });
  });

  it('keeps old waiting/done reports but flags them as stale', () => {
    expect(computeAttention({ ...base, agent: { state: 'waiting-for-input', updatedAt: minutesAgo(60) } })).toEqual({ state: 'waiting-for-input', agentStale: true });
  });

  it('uses activity without an agent and unreachable before anything else', () => {
    expect(computeAttention({ ...base, agent: undefined })).toEqual({ state: 'idle', agentStale: false });
    expect(computeAttention({ ...base, reachable: false, agent: { state: 'error', updatedAt: now } })).toEqual({ state: 'unreachable', agentStale: false });
  });
});

describe('sortByAttention', () => {
  it('orders by attention rank, then by most recent activity', () => {
    const items = [
      { name: 'idle', attention: 'idle' as const, lastActivity: minutesAgo(30) },
      { name: 'unreachable', attention: 'unreachable' as const },
      { name: 'working', attention: 'working' as const },
      { name: 'waiting', attention: 'waiting-for-input' as const },
      { name: 'active-old', attention: 'active' as const, lastActivity: minutesAgo(4) },
      { name: 'active-new', attention: 'active' as const, lastActivity: minutesAgo(1) },
    ];
    expect(sortByAttention(items).map((i) => i.name)).toEqual(['waiting', 'working', 'active-new', 'active-old', 'idle', 'unreachable']);
  });
});

describe('attentionTransitions', () => {
  it('reports keys that newly entered waiting-for-input or error', () => {
    const prev = new Map([
      ['a', 'working' as const],
      ['b', 'waiting-for-input' as const],
    ]);
    const next = [
      { key: 'a', attention: 'waiting-for-input' as const },
      { key: 'b', attention: 'waiting-for-input' as const },
      { key: 'c', attention: 'error' as const },
      { key: 'd', attention: 'done' as const },
    ];
    expect(attentionTransitions(prev, next)).toEqual(['a', 'c']);
  });

  it('reports nothing on the first refresh', () => {
    expect(attentionTransitions(undefined, [{ key: 'a', attention: 'error' }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/features/progress.test.ts tests/unit/features/attention.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/features/workstreams/progress.ts`:
```ts
import { runGit } from '../../core/git/gitCli';
import { sumNumstat } from '../../core/git/porcelain';

export interface Progress {
  base: string | undefined;
  ahead: number;
  behind: number;
  added: number;
  deleted: number;
  lastSubject: string | undefined;
}

async function isCommit(cwd: string, ref: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

export async function resolveBase(cwd: string, configured: string): Promise<string | undefined> {
  if (configured && (await isCommit(cwd, configured))) return configured;
  try {
    const originHead = (await runGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd })).trim();
    if (originHead) return originHead;
  } catch {
    // no origin/HEAD
  }
  for (const candidate of ['main', 'master']) {
    if (await isCommit(cwd, candidate)) return candidate;
  }
  return undefined;
}

export async function computeProgress(worktreeDir: string, base: string | undefined): Promise<Progress> {
  const progress: Progress = { base, ahead: 0, behind: 0, added: 0, deleted: 0, lastSubject: undefined };
  const cwd = worktreeDir;
  try {
    progress.lastSubject = (await runGit(['log', '-1', '--format=%s'], { cwd })).trim() || undefined;
  } catch {
    return progress; // no commits yet
  }
  if (!base) return progress;
  try {
    const [behind, ahead] = (await runGit(['rev-list', '--left-right', '--count', `${base}...HEAD`], { cwd })).trim().split(/\s+/).map(Number);
    progress.ahead = ahead;
    progress.behind = behind;
    const mergeBase = (await runGit(['merge-base', base, 'HEAD'], { cwd })).trim();
    Object.assign(progress, sumNumstat(await runGit(['diff', '--numstat', '-z', mergeBase], { cwd })));
  } catch {
    // unknown base or unrelated histories: keep zeros
  }
  return progress;
}
```

`src/features/workstreams/attention.ts`:
```ts
import type { ActivityLevel } from './activity';
import type { AgentStatus } from './agentStatus';

export type AttentionState = 'waiting-for-input' | 'error' | 'working' | 'done' | 'active' | 'idle' | 'stale' | 'unreachable';

export const ATTENTION_ORDER: readonly AttentionState[] = ['waiting-for-input', 'error', 'working', 'done', 'active', 'idle', 'stale', 'unreachable'];

export interface AttentionInput {
  reachable: boolean;
  agent: AgentStatus | undefined;
  activity: ActivityLevel;
  now: Date;
  agentStaleMinutes: number;
}

export function computeAttention(input: AttentionInput): { state: AttentionState; agentStale: boolean } {
  if (!input.reachable) return { state: 'unreachable', agentStale: false };
  if (!input.agent) return { state: input.activity, agentStale: false };
  const agentStale = input.now.getTime() - input.agent.updatedAt.getTime() > input.agentStaleMinutes * 60_000;
  if (input.agent.state === 'working' && agentStale) return { state: input.activity, agentStale: true };
  return { state: input.agent.state, agentStale };
}

export function sortByAttention<T extends { attention: AttentionState; lastActivity?: Date }>(items: readonly T[]): T[] {
  const rank = (a: AttentionState) => ATTENTION_ORDER.indexOf(a);
  return [...items].sort(
    (a, b) => rank(a.attention) - rank(b.attention) || (b.lastActivity?.getTime() ?? 0) - (a.lastActivity?.getTime() ?? 0),
  );
}

const NEEDS_YOU: ReadonlySet<AttentionState> = new Set(['waiting-for-input', 'error']);

export function attentionTransitions(
  prev: ReadonlyMap<string, AttentionState> | undefined,
  next: ReadonlyArray<{ key: string; attention: AttentionState }>,
): string[] {
  if (!prev) return [];
  return next.filter((n) => NEEDS_YOU.has(n.attention) && prev.get(n.key) !== n.attention).map((n) => n.key);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/features/progress.test.ts tests/unit/features/attention.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/workstreams tests/unit/features/progress.test.ts tests/unit/features/attention.test.ts
git commit -m "$(cat <<'EOF'
feat(workstreams): add progress stats and attention ranking

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Diff refs and compare-with-base

**Files:**
- Create: `src/core/diff/refs.ts`, `src/features/diffs/compare.ts`
- Test: `tests/unit/core/refs.test.ts`, `tests/unit/features/compare.test.ts`

**Interfaces:**
- Consumes: `runGit` (Task 2), `parseNameStatus`, `FileChange` (Task 3).
- Produces (`core/diff/refs.ts`): `WORKING = 'WORKING'`, `EMPTY = 'EMPTY'`, `interface DiffSide { ref: string; path: string }`, `sideRefsFor(change: FileChange, leftRef: string, rightRef: string): { left: DiffSide; right: DiffSide }`, `readFileAtRef(worktreeDir: string, ref: string, relPath: string): Promise<string>` (`''` for `EMPTY` or on any error).
- Produces (`features/diffs/compare.ts`): `type CompareMode = 'mergeBase' | 'twoDot' | 'uncommitted'`, `interface CompareResult { leftRef: string; rightRef: string; files: FileChange[] }`, `compareWithBase(worktreeDir: string, base: string, mode: CompareMode): Promise<CompareResult>`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/core/refs.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY, readFileAtRef, sideRefsFor, WORKING } from '../../../src/core/diff/refs';
import { initRepo, removeDir } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

describe('sideRefsFor', () => {
  it('maps each change kind to left/right sides', () => {
    expect(sideRefsFor({ path: 'a', kind: 'modified' }, 'HEAD', WORKING)).toEqual({ left: { ref: 'HEAD', path: 'a' }, right: { ref: WORKING, path: 'a' } });
    expect(sideRefsFor({ path: 'a', kind: 'added' }, 'HEAD', WORKING).left).toEqual({ ref: EMPTY, path: 'a' });
    expect(sideRefsFor({ path: 'a', kind: 'untracked' }, 'HEAD', WORKING).left).toEqual({ ref: EMPTY, path: 'a' });
    expect(sideRefsFor({ path: 'a', kind: 'deleted' }, 'HEAD', WORKING).right).toEqual({ ref: EMPTY, path: 'a' });
    expect(sideRefsFor({ path: 'new', origPath: 'old', kind: 'renamed' }, 'base', 'HEAD')).toEqual({
      left: { ref: 'base', path: 'old' },
      right: { ref: 'HEAD', path: 'new' },
    });
  });
});

describe('readFileAtRef', () => {
  it('returns file content at a ref, and empty text for EMPTY or missing files', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    expect(await readFileAtRef(repo, 'HEAD', 'README.md')).toBe('hello\n');
    expect(await readFileAtRef(repo, EMPTY, 'README.md')).toBe('');
    expect(await readFileAtRef(repo, 'HEAD', 'missing.txt')).toBe('');
  });
});
```

`tests/unit/features/compare.test.ts`:
```ts
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WORKING } from '../../../src/core/diff/refs';
import { compareWithBase } from '../../../src/features/diffs/compare';
import { git, initRepo, removeDir, writeFile } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

function fixture(): { repo: string; wt: string } {
  const repo = initRepo();
  cleanup.push(repo);
  writeFile(repo, 'docs.md', 'line\n'.repeat(20));
  writeFile(repo, 'shared.txt', 'shared\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'docs');
  const wt = path.join(repo, '.worktrees', 'feat');
  git(repo, 'worktree', 'add', '-b', 'feat', wt);
  writeFile(wt, 'README.md', 'changed\n');
  writeFile(wt, 'new.txt', 'new\n');
  git(wt, 'mv', 'docs.md', 'guide.md');
  git(wt, 'add', '.');
  git(wt, 'commit', '-q', '-m', 'feature work');
  writeFile(repo, 'main-only.txt', 'm\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'main moves');
  writeFile(wt, 'shared.txt', 'edited, not committed\n');
  return { repo, wt };
}

const sortByPath = <T extends { path: string }>(list: T[]) => [...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

describe('compareWithBase', () => {
  it('mergeBase mode shows only the branch changes', async () => {
    const { wt } = fixture();
    const result = await compareWithBase(wt, 'main', 'mergeBase');
    expect(result.rightRef).toBe('HEAD');
    expect(result.leftRef).toMatch(/^[0-9a-f]{40}$/);
    expect(sortByPath(result.files)).toEqual([
      { path: 'README.md', kind: 'modified' },
      { path: 'guide.md', origPath: 'docs.md', kind: 'renamed' },
      { path: 'new.txt', kind: 'added' },
    ]);
  });

  it('twoDot mode also shows what changed on the base', async () => {
    const { wt } = fixture();
    const result = await compareWithBase(wt, 'main', 'twoDot');
    expect(result.leftRef).toBe('main');
    expect(result.files).toContainEqual({ path: 'main-only.txt', kind: 'deleted' });
  });

  it('uncommitted mode compares the merge-base with the working tree', async () => {
    const { wt } = fixture();
    const result = await compareWithBase(wt, 'main', 'uncommitted');
    expect(result.rightRef).toBe(WORKING);
    expect(result.files).toContainEqual({ path: 'shared.txt', kind: 'modified' });
    expect(result.files).toContainEqual({ path: 'new.txt', kind: 'added' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/core/refs.test.ts tests/unit/features/compare.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/core/diff/refs.ts`:
```ts
import { runGit } from '../git/gitCli';
import type { FileChange } from '../git/porcelain';

/** Right side is the file on disk. */
export const WORKING = 'WORKING';
/** Side has no content (added or deleted file). */
export const EMPTY = 'EMPTY';

export interface DiffSide {
  ref: string;
  path: string;
}

export function sideRefsFor(change: FileChange, leftRef: string, rightRef: string): { left: DiffSide; right: DiffSide } {
  const left: DiffSide =
    change.kind === 'added' || change.kind === 'untracked' ? { ref: EMPTY, path: change.path } : { ref: leftRef, path: change.origPath ?? change.path };
  const right: DiffSide = change.kind === 'deleted' ? { ref: EMPTY, path: change.path } : { ref: rightRef, path: change.path };
  return { left, right };
}

export async function readFileAtRef(worktreeDir: string, ref: string, relPath: string): Promise<string> {
  if (ref === EMPTY) return '';
  try {
    return await runGit(['show', `${ref}:${relPath}`], { cwd: worktreeDir });
  } catch {
    return '';
  }
}
```

`src/features/diffs/compare.ts`:
```ts
import { runGit } from '../../core/git/gitCli';
import { parseNameStatus, type FileChange } from '../../core/git/porcelain';
import { WORKING } from '../../core/diff/refs';

export type CompareMode = 'mergeBase' | 'twoDot' | 'uncommitted';

export interface CompareResult {
  leftRef: string;
  rightRef: string;
  files: FileChange[];
}

async function nameStatus(cwd: string, refs: string[]): Promise<FileChange[]> {
  return parseNameStatus(await runGit(['diff', '--name-status', '-z', '-M', ...refs], { cwd }));
}

export async function compareWithBase(worktreeDir: string, base: string, mode: CompareMode): Promise<CompareResult> {
  const cwd = worktreeDir;
  if (mode === 'twoDot') {
    return { leftRef: base, rightRef: 'HEAD', files: await nameStatus(cwd, [base, 'HEAD']) };
  }
  const mergeBase = (await runGit(['merge-base', base, 'HEAD'], { cwd })).trim();
  if (mode === 'mergeBase') {
    return { leftRef: mergeBase, rightRef: 'HEAD', files: await nameStatus(cwd, [mergeBase, 'HEAD']) };
  }
  return { leftRef: mergeBase, rightRef: WORKING, files: await nameStatus(cwd, [mergeBase]) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/core/refs.test.ts tests/unit/features/compare.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/diff/refs.ts src/features/diffs tests/unit/core/refs.test.ts tests/unit/features/compare.test.ts
git commit -m "$(cat <<'EOF'
feat(diffs): add diff side refs and compare-with-base

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Workstream builder

**Files:**
- Create: `src/features/workstreams/workstream.ts`
- Test: `tests/unit/features/workstream.test.ts`

**Interfaces:**
- Consumes: `runGit` (Task 2), `parseStatusV2`, `FileChange` (Task 3), `samePath` (Task 2), `WorktreeService` (Task 8), `ResolvedWorktree` (Task 7), Task 10 signals, Task 11 progress/attention.
- Produces: `interface WorkstreamSettings { activeWindowMinutes: number; staleAfterDays: number; agentStatusStaleMinutes: number; defaultBase: string }`, `interface Workstream { key: string; worktree: ResolvedWorktree; changes: FileChange[]; agent: AgentStatus | undefined; agentStale: boolean; heartbeat: Heartbeat | undefined; windowOpen: boolean; lastActivity: Date | undefined; activity: ActivityLevel; progress: Progress | undefined; attention: AttentionState; isCurrent: boolean }` (`key` = `worktree.adminDir`), `interface BuildOptions { currentWorktreeRoot: string | undefined; settings: WorkstreamSettings; now: Date; onInvalidStatus?: (file: string) => void }`, `buildWorkstreams(service: WorktreeService, opts: BuildOptions): Promise<Workstream[]>` (sorted by attention).

- [ ] **Step 1: Write the failing test**

`tests/unit/features/workstream.test.ts`:
```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWorkstreams, type BuildOptions } from '../../../src/features/workstreams/workstream';
import { WorktreeService } from '../../../src/features/worktrees/worktreeService';
import { initRepo, removeDir, writeFile } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

const options = (currentWorktreeRoot: string): BuildOptions => ({
  currentWorktreeRoot,
  settings: { activeWindowMinutes: 5, staleAfterDays: 7, agentStatusStaleMinutes: 10, defaultBase: '' },
  now: new Date(),
});

describe('buildWorkstreams', () => {
  it('combines signals and sorts by attention', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const service = new WorktreeService({ mainRoot: repo, commonDir: path.join(repo, '.git') }, () => ({ autoAdopt: true }));
    const a = await service.create({ kind: 'new', branch: 'a' });
    const b = await service.create({ kind: 'new', branch: 'b' });
    writeFile(a.path!, 'new.txt', 'x\n');
    fs.writeFileSync(
      path.join(b.adminDir, 'workstream.json'),
      JSON.stringify({ state: 'waiting-for-input', message: 'Need approval', updatedAt: new Date().toISOString() }),
    );

    const items = await buildWorkstreams(service, options(repo));
    expect(items[0]).toMatchObject({ attention: 'waiting-for-input', agent: { message: 'Need approval' } });
    expect(items[0].worktree.branch).toBe('b');
    const aItem = items.find((i) => i.worktree.branch === 'a')!;
    expect(aItem.changes).toEqual([{ path: 'new.txt', kind: 'untracked' }]);
    expect(aItem.attention).toBe('active');
    expect(aItem.progress).toMatchObject({ base: 'main', ahead: 0, behind: 0 });
    const main = items.find((i) => i.worktree.isMain)!;
    expect(main.isCurrent).toBe(true);
    expect(main.key).toBe(main.worktree.adminDir);
  });

  it('does not modify the git index while refreshing', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const service = new WorktreeService({ mainRoot: repo, commonDir: path.join(repo, '.git') }, () => ({ autoAdopt: true }));
    writeFile(repo, 'README.md', 'changed but same size?\n');
    const index = path.join(repo, '.git', 'index');
    const before = fs.statSync(index).mtimeMs;
    await buildWorkstreams(service, options(repo));
    await buildWorkstreams(service, options(repo));
    expect(fs.statSync(index).mtimeMs).toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/features/workstream.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/features/workstreams/workstream.ts`:
```ts
import { runGit } from '../../core/git/gitCli';
import { parseStatusV2, type FileChange } from '../../core/git/porcelain';
import { samePath } from '../../core/paths';
import type { ResolvedWorktree } from '../worktrees/resolver';
import type { WorktreeService } from '../worktrees/worktreeService';
import { classifyActivity, lastActivity, type ActivityLevel } from './activity';
import { readAgentStatus, type AgentStatus } from './agentStatus';
import { computeAttention, sortByAttention, type AttentionState } from './attention';
import { isAlive, readHeartbeat, type Heartbeat } from './heartbeat';
import { computeProgress, resolveBase, type Progress } from './progress';

export interface WorkstreamSettings {
  activeWindowMinutes: number;
  staleAfterDays: number;
  agentStatusStaleMinutes: number;
  defaultBase: string;
}

export interface Workstream {
  /** Stable id: the worktree's admin dir. */
  key: string;
  worktree: ResolvedWorktree;
  changes: FileChange[];
  agent: AgentStatus | undefined;
  agentStale: boolean;
  heartbeat: Heartbeat | undefined;
  windowOpen: boolean;
  lastActivity: Date | undefined;
  activity: ActivityLevel;
  progress: Progress | undefined;
  attention: AttentionState;
  isCurrent: boolean;
}

export interface BuildOptions {
  currentWorktreeRoot: string | undefined;
  settings: WorkstreamSettings;
  now: Date;
  onInvalidStatus?: (file: string) => void;
}

export async function buildWorkstreams(service: WorktreeService, opts: BuildOptions): Promise<Workstream[]> {
  const worktrees = await service.list();
  const base = await resolveBase(service.roots.mainRoot, opts.settings.defaultBase);
  const items = await Promise.all(worktrees.map((wt) => buildOne(wt, base, opts)));
  return sortByAttention(items);
}

async function buildOne(wt: ResolvedWorktree, base: string | undefined, opts: BuildOptions): Promise<Workstream> {
  const gitDir = wt.adminDir;
  const [agent, heartbeat] = await Promise.all([readAgentStatus(gitDir, opts.onInvalidStatus), readHeartbeat(gitDir)]);
  let changes: FileChange[] = [];
  let progress: Progress | undefined;
  let last: Date | undefined;
  if (wt.path) {
    try {
      changes = parseStatusV2(await runGit(['status', '--porcelain=v2', '-z'], { cwd: wt.path })).changes;
    } catch {
      // treat as no changes; the error shows up when the user acts on the worktree
    }
    last = await lastActivity(wt.path, gitDir, changes.map((c) => c.path));
    progress = await computeProgress(wt.path, base);
  }
  const s = opts.settings;
  const activity = classifyActivity(last, opts.now, s.activeWindowMinutes, s.staleAfterDays);
  const { state, agentStale } = computeAttention({
    reachable: wt.path !== undefined,
    agent,
    activity,
    now: opts.now,
    agentStaleMinutes: s.agentStatusStaleMinutes,
  });
  return {
    key: wt.adminDir,
    worktree: wt,
    changes,
    agent,
    agentStale,
    heartbeat,
    windowOpen: isAlive(heartbeat, opts.now),
    lastActivity: last,
    activity,
    progress,
    attention: state,
    isCurrent: wt.path !== undefined && opts.currentWorktreeRoot !== undefined && samePath(wt.path, opts.currentWorktreeRoot),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/features/workstream.test.ts`
Expected: PASS. (If the index test fails, check that `runGit` sets `GIT_OPTIONAL_LOCKS=0`.)

- [ ] **Step 5: Commit**

```bash
git add src/features/workstreams/workstream.ts tests/unit/features/workstream.test.ts
git commit -m "$(cat <<'EOF'
feat(workstreams): build ranked workstream snapshots

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Repository snapshot store

**Files:**
- Create: `src/core/repository.ts`
- Test: `tests/unit/core/repository.test.ts`

**Interfaces:**
- Produces: `class Repository<T> { constructor(load: () => Promise<readonly T[]>, debounceMs?: number, onError?: (error: unknown) => void); readonly current: readonly T[]; onDidChange(listener: () => void): { dispose(): void }; refresh(): Promise<void>; dispose(): void }`. `refresh()` is debounced (default 300 ms); concurrent calls coalesce; a call made during a load triggers one more load; the promise resolves after the load that includes the call. On error `current` is unchanged and `onError` is called.

- [ ] **Step 1: Write the failing test**

`tests/unit/core/repository.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repository';

describe('Repository', () => {
  it('coalesces refresh calls into one load and notifies listeners', async () => {
    let loads = 0;
    const repo = new Repository(async () => [++loads], 10);
    let changes = 0;
    repo.onDidChange(() => changes++);
    await Promise.all([repo.refresh(), repo.refresh(), repo.refresh()]);
    expect(loads).toBe(1);
    expect(repo.current).toEqual([1]);
    expect(changes).toBe(1);
  });

  it('runs one more load when refreshed during a load', async () => {
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const repo = new Repository(async () => {
      loads++;
      if (loads === 1) await gate;
      return [loads];
    }, 5);
    const first = repo.refresh();
    await new Promise((r) => setTimeout(r, 20));
    const second = repo.refresh();
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all([first, second]);
    expect(loads).toBe(2);
    expect(repo.current).toEqual([2]);
  });

  it('keeps the previous snapshot and reports errors', async () => {
    let fail = false;
    const errors: unknown[] = [];
    const repo = new Repository(async () => {
      if (fail) throw new Error('boom');
      return ['ok'];
    }, 5, (e) => errors.push(e));
    await repo.refresh();
    fail = true;
    await repo.refresh();
    expect(repo.current).toEqual(['ok']);
    expect(errors).toHaveLength(1);
  });

  it('stops notifying disposed listeners', async () => {
    const repo = new Repository(async () => [1], 5);
    let changes = 0;
    const sub = repo.onDidChange(() => changes++);
    sub.dispose();
    await repo.refresh();
    expect(changes).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/repository.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/core/repository.ts`:
```ts
/** Debounced snapshot store: the UI reads `current` and re-renders on change. */
export class Repository<T> {
  private items: readonly T[] = [];
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private rerun = false;
  private waiters: Array<() => void> = [];
  private disposed = false;

  constructor(
    private readonly load: () => Promise<readonly T[]>,
    private readonly debounceMs = 300,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  get current(): readonly T[] {
    return this.items;
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.run();
      }, this.debounceMs);
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.listeners.clear();
    this.waiters.splice(0).forEach((w) => w());
  }

  private async run(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    const waiters = this.waiters.splice(0);
    try {
      this.items = await this.load();
      for (const listener of [...this.listeners]) listener();
    } catch (error) {
      this.onError(error);
    } finally {
      this.running = false;
      waiters.forEach((w) => w());
    }
    if (this.rerun && !this.disposed) {
      this.rerun = false;
      await this.run();
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/core/repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/repository.ts tests/unit/core/repository.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add debounced repository snapshot store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: VS Code plumbing: settings, URIs, git content provider, diff opener, formatting

**Files:**
- Create: `src/ui/format.ts` (pure), `src/ui/settings.ts`, `src/core/uris.ts`, `src/core/diff/gitContentProvider.ts`, `src/core/diff/openDiff.ts`
- Test: `tests/unit/ui/format.test.ts`

**Interfaces:**
- Consumes: `Workstream` (Task 13), `ResolvedWorktree` (Task 7), `AttentionState` (Task 11), `CompareMode` (Task 12), `readFileAtRef`, `sideRefsFor`, `WORKING`, `DiffSide` (Task 12), `FileChange` (Task 3).
- Produces (`format.ts`): `formatAge(date: Date | undefined, now: Date): string`, `ATTENTION_LABEL: Record<AttentionState, string>`, `COMPARE_MODE_LABEL: Record<CompareMode, string>`, `workstreamLabel(ws: Workstream): string`, `describeWorkstream(ws: Workstream, now: Date): string`, `workstreamContext(ws: Workstream): string` (format: `workstream;<reachable|unreachable>;<current|notCurrent>;<main|linked>;<portable|notPortable>;<hasAgent|noAgent>;`).
- Produces (`settings.ts`): `interface Settings { openAfterCreate: 'newWindow' | 'currentWindow' | 'none'; copyFiles: string[]; setupCommand: string; autoAdopt: boolean; defaultBase: string; activeWindowMinutes: number; staleAfterDays: number; agentStatusStaleMinutes: number; notifyOnAttention: boolean; pollSeconds: number }`, `readSettings(): Settings`.
- Produces (`uris.ts`): `toWorkspaceUri(reference: vscode.Uri, fsPath: string): vscode.Uri`.
- Produces (`gitContentProvider.ts`): `GIT_SCHEME = 'switchyard-git'`, `interface GitUriParams { worktree: string; ref: string; path: string }`, `makeGitUri(p: GitUriParams): vscode.Uri`, `parseGitUri(uri: vscode.Uri): GitUriParams`, `class GitContentProvider implements vscode.TextDocumentContentProvider`.
- Produces (`openDiff.ts`): `openChangeDiff(reference: vscode.Uri, worktreeDir: string, change: FileChange, leftRef: string, rightRef: string, label: string): Promise<void>`.

- [ ] **Step 1: Write the failing test for the pure formatter**

`tests/unit/ui/format.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { ResolvedWorktree } from '../../../src/features/worktrees/resolver';
import type { Workstream } from '../../../src/features/workstreams/workstream';
import { describeWorkstream, formatAge, workstreamContext, workstreamLabel } from '../../../src/ui/format';

const now = new Date('2026-10-09T10:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const MIN = 60_000;

function makeWs(overrides: Partial<Workstream> = {}, wt: Partial<ResolvedWorktree> = {}): Workstream {
  return {
    key: '/r/.git/worktrees/a',
    worktree: {
      id: 'a',
      isMain: false,
      adminDir: '/r/.git/worktrees/a',
      path: '/r/.worktrees/a',
      recordedPath: '/r/.worktrees/a',
      branch: 'feat',
      head: undefined,
      locked: true,
      portable: true,
      insideRepo: true,
      ...wt,
    },
    changes: [],
    agent: undefined,
    agentStale: false,
    heartbeat: undefined,
    windowOpen: false,
    lastActivity: undefined,
    activity: 'idle',
    progress: undefined,
    attention: 'idle',
    isCurrent: false,
    ...overrides,
  };
}

describe('formatAge', () => {
  it.each([
    [30_000, '30s'],
    [5 * MIN, '5m'],
    [3 * 60 * MIN, '3h'],
    [2 * 24 * 60 * MIN, '2d'],
  ])('%i ms -> %s', (ms, expected) => {
    expect(formatAge(ago(ms), now)).toBe(expected);
  });
  it('handles missing and future dates', () => {
    expect(formatAge(undefined, now)).toBe('—');
    expect(formatAge(new Date(now.getTime() + 5000), now)).toBe('0s');
  });
});

describe('describeWorkstream', () => {
  it('describes an agent waiting for input with progress and an open window', () => {
    const ws = makeWs({
      attention: 'waiting-for-input',
      agent: { state: 'waiting-for-input', updatedAt: ago(2 * MIN) },
      progress: { base: 'main', ahead: 3, behind: 0, added: 120, deleted: 40, lastSubject: 'x' },
      windowOpen: true,
      heartbeat: { env: 'container', os: 'linux', updatedAt: now },
    });
    expect(describeWorkstream(ws, now)).toBe('waiting for input · 2m · ↑3 +120 −40 · open in container');
  });

  it('describes the main worktree open in this window', () => {
    const ws = makeWs({ isCurrent: true, lastActivity: ago(3 * 60 * MIN) }, { isMain: true, id: undefined, branch: 'main' });
    expect(describeWorkstream(ws, now)).toBe('main worktree · idle · 3h · this window');
  });

  it('falls back to activity for a stale working report without saying "last reported"', () => {
    const ws = makeWs({ attention: 'idle', agentStale: true, agent: { state: 'working', updatedAt: ago(20 * MIN) }, lastActivity: ago(8 * MIN) });
    expect(describeWorkstream(ws, now)).toBe('idle · 8m');
  });

  it('marks old agent reports', () => {
    const ws = makeWs({ attention: 'waiting-for-input', agentStale: true, agent: { state: 'waiting-for-input', updatedAt: ago(60 * MIN) } });
    expect(describeWorkstream(ws, now)).toBe('waiting for input (last reported) · 1h');
  });

  it('describes unreachable worktrees', () => {
    expect(describeWorkstream(makeWs({ attention: 'unreachable' }, { path: undefined }), now)).toBe('unreachable from this environment');
  });
});

describe('labels and context values', () => {
  it('labels detached worktrees by short sha', () => {
    expect(workstreamLabel(makeWs({}, { branch: undefined, head: 'abcdef1234567' }))).toBe('detached @ abcdef1');
  });
  it('builds a context value usable in when-clauses', () => {
    expect(workstreamContext(makeWs())).toBe('workstream;reachable;notCurrent;linked;portable;noAgent;');
    expect(workstreamContext(makeWs({ isCurrent: true }, { isMain: true, path: '/r' }))).toBe('workstream;reachable;current;main;portable;noAgent;');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ui/format.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the formatter**

`src/ui/format.ts`:
```ts
import type { CompareMode } from '../features/diffs/compare';
import type { AttentionState } from '../features/workstreams/attention';
import type { Workstream } from '../features/workstreams/workstream';

export function formatAge(date: Date | undefined, now: Date): string {
  if (!date) return '—';
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export const ATTENTION_LABEL: Record<AttentionState, string> = {
  'waiting-for-input': 'waiting for input',
  error: 'error',
  working: 'working',
  done: 'done',
  active: 'active',
  idle: 'idle',
  stale: 'stale',
  unreachable: 'unreachable from this environment',
};

export const COMPARE_MODE_LABEL: Record<CompareMode, string> = {
  mergeBase: 'since merge-base',
  twoDot: 'two-dot',
  uncommitted: 'incl. uncommitted',
};

const FROM_AGENT: ReadonlySet<AttentionState> = new Set(['waiting-for-input', 'error', 'working', 'done']);

export function workstreamLabel(ws: Workstream): string {
  return ws.worktree.branch ?? `detached @ ${ws.worktree.head?.slice(0, 7) ?? 'unknown'}`;
}

export function describeWorkstream(ws: Workstream, now: Date): string {
  if (ws.attention === 'unreachable') return ATTENTION_LABEL.unreachable;
  const fromAgent = FROM_AGENT.has(ws.attention) && ws.agent !== undefined;
  const since = fromAgent ? ws.agent?.updatedAt : ws.lastActivity;
  const parts = [`${ATTENTION_LABEL[ws.attention]}${fromAgent && ws.agentStale ? ' (last reported)' : ''} · ${formatAge(since, now)}`];
  const p = ws.progress;
  if (p) {
    const counts = [p.ahead ? `↑${p.ahead}` : '', p.behind ? `↓${p.behind}` : '', p.added || p.deleted ? `+${p.added} −${p.deleted}` : '']
      .filter(Boolean)
      .join(' ');
    if (counts) parts.push(counts);
  }
  if (ws.isCurrent) parts.push('this window');
  else if (ws.windowOpen && ws.heartbeat) parts.push(`open in ${ws.heartbeat.env}`);
  if (ws.worktree.isMain) parts.unshift('main worktree');
  return parts.join(' · ');
}

export function workstreamContext(ws: Workstream): string {
  const wt = ws.worktree;
  return [
    'workstream',
    wt.path ? 'reachable' : 'unreachable',
    ws.isCurrent ? 'current' : 'notCurrent',
    wt.isMain ? 'main' : 'linked',
    wt.portable ? 'portable' : 'notPortable',
    ws.agent ? 'hasAgent' : 'noAgent',
    '',
  ].join(';');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/ui/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the VS Code-side helpers**

`src/ui/settings.ts`:
```ts
import * as vscode from 'vscode';

export interface Settings {
  openAfterCreate: 'newWindow' | 'currentWindow' | 'none';
  copyFiles: string[];
  setupCommand: string;
  autoAdopt: boolean;
  defaultBase: string;
  activeWindowMinutes: number;
  staleAfterDays: number;
  agentStatusStaleMinutes: number;
  notifyOnAttention: boolean;
  pollSeconds: number;
}

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration('switchyard');
  return {
    openAfterCreate: c.get<Settings['openAfterCreate']>('openAfterCreate', 'newWindow'),
    copyFiles: c.get<string[]>('copyFiles', []),
    setupCommand: c.get<string>('setupCommand', ''),
    autoAdopt: c.get<boolean>('autoAdopt', true),
    defaultBase: c.get<string>('defaultBase', ''),
    activeWindowMinutes: c.get<number>('activeWindowMinutes', 5),
    staleAfterDays: c.get<number>('staleAfterDays', 7),
    agentStatusStaleMinutes: c.get<number>('agentStatusStaleMinutes', 10),
    notifyOnAttention: c.get<boolean>('notifyOnAttention', true),
    pollSeconds: c.get<number>('pollSeconds', 15),
  };
}
```

`src/core/uris.ts`:
```ts
import * as vscode from 'vscode';

/** Builds a URI for a path in this environment that keeps the window's scheme and remote authority (works in devcontainers). */
export function toWorkspaceUri(reference: vscode.Uri, fsPath: string): vscode.Uri {
  return reference.with({ path: vscode.Uri.file(fsPath).path, query: '', fragment: '' });
}
```

`src/core/diff/gitContentProvider.ts`:
```ts
import * as vscode from 'vscode';
import { readFileAtRef } from './refs';

export const GIT_SCHEME = 'switchyard-git';

export interface GitUriParams {
  worktree: string;
  ref: string;
  path: string;
}

export function makeGitUri(p: GitUriParams): vscode.Uri {
  return vscode.Uri.from({ scheme: GIT_SCHEME, path: `/${p.path}`, query: JSON.stringify(p) });
}

export function parseGitUri(uri: vscode.Uri): GitUriParams {
  return JSON.parse(uri.query) as GitUriParams;
}

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const p = parseGitUri(uri);
    return readFileAtRef(p.worktree, p.ref, p.path);
  }
}
```

`src/core/diff/openDiff.ts`:
```ts
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FileChange } from '../git/porcelain';
import { toWorkspaceUri } from '../uris';
import { makeGitUri } from './gitContentProvider';
import { sideRefsFor, WORKING, type DiffSide } from './refs';

export async function openChangeDiff(
  reference: vscode.Uri,
  worktreeDir: string,
  change: FileChange,
  leftRef: string,
  rightRef: string,
  label: string,
): Promise<void> {
  const { left, right } = sideRefsFor(change, leftRef, rightRef);
  const toUri = (side: DiffSide) =>
    side.ref === WORKING ? toWorkspaceUri(reference, path.join(worktreeDir, side.path)) : makeGitUri({ worktree: worktreeDir, ref: side.ref, path: side.path });
  await vscode.commands.executeCommand('vscode.diff', toUri(left), toUri(right), `${path.posix.basename(change.path)} (${label})`);
}
```

- [ ] **Step 6: Typecheck and run all tests**

Run: `npm run typecheck && npm test`
Expected: no type errors; all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/format.ts src/ui/settings.ts src/core/uris.ts src/core/diff/gitContentProvider.ts src/core/diff/openDiff.ts tests/unit/ui/format.test.ts
git commit -m "$(cat <<'EOF'
feat(ui): add formatting, settings, URIs and git diff content provider

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Claude Code hook snippet

**Files:**
- Create: `src/ui/claudeHooks.ts` (pure, no `vscode` import)
- Test: `tests/unit/ui/claudeHooks.test.ts`

**Interfaces:**
- Consumes: `AgentState`, `parseAgentStatus`, `AGENT_STATUS_FILE` (Task 10).
- Produces: `HOOK_SCRIPT: string` (JavaScript for `node -e`; argv[1] = state; reads hook JSON from stdin; writes `<git-dir>/workstream.json`; never throws), `claudeHookCommand(state: AgentState): string`, `claudeHookConfig(): string` (pretty JSON `{ "hooks": { UserPromptSubmit, PostToolUse, Notification, Stop } }`).

- [ ] **Step 1: Write the failing test**

`tests/unit/ui/claudeHooks.test.ts`:
```ts
import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_STATUS_FILE, parseAgentStatus } from '../../../src/features/workstreams/agentStatus';
import { claudeHookCommand, claudeHookConfig, HOOK_SCRIPT } from '../../../src/ui/claudeHooks';
import { git, initRepo, makeTempDir, removeDir } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

const readStatus = (gitDir: string) => parseAgentStatus(fs.readFileSync(path.join(gitDir, AGENT_STATUS_FILE), 'utf8'));

describe('Claude Code hook', () => {
  it('writes the state and the message from stdin', () => {
    const repo = initRepo();
    cleanup.push(repo);
    execFileSync(process.execPath, ['-e', HOOK_SCRIPT, 'waiting-for-input'], {
      cwd: repo,
      input: JSON.stringify({ message: 'Claude needs your permission to use Bash' }),
    });
    expect(readStatus(path.join(repo, '.git'))).toMatchObject({ state: 'waiting-for-input', message: 'Claude needs your permission to use Bash' });
  });

  it("writes into a linked worktree's own git dir", () => {
    const repo = initRepo();
    cleanup.push(repo);
    const wt = path.join(repo, '.worktrees', 'feat');
    git(repo, 'worktree', 'add', '-b', 'feat', wt);
    execFileSync(process.execPath, ['-e', HOOK_SCRIPT, 'working'], { cwd: wt, input: JSON.stringify({ prompt: 'fix the tests' }) });
    expect(readStatus(path.join(repo, '.git', 'worktrees', 'feat'))).toMatchObject({ state: 'working', message: 'fix the tests' });
  });

  it('runs through the platform shell', () => {
    const repo = initRepo();
    cleanup.push(repo);
    execSync(claudeHookCommand('done'), { cwd: repo, input: '{}' });
    expect(readStatus(path.join(repo, '.git'))?.state).toBe('done');
  });

  it('never fails outside a git repository or with bad input', () => {
    const dir = makeTempDir();
    cleanup.push(dir);
    expect(() => execFileSync(process.execPath, ['-e', HOOK_SCRIPT, 'done'], { cwd: dir, input: 'not json' })).not.toThrow();
  });

  it('contains no characters that cmd, PowerShell or sh would interpret inside double quotes', () => {
    expect(HOOK_SCRIPT).not.toMatch(/["$`!%^<>&]/);
  });

  it('maps hook events to states', () => {
    const config = JSON.parse(claudeHookConfig());
    expect(Object.keys(config.hooks)).toEqual(['UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop']);
    expect(config.hooks.Notification[0].hooks[0]).toEqual({ type: 'command', command: claudeHookCommand('waiting-for-input') });
    expect(config.hooks.Stop[0].hooks[0].command).toBe(claudeHookCommand('done'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ui/claudeHooks.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/ui/claudeHooks.ts`:
```ts
import type { AgentState } from '../features/workstreams/agentStatus';

/**
 * Runs as `node -e "<script>" <state>`. It must not contain characters that cmd, PowerShell or sh
 * interpret inside double quotes: " $ ` ! % ^ < > &.
 */
export const HOOK_SCRIPT = [
  'try{',
  "const f=require('fs'),p=require('path'),c=require('child_process');",
  "let i={};try{i=JSON.parse(f.readFileSync(0,'utf8'))}catch(e){}",
  "const m=String(i.message||i.prompt||'').slice(0,120);",
  "const d=c.execSync('git rev-parse --git-dir',{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();",
  "f.writeFileSync(p.join(d,'workstream.json'),JSON.stringify({state:process.argv[1],message:m||undefined,updatedAt:new Date().toISOString()}))",
  '}catch(e){}',
].join('');

export function claudeHookCommand(state: AgentState): string {
  return `node -e "${HOOK_SCRIPT}" ${state}`;
}

export function claudeHookConfig(): string {
  const entry = (state: AgentState) => [{ hooks: [{ type: 'command', command: claudeHookCommand(state) }] }];
  return JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: entry('working'),
        PostToolUse: entry('working'),
        Notification: entry('waiting-for-input'),
        Stop: entry('done'),
      },
    },
    null,
    2,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/ui/claudeHooks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/claudeHooks.ts tests/unit/ui/claudeHooks.test.ts
git commit -m "$(cat <<'EOF'
feat(ui): generate cross-platform Claude Code hook config

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: Workstreams tree view, status bar, notifications, hygiene prompt

**Files:**
- Create: `src/ui/workstreamsView.ts`, `src/ui/statusBar.ts`, `src/ui/notifications.ts`, `src/ui/hygiene.ts`

**Interfaces:**
- Consumes: `Repository` (Task 14), `Workstream` (Task 13), `FileChange`, `ChangeKind` (Task 3), `compareWithBase`, `CompareMode` (Task 12), `WORKING` (Task 12), `AttentionState`, `attentionTransitions` (Task 11), `pathKey` (Task 2), format helpers + `readSettings` (Task 15).
- Produces (`workstreamsView.ts`): `interface CompareState { base: string; mode: CompareMode }`, `type Node = { type: 'workstream'; ws: Workstream } | { type: 'message'; ws: Workstream; text: string } | { type: 'changes'; ws: Workstream } | { type: 'compare'; ws: Workstream; compare: CompareState } | { type: 'file'; ws: Workstream; change: FileChange; leftRef: string; rightRef: string; label: string } | { type: 'info'; text: string }`, `class WorkstreamsView implements vscode.TreeDataProvider<Node>, vscode.Disposable { constructor(repository: Repository<Workstream>); setCompare(key: string, state: CompareState | undefined): void }`.
- Produces (`statusBar.ts`): `class WorkstreamStatusBar implements vscode.Disposable { constructor(repository: Repository<Workstream>) }` (command `switchyard.quickSwitch`).
- Produces (`notifications.ts`): `class AttentionNotifier implements vscode.Disposable { constructor(repository: Repository<Workstream>, open: (ws: Workstream, newWindow: boolean) => Promise<void>) }`.
- Produces (`hygiene.ts`): `maybeOfferHygiene(extension: vscode.ExtensionContext, mainRoot: string): Promise<void>`.

- [ ] **Step 1: Implement the tree view**

`src/ui/workstreamsView.ts`:
```ts
import * as path from 'node:path';
import * as vscode from 'vscode';
import { WORKING } from '../core/diff/refs';
import type { ChangeKind, FileChange } from '../core/git/porcelain';
import type { Repository } from '../core/repository';
import { compareWithBase, type CompareMode } from '../features/diffs/compare';
import type { AttentionState } from '../features/workstreams/attention';
import type { Workstream } from '../features/workstreams/workstream';
import { ATTENTION_LABEL, COMPARE_MODE_LABEL, describeWorkstream, formatAge, workstreamContext, workstreamLabel } from './format';

export interface CompareState {
  base: string;
  mode: CompareMode;
}

export type Node =
  | { type: 'workstream'; ws: Workstream }
  | { type: 'message'; ws: Workstream; text: string }
  | { type: 'changes'; ws: Workstream }
  | { type: 'compare'; ws: Workstream; compare: CompareState }
  | { type: 'file'; ws: Workstream; change: FileChange; leftRef: string; rightRef: string; label: string }
  | { type: 'info'; text: string };

const ATTENTION_ICON: Record<AttentionState, [string, string | undefined]> = {
  'waiting-for-input': ['bell-dot', 'charts.yellow'],
  error: ['error', 'charts.red'],
  working: ['sync~spin', 'charts.blue'],
  done: ['pass', 'charts.green'],
  active: ['pulse', undefined],
  idle: ['circle-outline', undefined],
  stale: ['history', 'disabledForeground'],
  unreachable: ['debug-disconnect', 'disabledForeground'],
};

const CHANGE_ICON: Record<ChangeKind, string> = {
  modified: 'diff-modified',
  added: 'diff-added',
  deleted: 'diff-removed',
  renamed: 'diff-renamed',
  untracked: 'diff-added',
  conflicted: 'warning',
};

function themeIcon([id, color]: [string, string | undefined]): vscode.ThemeIcon {
  return new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);
}

function tooltip(ws: Workstream, now: Date): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const line = (text: string) => {
    md.appendText(text);
    md.appendMarkdown('\n\n');
  };
  line(workstreamLabel(ws));
  line(ws.worktree.path ?? `${ws.worktree.recordedPath} (not reachable from this environment)`);
  line(`Status: ${ATTENTION_LABEL[ws.attention]}`);
  if (ws.agent) line(`Agent: ${ws.agent.state}${ws.agent.message ? ` — ${ws.agent.message}` : ''} (${formatAge(ws.agent.updatedAt, now)} ago)`);
  const p = ws.progress;
  if (p?.base) line(`vs ${p.base}: ↑${p.ahead} ↓${p.behind}, +${p.added} −${p.deleted}`);
  if (p?.lastSubject) line(`Last commit: ${p.lastSubject}`);
  if (ws.windowOpen && ws.heartbeat) line(`Window open in ${ws.heartbeat.env} (${ws.heartbeat.os})`);
  return md;
}

export class WorkstreamsView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly compares = new Map<string, CompareState>();
  private readonly subscription: { dispose(): void };

  constructor(private readonly repository: Repository<Workstream>) {
    this.subscription = repository.onDidChange(() => this.emitter.fire(undefined));
  }

  setCompare(key: string, state: CompareState | undefined): void {
    if (state) this.compares.set(key, state);
    else this.compares.delete(key);
    this.emitter.fire(undefined);
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.type) {
      case 'workstream': {
        const ws = node.ws;
        const now = new Date();
        const item = new vscode.TreeItem(
          workstreamLabel(ws),
          ws.worktree.path ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        item.id = ws.key;
        item.description = describeWorkstream(ws, now);
        item.iconPath = themeIcon(ATTENTION_ICON[ws.attention]);
        item.tooltip = tooltip(ws, now);
        item.contextValue = workstreamContext(ws);
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(`“${node.text}”`);
        item.id = `${node.ws.key}#message`;
        item.iconPath = new vscode.ThemeIcon('comment');
        item.tooltip = node.text;
        return item;
      }
      case 'changes': {
        const count = node.ws.changes.length;
        const item = new vscode.TreeItem(`Changes (${count})`, count ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = `${node.ws.key}#changes`;
        item.iconPath = new vscode.ThemeIcon('diff');
        item.contextValue = 'changes';
        return item;
      }
      case 'compare': {
        const item = new vscode.TreeItem(`Compare: ${workstreamLabel(node.ws)} ↔ ${node.compare.base}`, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `${node.ws.key}#compare#${node.compare.base}#${node.compare.mode}`;
        item.description = COMPARE_MODE_LABEL[node.compare.mode];
        item.iconPath = new vscode.ThemeIcon('git-compare');
        item.contextValue = 'compare';
        return item;
      }
      case 'file': {
        const change = node.change;
        const item = new vscode.TreeItem(path.posix.basename(change.path));
        item.id = `${node.ws.key}#file#${node.leftRef}#${node.rightRef}#${change.path}`;
        const dir = path.posix.dirname(change.path);
        item.description = [dir === '.' ? '' : dir, change.origPath ? `← ${change.origPath}` : ''].filter(Boolean).join('  ');
        item.iconPath = new vscode.ThemeIcon(CHANGE_ICON[change.kind]);
        item.tooltip = `${change.kind}: ${change.path}`;
        item.contextValue = 'file';
        item.command = { command: 'switchyard.openFileDiff', title: 'Open Diff', arguments: [node] };
        return item;
      }
      case 'info': {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) return this.repository.current.map((ws) => ({ type: 'workstream', ws }));
    switch (node.type) {
      case 'workstream': {
        const ws = node.ws;
        if (!ws.worktree.path) return [];
        const children: Node[] = [];
        if (ws.agent?.message) children.push({ type: 'message', ws, text: ws.agent.message });
        children.push({ type: 'changes', ws });
        const compare = this.compares.get(ws.key);
        if (compare) children.push({ type: 'compare', ws, compare });
        return children;
      }
      case 'changes': {
        const label = `${workstreamLabel(node.ws)}: HEAD ↔ working`;
        return node.ws.changes.map((change) => ({ type: 'file', ws: node.ws, change, leftRef: 'HEAD', rightRef: WORKING, label }));
      }
      case 'compare': {
        const dir = node.ws.worktree.path;
        if (!dir) return [];
        try {
          const result = await compareWithBase(dir, node.compare.base, node.compare.mode);
          if (result.files.length === 0) return [{ type: 'info', text: 'No differences' }];
          const label = `${node.compare.base} ↔ ${workstreamLabel(node.ws)}`;
          return result.files.map((change) => ({ type: 'file', ws: node.ws, change, leftRef: result.leftRef, rightRef: result.rightRef, label }));
        } catch (error) {
          return [{ type: 'info', text: `Compare failed: ${error instanceof Error ? error.message : String(error)}` }];
        }
      }
      default:
        return [];
    }
  }
}
```

- [ ] **Step 2: Implement status bar, notifications and hygiene**

`src/ui/statusBar.ts`:
```ts
import * as vscode from 'vscode';
import type { Repository } from '../core/repository';
import type { Workstream } from '../features/workstreams/workstream';
import { workstreamLabel } from './format';

export class WorkstreamStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('switchyard.current', vscode.StatusBarAlignment.Left, 50);
  private readonly subscription: { dispose(): void };

  constructor(private readonly repository: Repository<Workstream>) {
    this.item.name = 'Switchyard';
    this.item.command = 'switchyard.quickSwitch';
    this.subscription = repository.onDidChange(() => this.update());
    this.update();
    this.item.show();
  }

  private update(): void {
    const items = this.repository.current;
    const current = items.find((ws) => ws.isCurrent);
    const waiting = items.filter((ws) => !ws.isCurrent && (ws.attention === 'waiting-for-input' || ws.attention === 'error')).length;
    this.item.text = `$(git-branch) ${current ? workstreamLabel(current) : 'Switchyard'}${waiting ? `  $(bell-dot) ${waiting}` : ''}`;
    this.item.tooltip = waiting ? `${waiting} workstream(s) need attention. Click to switch.` : 'Switch workstream';
    this.item.backgroundColor = waiting ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}
```

`src/ui/notifications.ts`:
```ts
import * as vscode from 'vscode';
import type { Repository } from '../core/repository';
import { attentionTransitions, type AttentionState } from '../features/workstreams/attention';
import type { Workstream } from '../features/workstreams/workstream';
import { workstreamLabel } from './format';
import { readSettings } from './settings';

export class AttentionNotifier implements vscode.Disposable {
  private previous: Map<string, AttentionState> | undefined;
  private readonly subscription: { dispose(): void };

  constructor(
    private readonly repository: Repository<Workstream>,
    private readonly open: (ws: Workstream, newWindow: boolean) => Promise<void>,
  ) {
    this.subscription = repository.onDidChange(() => this.onChange());
  }

  private onChange(): void {
    const items = this.repository.current;
    const keys = attentionTransitions(this.previous, items.map((ws) => ({ key: ws.key, attention: ws.attention })));
    this.previous = new Map(items.map((ws) => [ws.key, ws.attention]));
    if (!readSettings().notifyOnAttention) return;
    for (const key of keys) {
      const ws = items.find((w) => w.key === key);
      if (ws && !ws.isCurrent && ws.worktree.path) void this.notify(ws);
    }
  }

  private async notify(ws: Workstream): Promise<void> {
    const label = workstreamLabel(ws);
    const detail = ws.agent?.message ? `: ${ws.agent.message}` : '';
    const text = ws.attention === 'error' ? `'${label}' reported an error${detail}` : `'${label}' is waiting for input${detail}`;
    const buttons = ['Open Window', 'Switch Here'];
    const choice =
      ws.attention === 'error'
        ? await vscode.window.showWarningMessage(text, ...buttons)
        : await vscode.window.showInformationMessage(text, ...buttons);
    if (choice) await this.open(ws, choice === 'Open Window');
  }

  dispose(): void {
    this.subscription.dispose();
  }
}
```

`src/ui/hygiene.ts`:
```ts
import * as vscode from 'vscode';
import { pathKey } from '../core/paths';

function valueAt<T>(config: vscode.WorkspaceConfiguration, key: string, target: vscode.ConfigurationTarget): T | undefined {
  const inspected = config.inspect<T>(key);
  const explicit = target === vscode.ConfigurationTarget.Global ? inspected?.globalValue : inspected?.workspaceValue;
  return explicit ?? inspected?.defaultValue;
}

async function apply(target: vscode.ConfigurationTarget): Promise<void> {
  const git = vscode.workspace.getConfiguration('git');
  const scan = valueAt<string[]>(git, 'repositoryScanIgnoredFolders', target) ?? [];
  if (!scan.includes('.worktrees')) await git.update('repositoryScanIgnoredFolders', [...scan, '.worktrees'], target);
  // Relative patterns resolve against each window's own folder, so a window opened on a worktree is unaffected.
  const excludes: Array<[string, string, string]> = [
    ['files', 'watcherExclude', '.worktrees/**'],
    ['search', 'exclude', '.worktrees'],
  ];
  for (const [section, key, glob] of excludes) {
    const config = vscode.workspace.getConfiguration(section);
    const current = valueAt<Record<string, boolean>>(config, key, target) ?? {};
    if (!current[glob]) await config.update(key, { ...current, [glob]: true }, target);
  }
}

export async function maybeOfferHygiene(extension: vscode.ExtensionContext, mainRoot: string): Promise<void> {
  const key = `switchyard.hygieneOffered:${pathKey(mainRoot)}`;
  if (extension.globalState.get<boolean>(key)) return;
  await extension.globalState.update(key, true);
  const user = 'User Settings (recommended)';
  const workspace = 'Workspace Settings';
  const choice = await vscode.window.showInformationMessage(
    'Hide .worktrees from search, file watching and the built-in Git repository scan?',
    user,
    workspace,
    'No',
  );
  if (choice === user) await apply(vscode.ConfigurationTarget.Global);
  else if (choice === workspace) await apply(vscode.ConfigurationTarget.Workspace);
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/ui/workstreamsView.ts src/ui/statusBar.ts src/ui/notifications.ts src/ui/hygiene.ts
git commit -m "$(cat <<'EOF'
feat(ui): add workstreams tree, status bar, notifications and hygiene prompt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: Commands

**Files:**
- Create: `src/ui/commands.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–17 (`WorktreeService`, `Repository`, `WorkstreamsView`, `Node`, `openChangeDiff`, `toWorkspaceUri`, `copySetupFiles`, `branchNameProblem`, `clearAgentStatus`, `resolveBase`, `claudeHookConfig`, `maybeOfferHygiene`, `readSettings`, format helpers, `GitError`, `samePath`).
- Produces: `interface CommandContext { extension: vscode.ExtensionContext; service: WorktreeService; repository: Repository<Workstream>; view: WorkstreamsView; reference: vscode.Uri; currentRoot: string; output: vscode.OutputChannel }`, `registerCommands(ctx: CommandContext): void`, `openWorktree(ctx: CommandContext, dir: string, newWindow: boolean): Promise<void>`, `resumePendingActions(ctx: CommandContext): Promise<void>`.
- Command ids (used by `package.json` in Task 19): `switchyard.refresh`, `switchyard.newWorkstream`, `switchyard.quickSwitch`, `switchyard.openInNewWindow`, `switchyard.switchHere`, `switchyard.remove`, `switchyard.adopt`, `switchyard.runSetupHere`, `switchyard.openTerminal`, `switchyard.copyPath`, `switchyard.revealInOS`, `switchyard.compareWith`, `switchyard.compareToggleTwoDot`, `switchyard.compareToggleUncommitted`, `switchyard.compareDismiss`, `switchyard.openFileDiff`, `switchyard.openFile`, `switchyard.clearAgentStatus`, `switchyard.copyClaudeHookConfig`.

- [ ] **Step 1: Implement**

`src/ui/commands.ts`:
```ts
import * as path from 'node:path';
import * as vscode from 'vscode';
import { openChangeDiff } from '../core/diff/openDiff';
import { GitError } from '../core/git/gitCli';
import { samePath } from '../core/paths';
import type { Repository } from '../core/repository';
import { toWorkspaceUri } from '../core/uris';
import type { CompareMode } from '../features/diffs/compare';
import { clearAgentStatus } from '../features/workstreams/agentStatus';
import { resolveBase } from '../features/workstreams/progress';
import type { Workstream } from '../features/workstreams/workstream';
import { branchNameProblem } from '../features/worktrees/layout';
import { copySetupFiles } from '../features/worktrees/setup';
import type { CreateRequest, WorktreeService } from '../features/worktrees/worktreeService';
import { claudeHookConfig } from './claudeHooks';
import { describeWorkstream, workstreamLabel } from './format';
import { maybeOfferHygiene } from './hygiene';
import { readSettings } from './settings';
import type { Node, WorkstreamsView } from './workstreamsView';

export interface CommandContext {
  extension: vscode.ExtensionContext;
  service: WorktreeService;
  repository: Repository<Workstream>;
  view: WorkstreamsView;
  /** URI of this window's workspace folder; keeps scheme and remote authority. */
  reference: vscode.Uri;
  /** Root of the worktree open in this window. */
  currentRoot: string;
  output: vscode.OutputChannel;
}

const PENDING_REMOVAL_KEY = 'switchyard.pendingRemoval';
const PENDING_SETUP_KEY = 'switchyard.pendingSetup';

interface PendingRemoval {
  mainRoot: string;
  adminDir: string;
  force: boolean;
  deleteBranch: boolean;
  branch: string | undefined;
}

interface PendingSetup {
  worktreeDir: string;
  command: string;
}

interface PickFilter {
  includeUnreachable?: boolean;
  excludeMain?: boolean;
}

type Handler = (...args: any[]) => unknown;

export async function openWorktree(ctx: CommandContext, dir: string, newWindow: boolean): Promise<void> {
  await vscode.commands.executeCommand('vscode.openFolder', toWorkspaceUri(ctx.reference, dir), { forceNewWindow: newWindow });
}

export function registerCommands(ctx: CommandContext): void {
  const register = (id: string, handler: Handler) => ctx.extension.subscriptions.push(vscode.commands.registerCommand(id, guard(ctx, handler)));
  const withWs =
    (handler: (ws: Workstream) => unknown, filter: PickFilter = {}) =>
    async (node?: Node) => {
      const ws = await pickWorkstream(ctx, node, filter);
      if (ws) await handler(ws);
    };

  register('switchyard.refresh', () => ctx.repository.refresh());
  register('switchyard.newWorkstream', () => newWorkstream(ctx));
  register('switchyard.quickSwitch', () => quickSwitch(ctx));
  register('switchyard.openInNewWindow', withWs((ws) => openWorktree(ctx, ws.worktree.path!, true)));
  register('switchyard.switchHere', withWs((ws) => openWorktree(ctx, ws.worktree.path!, false)));
  register('switchyard.remove', withWs((ws) => removeWorkstream(ctx, ws), { includeUnreachable: true, excludeMain: true }));
  register(
    'switchyard.adopt',
    withWs(
      async (ws) => {
        await ctx.service.adopt(ws.worktree);
        void maybeOfferHygiene(ctx.extension, ctx.service.roots.mainRoot);
        await ctx.repository.refresh();
      },
      { excludeMain: true },
    ),
  );
  register('switchyard.runSetupHere', withWs((ws) => runSetupNow(ctx, ws.worktree.path!), { excludeMain: true }));
  register('switchyard.openTerminal', withWs((ws) => vscode.window.createTerminal({ name: workstreamLabel(ws), cwd: ws.worktree.path }).show()));
  register('switchyard.copyPath', withWs((ws) => vscode.env.clipboard.writeText(ws.worktree.path!)));
  register('switchyard.revealInOS', withWs((ws) => vscode.commands.executeCommand('revealFileInOS', toWorkspaceUri(ctx.reference, ws.worktree.path!))));
  register('switchyard.compareWith', withWs((ws) => compareWith(ctx, ws)));
  register('switchyard.compareToggleTwoDot', (node?: Node) => toggleCompareMode(ctx, node, 'twoDot'));
  register('switchyard.compareToggleUncommitted', (node?: Node) => toggleCompareMode(ctx, node, 'uncommitted'));
  register('switchyard.compareDismiss', (node?: Node) => {
    if (node?.type === 'compare') ctx.view.setCompare(node.ws.key, undefined);
  });
  register('switchyard.openFileDiff', (node?: Node) => {
    if (node?.type === 'file' && node.ws.worktree.path) {
      return openChangeDiff(ctx.reference, node.ws.worktree.path, node.change, node.leftRef, node.rightRef, node.label);
    }
  });
  register('switchyard.openFile', (node?: Node) => openFile(ctx, node));
  register(
    'switchyard.clearAgentStatus',
    withWs(
      async (ws) => {
        await clearAgentStatus(ws.worktree.adminDir);
        await ctx.repository.refresh();
      },
      { includeUnreachable: true },
    ),
  );
  register('switchyard.copyClaudeHookConfig', async () => {
    await vscode.env.clipboard.writeText(claudeHookConfig());
    void vscode.window.showInformationMessage(
      'Claude Code hook config copied. Merge it into the "hooks" section of .claude/settings.json (project) or ~/.claude/settings.json (user).',
    );
  });
}

export async function resumePendingActions(ctx: CommandContext): Promise<void> {
  const state = ctx.extension.globalState;
  const queue = state.get<PendingSetup[]>(PENDING_SETUP_KEY, []);
  const mine = queue.filter((p) => samePath(p.worktreeDir, ctx.currentRoot));
  if (mine.length) {
    await state.update(PENDING_SETUP_KEY, queue.filter((p) => !mine.includes(p)));
    for (const p of mine) startSetupTerminal(p.worktreeDir, p.command);
  }
  const removal = state.get<PendingRemoval>(PENDING_REMOVAL_KEY);
  if (removal && samePath(removal.mainRoot, ctx.service.roots.mainRoot) && samePath(ctx.currentRoot, removal.mainRoot)) {
    await state.update(PENDING_REMOVAL_KEY, undefined);
    await guard(ctx, () => executeRemoval(ctx, removal))();
  }
}

function guard(ctx: CommandContext, handler: Handler): Handler {
  return async (...args: unknown[]) => {
    try {
      return await handler(...args);
    } catch (error) {
      await reportError(ctx, error);
    }
  };
}

async function reportError(ctx: CommandContext, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  ctx.output.appendLine(message);
  const checkedOut = error instanceof GitError ? /(?:already checked out|is already used by worktree) at '([^']+)'/.exec(error.stderr) : null;
  if (checkedOut) {
    const choice = await vscode.window.showErrorMessage(`That branch is already checked out in ${checkedOut[1]}.`, 'Open That Worktree');
    if (choice) await openWorktree(ctx, checkedOut[1], true);
    return;
  }
  const choice = await vscode.window.showErrorMessage(message, 'Show Output');
  if (choice) ctx.output.show();
}

async function pickWorkstream(ctx: CommandContext, node: Node | undefined, filter: PickFilter): Promise<Workstream | undefined> {
  if (node?.type === 'workstream') return node.ws;
  const now = new Date();
  const candidates = ctx.repository.current.filter(
    (ws) => (filter.includeUnreachable || ws.worktree.path) && !(filter.excludeMain && ws.worktree.isMain),
  );
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage('No matching workstreams.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    candidates.map((ws) => ({ label: workstreamLabel(ws), description: describeWorkstream(ws, now), ws })),
    { placeHolder: 'Select a workstream' },
  );
  return picked?.ws;
}

type SourceItem = vscode.QuickPickItem & { value: CreateRequest['kind'] };

async function newWorkstream(ctx: CommandContext): Promise<void> {
  const source = await vscode.window.showQuickPick<SourceItem>(
    [
      { label: '$(add) New branch…', value: 'new' },
      { label: '$(git-branch) Existing local branch', value: 'existing' },
      { label: '$(cloud) Remote branch', value: 'remote' },
    ],
    { title: 'New workstream' },
  );
  if (!source) return;
  const branches = await ctx.service.listBranches();
  let request: CreateRequest;
  if (source.value === 'new') {
    const branch = await vscode.window.showInputBox({
      title: 'New branch name',
      prompt: 'The worktree folder is named after the branch.',
      validateInput: (value) => branchNameProblem(value, branches.local),
    });
    if (!branch) return;
    const startPoint = await vscode.window.showQuickPick(['HEAD', ...branches.local, ...branches.remote], { title: `Start '${branch}' from…` });
    if (!startPoint) return;
    request = { kind: 'new', branch, startPoint };
  } else if (source.value === 'existing') {
    const checkedOut = new Set(ctx.repository.current.map((ws) => ws.worktree.branch));
    const free = branches.local.filter((b) => !checkedOut.has(b));
    if (free.length === 0) {
      void vscode.window.showInformationMessage('Every local branch is already checked out in a worktree.');
      return;
    }
    const branch = await vscode.window.showQuickPick(free, { title: 'Branch to check out' });
    if (!branch) return;
    request = { kind: 'existing', branch };
  } else {
    if (branches.remote.length === 0) {
      void vscode.window.showInformationMessage('No remote branches found. Run git fetch first.');
      return;
    }
    const remoteRef = await vscode.window.showQuickPick(branches.remote, { title: 'Remote branch' });
    if (!remoteRef) return;
    request = { kind: 'remote', remoteRef };
  }

  const created = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Creating worktree…' },
    () => ctx.service.create(request),
  );
  const dir = created.path!;
  const settings = readSettings();
  const copied = await copySetupFiles(ctx.service.roots.mainRoot, dir, settings.copyFiles);
  if (copied.length) ctx.output.appendLine(`Copied into ${dir}: ${copied.join(', ')}`);
  await ctx.repository.refresh();
  if (settings.openAfterCreate !== 'currentWindow') void maybeOfferHygiene(ctx.extension, ctx.service.roots.mainRoot);
  if (settings.openAfterCreate === 'none') {
    startSetupTerminal(dir, settings.setupCommand);
    return;
  }
  await queueSetup(ctx, dir, settings.setupCommand);
  await openWorktree(ctx, dir, settings.openAfterCreate === 'newWindow');
}

async function runSetupNow(ctx: CommandContext, dir: string): Promise<void> {
  const settings = readSettings();
  const copied = await copySetupFiles(ctx.service.roots.mainRoot, dir, settings.copyFiles);
  ctx.output.appendLine(copied.length ? `Copied into ${dir}: ${copied.join(', ')}` : `No setup files to copy into ${dir}.`);
  if (!settings.setupCommand.trim()) {
    if (!copied.length) void vscode.window.showInformationMessage('Nothing to do: set switchyard.copyFiles or switchyard.setupCommand.');
    return;
  }
  startSetupTerminal(dir, settings.setupCommand);
}

function startSetupTerminal(dir: string, command: string): void {
  if (!command.trim()) return;
  const terminal = vscode.window.createTerminal({ name: `Setup: ${path.basename(dir)}`, cwd: dir });
  terminal.show(true);
  terminal.sendText(command);
}

async function queueSetup(ctx: CommandContext, dir: string, command: string): Promise<void> {
  if (!command.trim()) return;
  const queue = ctx.extension.globalState.get<PendingSetup[]>(PENDING_SETUP_KEY, []);
  await ctx.extension.globalState.update(PENDING_SETUP_KEY, [...queue, { worktreeDir: dir, command }]);
}

async function quickSwitch(ctx: CommandContext): Promise<void> {
  type Item = vscode.QuickPickItem & { ws?: Workstream };
  const now = new Date();
  const newWindowButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('empty-window'), tooltip: 'Open in New Window' };
  const items: Item[] = ctx.repository.current
    .filter((ws) => ws.worktree.path)
    .map((ws) => ({
      label: `${ws.isCurrent ? '$(check) ' : ''}${workstreamLabel(ws)}`,
      description: describeWorkstream(ws, now),
      ws,
      buttons: ws.isCurrent ? [] : [newWindowButton],
    }));
  items.push({ label: '$(add) New workstream…' });
  const quickPick = vscode.window.createQuickPick<Item>();
  quickPick.items = items;
  quickPick.placeholder = 'Switch this window to a workstream (or use the button to open a new window)';
  const result = await new Promise<{ item?: Item; newWindow: boolean }>((resolve) => {
    quickPick.onDidAccept(() => resolve({ item: quickPick.selectedItems[0], newWindow: false }));
    quickPick.onDidTriggerItemButton((e) => resolve({ item: e.item, newWindow: true }));
    quickPick.onDidHide(() => resolve({ newWindow: false }));
    quickPick.show();
  });
  quickPick.dispose();
  if (!result.item) return;
  if (!result.item.ws) return newWorkstream(ctx);
  if (result.item.ws.isCurrent) return;
  await openWorktree(ctx, result.item.ws.worktree.path!, result.newWindow);
}

async function compareWith(ctx: CommandContext, ws: Workstream): Promise<void> {
  const dir = ws.worktree.path!;
  const branches = await ctx.service.listBranches();
  const defaultBase = await resolveBase(dir, readSettings().defaultBase);
  const options = [...new Set([defaultBase, ...branches.local, ...branches.remote])].filter(
    (b): b is string => b !== undefined && b !== ws.worktree.branch,
  );
  const base = await vscode.window.showQuickPick(options, { title: `Compare '${workstreamLabel(ws)}' with…` });
  if (!base) return;
  ctx.view.setCompare(ws.key, { base, mode: 'mergeBase' });
}

function toggleCompareMode(ctx: CommandContext, node: Node | undefined, mode: Exclude<CompareMode, 'mergeBase'>): void {
  if (node?.type !== 'compare') return;
  ctx.view.setCompare(node.ws.key, { ...node.compare, mode: node.compare.mode === mode ? 'mergeBase' : mode });
}

async function openFile(ctx: CommandContext, node: Node | undefined): Promise<void> {
  if (node?.type !== 'file' || !node.ws.worktree.path) return;
  if (node.change.kind === 'deleted') {
    void vscode.window.showInformationMessage(`${node.change.path} was deleted.`);
    return;
  }
  await vscode.window.showTextDocument(toWorkspaceUri(ctx.reference, path.join(node.ws.worktree.path, node.change.path)));
}

async function removeWorkstream(ctx: CommandContext, ws: Workstream): Promise<void> {
  const wt = ws.worktree;
  if (wt.isMain) {
    void vscode.window.showWarningMessage('The main worktree cannot be removed.');
    return;
  }
  if (!wt.path) return forgetWorkstream(ctx, ws);
  const risks = await ctx.service.removalRisks(wt);
  const lines: string[] = [];
  if (risks.changedFiles) lines.push(`${risks.changedFiles} uncommitted or untracked file(s) will be deleted.`);
  if (risks.unmergedCommits && wt.branch) {
    lines.push(`Branch '${wt.branch}' has ${risks.unmergedCommits} commit(s) that are on no other branch or remote.`);
  }
  lines.push('If this worktree is open in another window (including another environment), that window will lose its folder.');
  const removeOnly = 'Remove';
  const removeAndDelete = 'Remove and Delete Branch';
  const choice = await vscode.window.showWarningMessage(
    `Remove worktree '${workstreamLabel(ws)}'?`,
    { modal: true, detail: lines.join('\n') },
    ...(wt.branch ? [removeOnly, removeAndDelete] : [removeOnly]),
  );
  if (!choice) return;
  const plan: PendingRemoval = {
    mainRoot: ctx.service.roots.mainRoot,
    adminDir: wt.adminDir,
    force: risks.changedFiles > 0,
    deleteBranch: choice === removeAndDelete,
    branch: wt.branch,
  };
  if (ws.isCurrent) {
    await ctx.extension.globalState.update(PENDING_REMOVAL_KEY, plan);
    await openWorktree(ctx, plan.mainRoot, false);
    return;
  }
  await executeRemoval(ctx, plan);
}

async function executeRemoval(ctx: CommandContext, plan: PendingRemoval): Promise<void> {
  const wt = (await ctx.service.list()).find((w) => samePath(w.adminDir, plan.adminDir));
  if (wt) await ctx.service.remove(wt, { force: plan.force });
  if (plan.deleteBranch && plan.branch) {
    try {
      await ctx.service.deleteBranch(plan.branch, false);
    } catch (error) {
      const choice = await vscode.window.showWarningMessage(
        `Branch '${plan.branch}' is not fully merged. Delete it anyway?`,
        { modal: true, detail: error instanceof Error ? error.message : String(error) },
        'Delete Anyway',
      );
      if (choice) await ctx.service.deleteBranch(plan.branch, true);
    }
  }
  await ctx.repository.refresh();
}

async function forgetWorkstream(ctx: CommandContext, ws: Workstream): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    `Forget worktree '${workstreamLabel(ws)}'?`,
    {
      modal: true,
      detail:
        `It is not reachable from this environment (git recorded it at ${ws.worktree.recordedPath}). ` +
        'If it still exists in another environment, remove it from there instead. ' +
        "Forgetting deletes git's record of it; no worktree files are touched.",
    },
    'Forget',
  );
  if (!choice) return;
  await ctx.service.forget(ws.worktree);
  await ctx.repository.refresh();
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/commands.ts
git commit -m "$(cat <<'EOF'
feat(ui): add workstream commands (create, open, remove, compare, setup)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 19: Extension activation, refresh triggers, heartbeat and `package.json` contributions

**Files:**
- Modify: `src/extension.ts` (replace the stub from Task 1)
- Modify: `package.json` (replace `"contributes": {}`)

**Interfaces:**
- Consumes: `getGitVersion`, `MIN_GIT_VERSION`, `versionAtLeast`, `runGit`, `GitError` (Task 2), `locateRepo` (Task 4), `Repository` (Task 14), `WorktreeService` (Task 8), `buildWorkstreams`, `Workstream` (Task 13), heartbeat (Task 10), `GIT_SCHEME`, `GitContentProvider`, `toWorkspaceUri`, `readSettings` (Task 15), view/status bar/notifier (Task 17), `registerCommands`, `resumePendingActions`, `openWorktree`, `CommandContext` (Task 18).
- Produces: context key `switchyard.state` ∈ `'ready' | 'noRepo' | 'gitMissing'`; view id `switchyard.workstreams`; activity-bar container id `switchyard`.

- [ ] **Step 1: Write `src/extension.ts`**

```ts
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GIT_SCHEME, GitContentProvider } from './core/diff/gitContentProvider';
import { getGitVersion, GitError, MIN_GIT_VERSION, runGit, versionAtLeast } from './core/git/gitCli';
import { locateRepo } from './core/repoLocator';
import { Repository } from './core/repository';
import { toWorkspaceUri } from './core/uris';
import { deleteHeartbeat, envFromRemoteName, HEARTBEAT_FILE, HEARTBEAT_INTERVAL_MS, writeHeartbeat } from './features/workstreams/heartbeat';
import { buildWorkstreams, type Workstream } from './features/workstreams/workstream';
import { WorktreeService } from './features/worktrees/worktreeService';
import { openWorktree, registerCommands, resumePendingActions, type CommandContext } from './ui/commands';
import { AttentionNotifier } from './ui/notifications';
import { readSettings } from './ui/settings';
import { WorkstreamStatusBar } from './ui/statusBar';
import { WorkstreamsView } from './ui/workstreamsView';

const BACKGROUND_POLL_SECONDS = 60;
let heartbeatGitDir: string | undefined;

function setState(state: 'ready' | 'noRepo' | 'gitMissing'): Thenable<unknown> {
  return vscode.commands.executeCommand('setContext', 'switchyard.state', state);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Switchyard');
  context.subscriptions.push(output, vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, new GitContentProvider()));

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    await setState('noRepo');
    return;
  }
  const cwd = folder.uri.fsPath;
  const version = await getGitVersion(cwd);
  if (!version || !versionAtLeast(version, MIN_GIT_VERSION)) {
    await setState('gitMissing');
    void vscode.window.showErrorMessage(
      `Switchyard needs git ${MIN_GIT_VERSION.join('.')} or newer in this environment (${version ? `found ${version.join('.')}` : 'git not found'}).`,
    );
    return;
  }
  const location = await locateRepo(cwd);
  if (!location) {
    const probe = await runGit(['rev-parse', '--git-dir'], { cwd }).catch((e: unknown) => e);
    if (probe instanceof GitError && /relativeworktrees/i.test(probe.stderr)) {
      void vscode.window.showWarningMessage(
        `This repository uses git's relative worktree paths (extensions.relativeWorktrees), which need git 2.48+. This environment has git ${version.join('.')}.`,
      );
    }
    await setState('noRepo');
    return;
  }

  const service = new WorktreeService(location, () => ({ autoAdopt: readSettings().autoAdopt }));
  const repository = new Repository<Workstream>(
    () =>
      buildWorkstreams(service, {
        currentWorktreeRoot: location.worktreeRoot,
        settings: readSettings(),
        now: new Date(),
        onInvalidStatus: (file) => output.appendLine(`Ignoring invalid agent status file: ${file}`),
      }),
    300,
    (error) => output.appendLine(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`),
  );
  const view = new WorkstreamsView(repository);
  const treeView = vscode.window.createTreeView('switchyard.workstreams', { treeDataProvider: view, showCollapseAll: true });
  const ctx: CommandContext = { extension: context, service, repository, view, reference: folder.uri, currentRoot: location.worktreeRoot, output };
  context.subscriptions.push(
    view,
    treeView,
    new WorkstreamStatusBar(repository),
    new AttentionNotifier(repository, (ws, newWindow) => openWorktree(ctx, ws.worktree.path!, newWindow)),
    { dispose: () => repository.dispose() },
  );
  registerCommands(ctx);
  await setState('ready');

  // Heartbeat: tells other windows (in any environment) that this worktree is open.
  heartbeatGitDir = location.gitDir;
  const env = envFromRemoteName(vscode.env.remoteName);
  const beat = () => writeHeartbeat(location.gitDir, env).catch((e: unknown) => output.appendLine(`Heartbeat failed: ${String(e)}`));
  void beat();
  const heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(heartbeatTimer) });

  // Refresh triggers: watchers (unreliable on bind mounts), focus, polling, settings.
  const refresh = () => void repository.refresh();
  const watched: Array<[string, string]> = [
    [path.join(location.commonDir, 'worktrees'), '**'],
    [location.commonDir, '{HEAD,workstream.json}'],
    [path.join(location.mainRoot, '.worktrees'), '*'],
  ];
  for (const [base, glob] of watched) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(toWorkspaceUri(folder.uri, base), glob));
    const onEvent = (uri: vscode.Uri) => {
      if (!uri.path.endsWith(`/${HEARTBEAT_FILE}`)) refresh();
    };
    watcher.onDidCreate(onEvent);
    watcher.onDidChange(onEvent);
    watcher.onDidDelete(onEvent);
    context.subscriptions.push(watcher);
  }
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const schedulePoll = () => {
    if (pollTimer) clearInterval(pollTimer);
    const seconds = treeView.visible ? readSettings().pollSeconds : BACKGROUND_POLL_SECONDS;
    pollTimer = setInterval(refresh, Math.max(5, seconds) * 1000);
  };
  schedulePoll();
  context.subscriptions.push(
    treeView.onDidChangeVisibility(() => {
      schedulePoll();
      if (treeView.visible) refresh();
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('switchyard')) {
        schedulePoll();
        refresh();
      }
    }),
    { dispose: () => pollTimer && clearInterval(pollTimer) },
  );

  await repository.refresh();
  await resumePendingActions(ctx);
}

export async function deactivate(): Promise<void> {
  if (heartbeatGitDir) await deleteHeartbeat(heartbeatGitDir).catch(() => undefined);
}
```

- [ ] **Step 2: Replace `"contributes": {}` in `package.json`**

```json
"contributes": {
  "viewsContainers": {
    "activitybar": [{ "id": "switchyard", "title": "Switchyard", "icon": "media/switchyard.svg" }]
  },
  "views": {
    "switchyard": [{ "id": "switchyard.workstreams", "name": "Workstreams" }]
  },
  "viewsWelcome": [
    {
      "view": "switchyard.workstreams",
      "contents": "Switchyard needs git 2.17 or newer in this environment.\n[Download git](https://git-scm.com/downloads)",
      "when": "switchyard.state == gitMissing"
    },
    {
      "view": "switchyard.workstreams",
      "contents": "Open a folder inside a git repository to manage workstreams.",
      "when": "switchyard.state == noRepo"
    }
  ],
  "commands": [
    { "command": "switchyard.refresh", "title": "Refresh", "category": "Switchyard", "icon": "$(refresh)" },
    { "command": "switchyard.newWorkstream", "title": "New Workstream…", "category": "Switchyard", "icon": "$(add)" },
    { "command": "switchyard.quickSwitch", "title": "Switch Workstream…", "category": "Switchyard" },
    { "command": "switchyard.openInNewWindow", "title": "Open in New Window", "category": "Switchyard", "icon": "$(empty-window)" },
    { "command": "switchyard.switchHere", "title": "Switch This Window Here", "category": "Switchyard", "icon": "$(arrow-swap)" },
    { "command": "switchyard.remove", "title": "Remove Worktree…", "category": "Switchyard", "icon": "$(trash)" },
    { "command": "switchyard.adopt", "title": "Make Portable (Adopt)", "category": "Switchyard" },
    { "command": "switchyard.runSetupHere", "title": "Run Setup Here", "category": "Switchyard" },
    { "command": "switchyard.openTerminal", "title": "Open Terminal Here", "category": "Switchyard" },
    { "command": "switchyard.copyPath", "title": "Copy Path", "category": "Switchyard" },
    { "command": "switchyard.revealInOS", "title": "Reveal in File Explorer", "category": "Switchyard" },
    { "command": "switchyard.compareWith", "title": "Compare with…", "category": "Switchyard", "icon": "$(git-compare)" },
    { "command": "switchyard.compareToggleTwoDot", "title": "Toggle Two-Dot Compare", "category": "Switchyard", "icon": "$(arrow-both)" },
    { "command": "switchyard.compareToggleUncommitted", "title": "Toggle Include Uncommitted", "category": "Switchyard", "icon": "$(edit)" },
    { "command": "switchyard.compareDismiss", "title": "Dismiss Compare", "category": "Switchyard", "icon": "$(close)" },
    { "command": "switchyard.openFileDiff", "title": "Open Diff", "category": "Switchyard" },
    { "command": "switchyard.openFile", "title": "Open File", "category": "Switchyard", "icon": "$(go-to-file)" },
    { "command": "switchyard.clearAgentStatus", "title": "Clear Agent Status", "category": "Switchyard" },
    { "command": "switchyard.copyClaudeHookConfig", "title": "Copy Claude Code Hook Config", "category": "Switchyard" }
  ],
  "menus": {
    "commandPalette": [
      { "command": "switchyard.refresh", "when": "switchyard.state == ready" },
      { "command": "switchyard.newWorkstream", "when": "switchyard.state == ready" },
      { "command": "switchyard.quickSwitch", "when": "switchyard.state == ready" },
      { "command": "switchyard.openInNewWindow", "when": "switchyard.state == ready" },
      { "command": "switchyard.switchHere", "when": "switchyard.state == ready" },
      { "command": "switchyard.remove", "when": "switchyard.state == ready" },
      { "command": "switchyard.adopt", "when": "switchyard.state == ready" },
      { "command": "switchyard.runSetupHere", "when": "switchyard.state == ready" },
      { "command": "switchyard.openTerminal", "when": "switchyard.state == ready" },
      { "command": "switchyard.copyPath", "when": "switchyard.state == ready" },
      { "command": "switchyard.revealInOS", "when": "switchyard.state == ready && !remoteName" },
      { "command": "switchyard.compareWith", "when": "switchyard.state == ready" },
      { "command": "switchyard.clearAgentStatus", "when": "switchyard.state == ready" },
      { "command": "switchyard.compareToggleTwoDot", "when": "false" },
      { "command": "switchyard.compareToggleUncommitted", "when": "false" },
      { "command": "switchyard.compareDismiss", "when": "false" },
      { "command": "switchyard.openFileDiff", "when": "false" },
      { "command": "switchyard.openFile", "when": "false" }
    ],
    "view/title": [
      { "command": "switchyard.newWorkstream", "when": "view == switchyard.workstreams && switchyard.state == ready", "group": "navigation@1" },
      { "command": "switchyard.refresh", "when": "view == switchyard.workstreams && switchyard.state == ready", "group": "navigation@2" },
      { "command": "switchyard.copyClaudeHookConfig", "when": "view == switchyard.workstreams", "group": "1_agents@1" }
    ],
    "view/item/context": [
      { "command": "switchyard.openInNewWindow", "when": "view == switchyard.workstreams && viewItem =~ /;reachable;notCurrent;/", "group": "inline@1" },
      { "command": "switchyard.switchHere", "when": "view == switchyard.workstreams && viewItem =~ /;reachable;notCurrent;/", "group": "inline@2" },
      { "command": "switchyard.remove", "when": "view == switchyard.workstreams && viewItem =~ /;linked;/", "group": "inline@3" },
      { "command": "switchyard.openInNewWindow", "when": "view == switchyard.workstreams && viewItem =~ /;reachable;notCurrent;/", "group": "1_open@1" },
      { "command": "switchyard.switchHere", "when": "view == switchyard.workstreams && viewItem =~ /;reachable;notCurrent;/", "group": "1_open@2" },
      { "command": "switchyard.compareWith", "when": "view == switchyard.workstreams && viewItem =~ /;reachable;/", "group": "2_compare@1" },
      { "command": "switchyard.openTerminal", "when": "view == switchyard.workstreams && viewItem =~ /;reachable;/", "group": "3_tools@1" },
      { "command": "switchyard.copyPath", "when": "view == switchyard.workstreams && viewItem =~ /;reachable;/", "group": "3_tools@2" },
      { "command": "switchyard.revealInOS", "when": "view == switchyard.workstreams && viewItem =~ /;reachable;/ && !remoteName", "group": "3_tools@3" },
      { "command": "switchyard.runSetupHere", "when": "view == switchyard.workstreams && viewItem =~ /;reachable;.*;linked;/", "group": "4_setup@1" },
      { "command": "switchyard.adopt", "when": "view == switchyard.workstreams && viewItem =~ /;reachable;.*;linked;notPortable;/", "group": "4_setup@2" },
      { "command": "switchyard.clearAgentStatus", "when": "view == switchyard.workstreams && viewItem =~ /;hasAgent;/", "group": "5_agent@1" },
      { "command": "switchyard.remove", "when": "view == switchyard.workstreams && viewItem =~ /;linked;/", "group": "9_remove@1" },
      { "command": "switchyard.compareToggleTwoDot", "when": "view == switchyard.workstreams && viewItem == compare", "group": "inline@1" },
      { "command": "switchyard.compareToggleUncommitted", "when": "view == switchyard.workstreams && viewItem == compare", "group": "inline@2" },
      { "command": "switchyard.compareDismiss", "when": "view == switchyard.workstreams && viewItem == compare", "group": "inline@3" },
      { "command": "switchyard.openFile", "when": "view == switchyard.workstreams && viewItem == file", "group": "inline@1" }
    ]
  },
  "configuration": {
    "title": "Switchyard",
    "properties": {
      "switchyard.openAfterCreate": {
        "type": "string",
        "enum": ["newWindow", "currentWindow", "none"],
        "enumDescriptions": ["Open the new worktree in a new window", "Switch this window to the new worktree", "Stay where you are"],
        "default": "newWindow",
        "description": "What to do after creating a workstream."
      },
      "switchyard.copyFiles": {
        "type": "array",
        "items": { "type": "string" },
        "default": [],
        "description": "Glob patterns (relative to the main worktree) of ignored files to copy into new worktrees, e.g. \".env\"."
      },
      "switchyard.setupCommand": {
        "type": "string",
        "default": "",
        "description": "Command to run in a terminal in a new worktree, e.g. \"npm ci\"."
      },
      "switchyard.autoAdopt": {
        "type": "boolean",
        "default": true,
        "description": "Automatically make worktrees inside the repository portable across host and container."
      },
      "switchyard.defaultBase": {
        "type": "string",
        "default": "",
        "description": "Base branch for progress and comparisons. Empty: origin/HEAD, then main, then master."
      },
      "switchyard.activeWindowMinutes": { "type": "number", "default": 5, "minimum": 1, "description": "A workstream with changes newer than this is 'active'." },
      "switchyard.staleAfterDays": { "type": "number", "default": 7, "minimum": 1, "description": "A workstream with no activity for this long is 'stale'." },
      "switchyard.agentStatusStaleMinutes": {
        "type": "number",
        "default": 10,
        "minimum": 1,
        "description": "A 'working' agent report older than this is shown as last reported."
      },
      "switchyard.notifyOnAttention": {
        "type": "boolean",
        "default": true,
        "description": "Notify when a workstream starts waiting for input or reports an error."
      },
      "switchyard.pollSeconds": {
        "type": "number",
        "default": 15,
        "minimum": 5,
        "description": "How often to refresh while the Workstreams view is visible."
      }
    }
  }
}
```

- [ ] **Step 3: Typecheck, test and build**

Run: `npm run typecheck && npm test && npm run build`
Expected: no type errors, all tests PASS, `dist/extension.js` built.

- [ ] **Step 4: Manual check on the host (F5)**

Open the project in VS Code on the host, press F5 ("Run Extension"), and in the Extension Development Host open any git repository (for example a fresh `git init` folder with one commit). Verify:
1. The Switchyard icon appears in the activity bar; the Workstreams view lists the main worktree marked "this window".
2. **New Workstream…** → *New branch…* → `test/one` → `HEAD` creates `.worktrees/test-one` and opens a new window on it. `git status` in the main repo stays clean.
3. In the main window, the new workstream shows; after editing a file in it, **Changes (1)** lists the file and clicking it opens a diff.
4. **Compare with…** → `main` shows a compare node; the two toggles and dismiss work.
5. Write `{"state":"waiting-for-input","message":"test","updatedAt":"<now ISO>"}` to `.git/worktrees/test-one/workstream.json`: within one refresh it jumps to the top with a bell icon and a notification appears.
6. **Remove Worktree…** → *Remove and Delete Branch* removes the folder and the branch.

Fix anything that fails before committing.

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts package.json
git commit -m "$(cat <<'EOF'
feat: wire up activation, refresh triggers, heartbeat and contributions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 20: VS Code smoke test

**Files:**
- Create: `.vscode-test.mjs`, `tsconfig.vscode-test.json`, `tests/vscode/prepareFixture.mjs`, `tests/vscode/extension.test.ts`

**Interfaces:**
- Consumes: the built extension (`dist/extension.js`), extension id `archipelagic.switchyard`, command ids (Task 18), `switchyard-git` scheme (Task 15).

- [ ] **Step 1: Create the config and fixture script**

`.vscode-test.mjs`:
```js
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/tests/vscode/**/*.test.js',
  workspaceFolder: './.vscode-test/fixture-repo',
  mocha: { timeout: 60_000 },
});
```

`tsconfig.vscode-test.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "module": "commonjs", "moduleResolution": "node", "outDir": "out", "rootDir": ".", "types": ["mocha", "node"] },
  "include": ["tests/vscode/**/*.ts"]
}
```

`tests/vscode/prepareFixture.mjs`:
```js
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
```

- [ ] **Step 2: Write the smoke test**

`tests/vscode/extension.test.ts`:
```ts
import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('Switchyard smoke test', () => {
  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension('archipelagic.switchyard');
    assert.ok(extension, 'extension not found');
    await extension.activate();
  });

  test('registers its commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['switchyard.newWorkstream', 'switchyard.refresh', 'switchyard.quickSwitch', 'switchyard.remove', 'switchyard.compareWith']) {
      assert.ok(commands.includes(id), `missing ${id}`);
    }
  });

  test('refresh runs without error', async () => {
    await vscode.commands.executeCommand('switchyard.refresh');
  });

  test('serves file content at a ref through the switchyard-git scheme', async () => {
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const uri = vscode.Uri.from({
      scheme: 'switchyard-git',
      path: '/README.md',
      query: JSON.stringify({ worktree: root, ref: 'HEAD', path: 'README.md' }),
    });
    const doc = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(doc.getText(), 'fixture\n');
  });
});
```

- [ ] **Step 3: Run the smoke test**

Run on the Windows host: `npm run test:vscode`
Run in the devcontainer: `xvfb-run -a npm run test:vscode`
Expected: 3 passing. (The first run downloads VS Code into `.vscode-test/`.)

- [ ] **Step 4: Commit**

```bash
git add .vscode-test.mjs tsconfig.vscode-test.json tests/vscode
git commit -m "$(cat <<'EOF'
test: add VS Code smoke test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 21: README, CI and old-git compatibility check, then cross-environment acceptance

**Files:**
- Create: `README.md`, `.github/workflows/ci.yml`, `test/docker/old-git.Dockerfile`, `.dockerignore`

**Interfaces:**
- Consumes: npm scripts from Task 1; the whole extension.

- [ ] **Step 1: Write the old-git Dockerfile and `.dockerignore`**

`test/docker/old-git.Dockerfile`:
```dockerfile
FROM node:22-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends make gcc libc6-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://mirrors.edge.kernel.org/pub/software/scm/git/git-2.17.0.tar.gz | tar xz -C /tmp \
 && make -C /tmp/git-2.17.0 -j"$(nproc)" prefix=/usr/local NO_GETTEXT=1 NO_TCLTK=1 NO_OPENSSL=1 NO_CURL=1 NO_EXPAT=1 NO_PERL=1 NO_PYTHON=1 install \
 && rm -rf /tmp/git-2.17.0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
CMD ["sh", "-c", "git --version && npx vitest run"]
```

`.dockerignore`:
```
node_modules
dist
out
.vscode-test
.git
```

- [ ] **Step 2: Run the unit tests against git 2.17**

Run: `docker build -f test/docker/old-git.Dockerfile -t switchyard-oldgit . && docker run --rm switchyard-oldgit`
Expected: prints `git version 2.17.0`, then all tests PASS. If a test fails only here, fix the implementation (not the test) so it works on both versions, then rerun `npm test` locally too.

- [ ] **Step 3: Write CI**

`.github/workflows/ci.yml`:
```yaml
name: CI
on:
  push:
  pull_request:

jobs:
  unit:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build

  old-git:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker build -f test/docker/old-git.Dockerfile -t switchyard-oldgit .
      - run: docker run --rm switchyard-oldgit

  vscode-smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: xvfb-run -a npm run test:vscode
```

- [ ] **Step 4: Write the README**

`README.md`:
````markdown
# Switchyard

Run parallel workstreams (typically AI agent sessions) in git worktrees, and see at a glance which one needs you. Works on Windows, Linux and macOS hosts **and** in devcontainers, including a host window and a container window open on the same repository at the same time.

Switchyard doesn't replace Copilot Chat, Claude Code or any other agent. It **observes** (status, activity, progress), **routes** (one click to the right window) and **prepares** (worktree, setup, window). You run your agent in that window as usual.

## Features

- **Workstreams view**: every worktree, sorted by what needs you: waiting for input → error → working → done → active → idle → stale.
- **New workstream**: from a new, local or remote branch; created at `.worktrees/<branch>`, set up, and opened in a new window.
- **Changes and Compare**: see any worktree's uncommitted changes, or compare its branch with a base, without opening it.
- **Status bar**: current workstream, a count of workstreams that need you, and quick switching.
- **Notifications** when a workstream starts waiting for input or reports an error.

## Host + devcontainer: how it works

Git normally links worktrees with absolute paths, which differ between host (`C:\Users\me\repo`) and container (`/workspaces/repo`). Switchyard keeps worktrees inside the repository (`.worktrees/`, ignored through `.git/info/exclude`), rewrites each worktree's `.git` file to a **relative** path, and **locks** the worktree so `git worktree prune` in the other environment never deletes it. It works with git 2.17+ and doesn't need git 2.48's `relativeWorktrees` extension.

Worktrees created with plain `git worktree add` inside the repository are adopted automatically (`switchyard.autoAdopt`). Worktrees outside the repository are listed but only reachable from the environment that can see them.

**Tip:** if your host converts line endings (`core.autocrlf=true` on Windows), add a `.gitattributes` with `* text=auto eol=lf`. Otherwise files can show as modified in one environment but not the other.

**Native dependencies:** `node_modules` (or similar) installed on a Windows host won't run inside a Linux container. Use **Run Setup Here** to re-run setup in the environment you're in.

## Agent status

Agents report status by writing `workstream.json` into their worktree's git directory (`git rev-parse --git-dir`):

```json
{ "state": "working | waiting-for-input | done | error", "message": "optional text", "updatedAt": "2026-10-09T10:00:00Z" }
```

For Claude Code, run **Switchyard: Copy Claude Code Hook Config** and merge the result into `.claude/settings.json`. Switchyard never edits agent configuration itself.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `switchyard.openAfterCreate` | `newWindow` | `newWindow` / `currentWindow` / `none` |
| `switchyard.copyFiles` | `[]` | Globs copied from the main worktree on create |
| `switchyard.setupCommand` | `""` | Run in a terminal in the new worktree |
| `switchyard.autoAdopt` | `true` | Make in-repo worktrees portable automatically |
| `switchyard.defaultBase` | `""` | Base branch for progress and compare |
| `switchyard.activeWindowMinutes` | `5` | Activity → active threshold |
| `switchyard.staleAfterDays` | `7` | Activity → stale threshold |
| `switchyard.agentStatusStaleMinutes` | `10` | When a `working` report is considered stale |
| `switchyard.notifyOnAttention` | `true` | Notify on waiting-for-input / error |
| `switchyard.pollSeconds` | `15` | Poll interval while the view is visible |

## Development

Open the folder in the devcontainer (or on the host with Node 22 and git), then:

```bash
npm ci
npm test               # unit + git integration tests (vitest)
npm run typecheck
npm run build
xvfb-run -a npm run test:vscode   # in the container; plain `npm run test:vscode` on a desktop
docker build -f test/docker/old-git.Dockerfile -t switchyard-oldgit . && docker run --rm switchyard-oldgit
```

Press F5 to launch an Extension Development Host.
````

- [ ] **Step 5: Commit**

```bash
git add README.md .github test/docker .dockerignore
git commit -m "$(cat <<'EOF'
docs, ci: add README, CI matrix and git 2.17 compatibility check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Cross-environment acceptance (manual, with the user)**

Package with `npx vsce package` and install the `.vsix` on the host and in a devcontainer of a test repository (Command Palette → *Extensions: Install from VSIX…*; in the container window choose "Install in Dev Container"). With a host window and a container window both open on the same repository:
1. Create a workstream in the **host** window → it appears in the **container** window's view (within ~15 s, or on focus) and opening it from the container works; `git status` and `git log` work in a container terminal inside that worktree.
2. Create a workstream in the **container** window → same checks from the host.
3. Run `git worktree prune` in each environment → no Switchyard worktree disappears.
4. Write a `waiting-for-input` status file from one environment → the other window's view and status bar show it and a notification appears.
5. Remove a workstream that was created on the host **from the container** → the folder and the git entry are gone in both environments.
6. Create a worktree with plain `git worktree add .worktrees/manual -b manual` in a host terminal → it shows in both windows and works in the container after the next refresh (auto-adopted).

Record any failures as follow-up tasks; don't claim completion until all six pass.

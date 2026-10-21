// Packages the extension (.vsix) from a copy of what it ships, outside the repository (BL-151). Run in the
// repository, `vsce package` walks every agent worktree under .worktrees/ (most with their own node_modules) before
// it applies .vscodeignore, and doesn't finish. The copy holds only what .vscodeignore keeps, so dependencies aren't
// looked up either (--no-dependencies): the bundles in dist/ have them built in.
//
//   npm run package [-- --out <file.vsix>]
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** What's copied: what .vscodeignore lets into the package, and the ignore file itself. */
export const SHIPPED = ['package.json', '.vscodeignore', 'README.md', 'CHANGELOG.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'dist', 'media'];

/** The manifest packaged: without the prepublish step, which builds (it's run before copying, where the tools are). */
export function stagedManifest(manifest) {
  const scripts = { ...(manifest.scripts ?? {}) };
  delete scripts['vscode:prepublish'];
  return { ...manifest, scripts };
}

/** The .vsix to write: --out's (relative to cwd), or <name>-<version>.vsix in the repository. */
export function outFile(argv, root, manifest, cwd = process.cwd()) {
  const i = argv.indexOf('--out');
  const out = i >= 0 ? argv[i + 1] : undefined;
  return out ? path.resolve(cwd, out) : path.join(root, `${manifest.name}-${manifest.version}.vsix`);
}

function main() {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const out = outFile(process.argv.slice(2), root, manifest);
  execFileSync(process.execPath, [path.join(root, 'esbuild.mjs')], { cwd: root, stdio: 'inherit' });
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'flotilla-package-'));
  try {
    for (const name of SHIPPED) {
      const from = path.join(root, name);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(stage, name), { recursive: true });
    }
    fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(stagedManifest(manifest), null, 2)}\n`);
    const vsce = createRequire(import.meta.url).resolve('@vscode/vsce/vsce');
    execFileSync(process.execPath, [vsce, 'package', '--no-dependencies', '--out', out], { cwd: stage, stdio: 'inherit' });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

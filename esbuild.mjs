import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as esbuild from 'esbuild';
import { seedKitOptions } from './scripts/seed-kit.mjs';

const watch = process.argv.includes('--watch');

// Extension host bundle (Node).
const host = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/extension.js',
  external: ['vscode', 'original-fs'],
  sourcemap: true,
  banner: { js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__importMetaUrl' },
  logLevel: 'info',
});

// Webview bundles (browser): the sidebar (dist/webview.js, .css), ticket tabs (dist/ticket.js, .css), the New Note tab (dist/note.js, .css) and the Metrics tab (dist/metrics.js, .css).
const webview = await esbuild.context({
  entryPoints: {
    webview: 'src/webview/ui/main.tsx',
    ticket: 'src/webview/ticket/main.tsx',
    note: 'src/webview/note/main.tsx',
    metrics: 'src/webview/metrics/main.tsx',
  },
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  outdir: 'dist',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  sourcemap: true,
  logLevel: 'info',
});

// Mermaid, minified: it's most of the extension's size even so (about 3 MB), and only tickets with a diagram load it.
const mermaid = await esbuild.context({
  entryPoints: { mermaid: 'src/webview/ticket/mermaid.ts' },
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  outdir: 'dist',
  minify: true,
  legalComments: 'eof',
  logLevel: 'info',
});

// The app's code the playground's seed uses (scripts/playground-seed.mjs), not part of the extension.
const seedKit = await esbuild.context({ ...seedKitOptions, logLevel: 'info' });

// The commit this build is from (BL-151): the status bar's hover and "Flotilla: About" show it, and in Flotilla's own
// repository it's how the window counts what main has merged since.
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/build.json', `${JSON.stringify(buildStamp())}\n`);

// Codicons for the webview (font + stylesheet), served from dist/ like the rest.
fs.mkdirSync('dist/codicons', { recursive: true });
for (const file of ['codicon.css', 'codicon.ttf']) fs.copyFileSync(`node_modules/@vscode/codicons/dist/${file}`, `dist/codicons/${file}`);

if (watch) {
  await Promise.all([host.watch(), webview.watch(), mermaid.watch(), seedKit.watch()]);
} else {
  await Promise.all([host.rebuild(), webview.rebuild(), mermaid.rebuild(), seedKit.rebuild()]);
  await Promise.all([host.dispose(), webview.dispose(), mermaid.dispose(), seedKit.dispose()]);
}

function buildStamp() {
  const git = (...args) => {
    try {
      return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  const commit = git('rev-parse', 'HEAD');
  return {
    commit: commit || undefined,
    dirty: commit ? git('status', '--porcelain', '--untracked-files=no') !== '' : undefined,
    builtAt: new Date().toISOString(),
  };
}

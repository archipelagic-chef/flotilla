import * as fs from 'node:fs';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

// Extension host bundle (Node).
const host = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: true,
  banner: { js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__importMetaUrl' },
  logLevel: 'info',
});

// Sidebar webview bundle (browser): dist/webview.js and dist/webview.css.
const webview = await esbuild.context({
  entryPoints: ['src/webview/ui/main.tsx'],
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  outfile: 'dist/webview.js',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  sourcemap: true,
  logLevel: 'info',
});

// Codicons for the webview (font + stylesheet), served from dist/ like the rest.
fs.mkdirSync('dist/codicons', { recursive: true });
for (const file of ['codicon.css', 'codicon.ttf']) fs.copyFileSync(`node_modules/@vscode/codicons/dist/${file}`, `dist/codicons/${file}`);

if (watch) {
  await Promise.all([host.watch(), webview.watch()]);
} else {
  await Promise.all([host.rebuild(), webview.rebuild()]);
  await Promise.all([host.dispose(), webview.dispose()]);
}

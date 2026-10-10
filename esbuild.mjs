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

// Webview bundles (browser): the sidebar (dist/webview.js, .css) and ticket tabs (dist/ticket.js, .css).
const webview = await esbuild.context({
  entryPoints: { webview: 'src/webview/ui/main.tsx', ticket: 'src/webview/ticket/main.tsx' },
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

// Codicons for the webview (font + stylesheet), served from dist/ like the rest.
fs.mkdirSync('dist/codicons', { recursive: true });
for (const file of ['codicon.css', 'codicon.ttf']) fs.copyFileSync(`node_modules/@vscode/codicons/dist/${file}`, `dist/codicons/${file}`);

if (watch) {
  await Promise.all([host.watch(), webview.watch()]);
} else {
  await Promise.all([host.rebuild(), webview.rebuild()]);
  await Promise.all([host.dispose(), webview.dispose()]);
}

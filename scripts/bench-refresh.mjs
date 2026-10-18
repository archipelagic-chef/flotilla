// Benchmark for refreshes with many worktrees (BL-10). Builds a repository with N linked worktrees × M files in a
// temporary folder, then times the refresh the sidebar runs: buildWorkstreams, bundled from the real source.
//
//   npm run bench -- [--worktrees 20] [--files 20000] [--changed 0] [--transcript-mb 0] [--refreshes 3]
//
// --changed: modified files per linked worktree. --transcript-mb: a fake chat transcript of that size in the first
// linked worktree; a line is appended before each refresh after the first, as a running chat does.
// Everything is removed afterwards, also on Ctrl+C. scripts/ is not in the vsix (.vscodeignore).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import * as esbuild from 'esbuild';

const FLAGS = { worktrees: 'worktrees', files: 'files', changed: 'changed', 'transcript-mb': 'transcriptMb', refreshes: 'refreshes' };
const DEFAULTS = { worktrees: 20, files: 20000, changed: 0, transcriptMb: 0, refreshes: 3 };
const SETTINGS = { activeWindowMinutes: 5, staleAfterDays: 7, agentStatusStaleMinutes: 10, defaultBase: '' };
const LOREM =
  'Refreshing the workstreams reads every worktree status, the activity of changed files, and the chat transcripts. ';

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m || !(m[1] in FLAGS)) throw new Error(`Unknown option ${argv[i]}. Options: ${Object.keys(FLAGS).map((f) => `--${f}`).join(', ')}`);
    const value = m[2] ?? argv[++i];
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw new Error(`--${m[1]} needs a whole number, not "${value}"`);
    opts[FLAGS[m[1]]] = n;
  }
  if (opts.refreshes < 1 || opts.worktrees < 1 || opts.files < 1) throw new Error('--refreshes, --worktrees and --files must be at least 1');
  if (opts.changed > opts.files) throw new Error('--changed cannot be more than --files');
  return opts;
}

const git = (cwd, ...args) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Flotilla benchmark', '-c', 'user.email=benchmark@flotilla.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  ).trim();

/** A repository with `files` committed files, then `worktrees` linked worktrees with real checkouts. */
function buildFixture(main, opts) {
  fs.mkdirSync(main, { recursive: true });
  git(main, 'init', '-q');
  git(main, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  // As Flotilla does: its worktrees stay out of the main worktree's status.
  fs.appendFileSync(path.join(main, '.git', 'info', 'exclude'), '/.worktrees/\n');
  const files = [];
  for (let i = 0; i < opts.files; i++) {
    const rel = path.join(`pkg${i % 100}`, `module${Math.floor(i / 100)}`, `file${i}.txt`);
    fs.mkdirSync(path.dirname(path.join(main, rel)), { recursive: true });
    fs.writeFileSync(path.join(main, rel), `file ${i}\n`);
    files.push(rel);
  }
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'Benchmark fixture');

  const linked = [];
  for (let i = 1; i <= opts.worktrees; i++) {
    const name = `wt-${String(i).padStart(2, '0')}`;
    const dir = path.join(main, '.worktrees', name);
    git(main, 'worktree', 'add', '-q', '-b', name, dir, 'main');
    for (const rel of files.slice(0, opts.changed)) fs.appendFileSync(path.join(dir, rel), `changed in ${name}\n`);
    linked.push(dir);
  }
  return linked;
}

const transcriptLine = (n) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(Date.UTC(2026, 9, 11) + n * 1000).toISOString(),
    isSidechain: false,
    message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: LOREM.repeat(12) + n }] },
  }) + '\n';

/** A session transcript of about `bytes`, with a title and a first prompt, as Claude Code writes them. */
function writeTranscript(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text = JSON.stringify({ type: 'user', timestamp: '2026-10-11T08:00:00.000Z', message: { content: 'Benchmark the refresh' } }) + '\n';
  text += JSON.stringify({ type: 'ai-title', aiTitle: 'Benchmark chat' }) + '\n';
  for (let n = 0; Buffer.byteLength(text) < bytes; n++) text += transcriptLine(n);
  fs.writeFileSync(file, text);
}

function bundleSource(dir) {
  const src = path.resolve(import.meta.dirname, '..', 'src');
  const entry = path.join(dir, 'entry.ts');
  fs.writeFileSync(
    entry,
    [
      `export { buildWorkstreams } from ${JSON.stringify(path.join(src, 'features/workstreams/workstream'))};`,
      `export { WorktreeService } from ${JSON.stringify(path.join(src, 'features/worktrees/worktreeService'))};`,
      `export { transcriptPath } from ${JSON.stringify(path.join(src, 'features/chats/chats'))};`,
    ].join('\n'),
  );
  const out = path.join(dir, 'flotilla.cjs');
  esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: out, logLevel: 'warning' });
  return createRequire(import.meta.url)(out);
}

/** Counts the git processes Flotilla runs at once (it spawns git only through child_process.execFile). */
function countGitProcesses(counter) {
  const cp = createRequire(import.meta.url)('node:child_process');
  const original = cp.execFile;
  cp.execFile = function (file, ...rest) {
    const callback = rest[rest.length - 1];
    if (file !== 'git' || typeof callback !== 'function') return original.call(this, file, ...rest);
    counter.running++;
    counter.peak = Math.max(counter.peak, counter.running);
    rest[rest.length - 1] = (...args) => {
      counter.running--;
      callback(...args);
    };
    return original.call(this, file, ...rest);
  };
  return () => {
    cp.execFile = original;
  };
}

const fmt = (n, digits = 0) => n.toFixed(digits).padStart(8);
const mb = (bytes) => bytes / (1024 * 1024);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'flotilla-bench-')));
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flotilla-bench-bundle-'));
  const counter = { running: 0, peak: 0 };
  let restoreExecFile = () => undefined;
  let sampler;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(sampler);
    restoreExecFile();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    fs.rmSync(bundleDir, { recursive: true, force: true });
  };
  process.once('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  try {
    const { buildWorkstreams, WorktreeService, transcriptPath } = bundleSource(bundleDir);
    restoreExecFile = countGitProcesses(counter);
    const mainRoot = path.join(root, 'repo');
    const home = path.join(root, 'claude-home');

    const setupStart = performance.now();
    const linked = buildFixture(mainRoot, opts);
    const worktreeCount = linked.length + 1;
    let transcript;
    if (opts.transcriptMb > 0) {
      transcript = transcriptPath(linked[0], randomUUID(), home);
      writeTranscript(transcript, opts.transcriptMb * 1024 * 1024);
    }
    const setupMs = performance.now() - setupStart;

    const service = new WorktreeService({ mainRoot, commonDir: path.join(mainRoot, '.git') }, () => ({ autoAdopt: true }));
    const loop = monitorEventLoopDelay({ resolution: 5 });
    loop.enable();
    const peaks = { rss: 0, heap: 0 };
    const sample = () => {
      const m = process.memoryUsage();
      peaks.rss = Math.max(peaks.rss, m.rss);
      peaks.heap = Math.max(peaks.heap, m.heapUsed);
    };
    sampler = setInterval(sample, 10);

    console.log(`Flotilla refresh benchmark: ${worktreeCount} worktrees (main + ${linked.length} linked) × ${opts.files} files`);
    console.log(`  ${opts.changed} changed files per linked worktree, transcript ${opts.transcriptMb} MB`);
    console.log(`  node ${process.version}, ${os.cpus()[0]?.model ?? 'unknown CPU'} (${os.cpus().length} cores), ${os.platform()} ${os.release()}`);
    console.log(`  setup ${(setupMs / 1000).toFixed(1)} s (fixture in ${root})`);
    console.log('');
    console.log('refresh      time    blocked   git max    rss max   heap max  workstreams  changed  chats');
    console.log('            (ms)       (ms)    at once      (MB)      (MB)');

    for (let r = 1; r <= opts.refreshes; r++) {
      if (transcript && r > 1) fs.appendFileSync(transcript, transcriptLine(100000 + r));
      counter.peak = 0;
      peaks.rss = 0;
      peaks.heap = 0;
      loop.reset();
      sample();
      const t0 = performance.now();
      const items = await buildWorkstreams(service, {
        currentWorktreeRoot: mainRoot,
        settings: SETTINGS,
        now: new Date(),
        claudeHome: home,
      });
      const ms = performance.now() - t0;
      sample();
      if (items.length !== worktreeCount) throw new Error(`Expected ${worktreeCount} workstreams, got ${items.length}`);
      const blocked = loop.max / 1e6;
      const changed = items.reduce((n, ws) => n + ws.changes.length, 0);
      const chats = items.reduce((n, ws) => n + ws.chats.length, 0);
      const label = r === 1 ? 'cold' : String(r);
      console.log(
        `${label.padEnd(8)}${fmt(ms)}${fmt(blocked, 1).padStart(11)}${String(counter.peak).padStart(10)}${fmt(mb(peaks.rss))}${fmt(mb(peaks.heap))}${String(items.length).padStart(13)}${String(changed).padStart(9)}${String(chats).padStart(7)}`,
      );
    }
    loop.disable();
  } finally {
    cleanup();
    console.log('');
    console.log('Removed the fixture and the temporary files.');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

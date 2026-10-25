// Benchmark for refreshes with many worktrees (BL-10). Builds a repository with N linked worktrees × M files in a
// temporary folder, then times the refresh the sidebar runs: buildWorkstreams, bundled from the real source.
//
//   npm run bench -- [--worktrees 20] [--files 20000] [--changed 0] [--transcript-mb 0] [--refreshes 3] [--git-on-main-thread 0]
//                    [--half-removed 0] [--node-modules 2000]
//
// --changed: modified files per linked worktree. --transcript-mb: a fake chat transcript of that size in the first
// linked worktree; a line is appended before each refresh after the first, as a running chat does.
// --git-on-main-thread 1: start git on the main thread, as before BL-165, to compare what spawning blocks.
// --half-removed: linked worktrees left as a `git worktree remove` stopped halfway leaves them (BL-176): .gitignore and
// the first 40% of the files deleted, a node_modules of --node-modules files kept. After the refreshes, the
// finished-worktree sweep's steps finish those removals (removalRisks, remove), and one more refresh is timed.
// Everything is removed afterwards, also on Ctrl+C. scripts/ is not in the vsix (.vscodeignore).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import * as esbuild from 'esbuild';

const FLAGS = {
  worktrees: 'worktrees',
  files: 'files',
  changed: 'changed',
  'transcript-mb': 'transcriptMb',
  refreshes: 'refreshes',
  'git-on-main-thread': 'gitOnMainThread',
  'half-removed': 'halfRemoved',
  'node-modules': 'nodeModules',
};
const DEFAULTS = { worktrees: 20, files: 20000, changed: 0, transcriptMb: 0, refreshes: 3, gitOnMainThread: 0, halfRemoved: 0, nodeModules: 2000 };
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
  if (opts.halfRemoved > opts.worktrees) throw new Error('--half-removed cannot be more than --worktrees');
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
  fs.writeFileSync(path.join(main, '.gitignore'), 'node_modules/\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'Benchmark fixture');

  const linked = [];
  for (let i = 1; i <= opts.worktrees; i++) {
    const name = `wt-${String(i).padStart(2, '0')}`;
    const dir = path.join(main, '.worktrees', name);
    git(main, 'worktree', 'add', '-q', '-b', name, dir, 'main');
    for (const rel of files.slice(0, opts.changed)) fs.appendFileSync(path.join(dir, rel), `changed in ${name}\n`);
    if (i <= opts.halfRemoved) {
      for (let n = 0; n < opts.nodeModules; n++) {
        const rel = path.join('node_modules', `pkg${n % 50}`, `file${n}.js`);
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), '');
      }
      fs.rmSync(path.join(dir, '.gitignore'));
      for (const rel of [...files].sort().slice(0, Math.floor(files.length * 0.4))) fs.rmSync(path.join(dir, rel));
    }
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
  // Written in chunks, so the benchmark's own memory doesn't hide what the refresh holds of the transcript.
  const fd = fs.openSync(file, 'w');
  let written = 0;
  const write = (text) => (written += fs.writeSync(fd, text));
  write(JSON.stringify({ type: 'user', timestamp: '2026-10-11T08:00:00.000Z', message: { content: 'Benchmark the refresh' } }) + '\n');
  write(JSON.stringify({ type: 'ai-title', aiTitle: 'Benchmark chat' }) + '\n');
  for (let n = 0; written < bytes; ) {
    let chunk = '';
    for (let end = n + 1000; n < end; n++) chunk += transcriptLine(n);
    write(chunk);
  }
  fs.closeSync(fd);
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
      `export { gitProcesses } from ${JSON.stringify(path.join(src, 'core/git/gitCli'))};`,
      `export { setSpawnOnMainThread } from ${JSON.stringify(path.join(src, 'core/git/gitSpawner'))};`,
    ].join('\n'),
  );
  const out = path.join(dir, 'flotilla.cjs');
  esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: out, logLevel: 'warning' });
  return createRequire(import.meta.url)(out);
}

const fmt = (n, digits = 0) => n.toFixed(digits).padStart(8);
const mb = (bytes) => bytes / (1024 * 1024);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'flotilla-bench-')));
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flotilla-bench-bundle-'));
  let sampler;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(sampler);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    fs.rmSync(bundleDir, { recursive: true, force: true });
  };
  process.once('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  try {
    const { buildWorkstreams, WorktreeService, transcriptPath, gitProcesses, setSpawnOnMainThread } = bundleSource(bundleDir);
    setSpawnOnMainThread(opts.gitOnMainThread === 1);
    const mainRoot = path.join(root, 'repo');
    const home = path.join(root, 'claude-home');

    const setupStart = performance.now();
    const linked = buildFixture(mainRoot, opts);
    let worktreeCount = linked.length + 1;
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
    if (opts.halfRemoved) console.log(`  ${opts.halfRemoved} of them half-removed, each with a node_modules of ${opts.nodeModules} files`);
    console.log(`  ${opts.changed} changed files per linked worktree, transcript ${opts.transcriptMb} MB, git started on the ${opts.gitOnMainThread ? 'main' : 'worker'} thread`);
    console.log(`  node ${process.version}, ${os.cpus()[0]?.model ?? 'unknown CPU'} (${os.cpus().length} cores), ${os.platform()} ${os.release()}`);
    console.log(`  setup ${(setupMs / 1000).toFixed(1)} s (fixture in ${root})`);
    console.log('');
    console.log('refresh      time    blocked   git max    rss max   heap max  workstreams  changed  chats');
    console.log('            (ms)       (ms)    at once      (MB)      (MB)');

    const refresh = async (label) => {
      gitProcesses.peak = 0;
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
      console.log(
        `${label.padEnd(8)}${fmt(ms)}${fmt(blocked, 1).padStart(11)}${String(gitProcesses.peak).padStart(10)}${fmt(mb(peaks.rss))}${fmt(mb(peaks.heap))}${String(items.length).padStart(13)}${String(changed).padStart(9)}${String(chats).padStart(7)}`,
      );
    };
    for (let r = 1; r <= opts.refreshes; r++) {
      if (transcript && r > 1) fs.appendFileSync(transcript, transcriptLine(100000 + r));
      await refresh(r === 1 ? 'cold' : String(r));
    }
    if (opts.halfRemoved) {
      const t0 = performance.now();
      let finished = 0;
      for (const wt of await service.list()) {
        if (wt.isMain || !(await service.removalRisks(wt)).halfRemoved) continue;
        await service.remove(wt, { force: true });
        finished++;
      }
      console.log(`finished ${finished} half-removed worktrees in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      worktreeCount -= finished;
      await refresh('after');
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

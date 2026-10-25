// `npm test`: vitest, sharing the machine with the other test runs of the repository's worktrees (agents', merges').
// A full run takes one of N slots, shared through files in the main repository's .git/flotilla-slots/ (not
// .git/flotilla/, which the extension watches), and runs with its share of the cores: vitest starts as many workers
// as there are cores, so three runs at once each at full width overload the machine and time out.
//
// N is `flotilla.checks.maxParallel` (the extension writes it to .git/flotilla/checks.json; FLOTILLA_CHECKS_MAX_PARALLEL
// overrides it), by default 1 per 16 cores. A merge's runs (its checks, and its fix agent's) go first: they run in a
// temporary worktree in a `flotilla-merge` folder, and someone is waiting on them. Runs given files
// (`npm test -- tests/unit/x.test.ts`) don't queue: they're light, and that's how agents work between full runs.
//
// `npm run test:related` (`--related`) runs the tests of what changed since the merge base with main (committed, not
// committed, and new files): vitest's `related` mode on those files, which doesn't queue either. A change that every
// test may depend on (a shared helper, the vitest config, the packages, a tsconfig) runs the full suite instead.
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordEvent, ticketOfBranch } from './record-event.mjs';

/** Entries of other hosts (a container sharing the repository) can't be checked: they're dropped after this long. */
const FOREIGN_MAX_AGE_MS = 2 * 60 * 60_000;
const POLL_MS = 1000;
/** vitest options that take a value as the next argument (not a file filter). */
const VALUE_OPTIONS = new Set([
  '-t',
  '--testNamePattern',
  '-c',
  '--config',
  '-r',
  '--root',
  '--dir',
  '--project',
  '--reporter',
  '--outputFile',
  '--pool',
  '--shard',
  '--bail',
  '--retry',
  '--maxWorkers',
  '--environment',
  '--exclude',
  '--mode',
  '--testTimeout',
]);

/** Changes that every test may depend on: a related run of them is the full suite. */
const SHARED = [/^tests\/helpers\//, /^vitest\.config\./, /^package(-lock)?\.json$/, /^tsconfig[^/]*\.json$/];
/** Files vitest can follow imports from (others, as Markdown, change no test). */
const CODE = /\.(?:[cm]?[jt]sx?|json)$/;

/**
 * What a related run runs, given the files changed since main (paths from the repository's root): the full suite
 * when a shared file changed (reason: which), else the changed code files (none: nothing to run).
 */
export function relatedPlan(changed) {
  const shared = changed.find((f) => SHARED.some((r) => r.test(f)));
  if (shared) return { full: true, reason: shared, files: [] };
  return { full: false, files: changed.filter((f) => CODE.test(f)) };
}

/** How many runs go at once: the configured number, or 1 per 16 cores (git-heavy tests time out with two 8-worker runs on 16 cores); at least 1. */
export function slotCount(cores, configured) {
  const n = Number(configured);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : Math.max(1, Math.floor(cores / 16));
}

/** A run's share of the cores, when n runs go at once. */
export function workersFor(cores, n) {
  return Math.max(1, Math.floor(cores / n));
}

/** Whether vitest's arguments name files to run (not the whole suite). */
export function namesFiles(args) {
  return args.some((a, i) => !a.startsWith('-') && !(i > 0 && VALUE_OPTIONS.has(args[i - 1])));
}

/**
 * What a run is called in the queue, and whether it goes first: a merge's worktree (in a `flotilla-merge` folder)
 * goes first, as "BL-12 merge"; an agent's is its branch's ticket id.
 */
export function describeRun(toplevel, branch) {
  const dir = path.basename(toplevel);
  if (path.basename(path.dirname(toplevel)) === 'flotilla-merge') {
    const id = /([A-Z][A-Z0-9]*-\d+)-[0-9a-f]+$/.exec(dir)?.[1];
    return { label: id ? `${id} merge` : 'a merge', first: true };
  }
  const id = /(?:^|[/_-])([A-Z][A-Z0-9]*-\d+)(?=$|[/_-])/.exec(branch ?? '')?.[1];
  return { label: id ?? (branch && branch !== 'HEAD' ? branch : dir), first: false };
}

/** The queue's order: merges first, then by arrival. */
export function queueOrder(a, b) {
  return Number(b.first) - Number(a.first) || a.since - b.since || a.pid - b.pid;
}

/**
 * Whether me may start, given the live entries (me among them) and n slots: the runs going and the ones waiting
 * ahead of it leave a slot. ahead: the runs it waits for.
 */
export function mayStart(entries, me, n) {
  const others = entries.filter((e) => !(e.pid === me.pid && e.host === me.host));
  const ahead = others.filter((e) => e.running || queueOrder(e, me) < 0);
  return { go: ahead.length < n, ahead: ahead.sort(queueOrder) };
}

/** "Waiting for 2 other test runs (BL-120, BL-129)…" */
export function waitingLine(ahead) {
  const runs = ahead.length === 1 ? '1 other test run' : `${ahead.length} other test runs`;
  return `Waiting for ${runs} (${ahead.map((e) => e.label).join(', ')})…`;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** The queue's live entries; those of processes that died are removed. */
export function readQueue(dir, now = Date.now(), alive = isAlive, host = os.hostname()) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let e;
    try {
      e = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue; // Being written, or just removed.
    }
    const live = e.host === host ? alive(e.pid) : now - e.since < FOREIGN_MAX_AGE_MS;
    if (live) entries.push(e);
    else fs.rmSync(file, { force: true });
  }
  return entries;
}

function writeEntry(file, entry) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry));
  fs.renameSync(tmp, file);
}

/**
 * Queues in dir and waits for one of n slots; calls onWait with the runs ahead whenever they change. Returns a
 * function that frees the slot (also freed when the process exits).
 */
export async function takeSlot({ dir, n, label, first, onWait = () => undefined, pollMs = POLL_MS }) {
  fs.mkdirSync(dir, { recursive: true });
  const me = { pid: process.pid, host: os.hostname(), label, first, since: Date.now(), running: false };
  const file = path.join(dir, `${me.host}-${me.pid}.json`);
  const release = () => fs.rmSync(file, { force: true });
  process.on('exit', release);
  writeEntry(file, me);
  let shown = '';
  for (;;) {
    const { go, ahead } = mayStart(readQueue(dir), me, n);
    if (go) break;
    const line = waitingLine(ahead);
    if (line !== shown) onWait(ahead, line);
    shown = line;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  writeEntry(file, { ...me, running: true });
  return release;
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split('\n');
  } catch {
    return undefined;
  }
}

function configured(commonDir) {
  if (process.env.FLOTILLA_CHECKS_MAX_PARALLEL) return process.env.FLOTILLA_CHECKS_MAX_PARALLEL;
  try {
    return JSON.parse(fs.readFileSync(path.join(commonDir, 'flotilla', 'checks.json'), 'utf8')).maxParallel;
  } catch {
    return undefined;
  }
}

/** The files changed since the merge base with main (or origin/main), committed or not, that still exist. */
function changedSinceMain(toplevel) {
  const base = git(['merge-base', 'HEAD', 'main'], toplevel) ?? git(['merge-base', 'HEAD', 'origin/main'], toplevel);
  if (!base) return undefined;
  const files = [...(git(['diff', '--name-only', base[0]], toplevel) ?? []), ...(git(['ls-files', '--others', '--exclude-standard'], toplevel) ?? [])];
  return [...new Set(files)].filter((f) => f && fs.existsSync(path.join(toplevel, f)));
}

async function main(argv) {
  let args = argv.filter((a) => a !== '--related');
  let mode = 'run';
  const cores = os.availableParallelism?.() ?? os.cpus().length;
  const cwd = process.cwd();
  const [toplevel, commonDir, branch] = git(['rev-parse', '--show-toplevel', '--git-common-dir', '--abbrev-ref', 'HEAD'], cwd) ?? [];
  const n = slotCount(cores, commonDir && configured(path.resolve(cwd, commonDir)));
  // Stopped while waiting: leave the queue ('exit' frees the slot). Once vitest runs, it's stopped too.
  let child;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => (child ? child.kill(signal) : process.exit(130)));
  if (args.length < argv.length) {
    const changed = toplevel && changedSinceMain(toplevel);
    if (!changed) console.log('No main branch to compare with: running the full suite.');
    else {
      const plan = relatedPlan(changed);
      if (plan.full) console.log(`${plan.reason} changed: running the full suite.`);
      else if (!plan.files.length) {
        console.log('No code changed since main: no tests to run.');
        process.exit(0);
      } else {
        console.log(`Running the tests related to ${plan.files.length} changed file(s).`);
        mode = 'related';
        args = [...plan.files.map((f) => path.join(toplevel, f)), ...args];
      }
    }
  }
  const queued = Date.now();
  const full = mode === 'run' && !namesFiles(args);
  if (commonDir && full) {
    const { label, first } = describeRun(toplevel, branch);
    await takeSlot({ dir: path.join(path.resolve(cwd, commonDir), 'flotilla-slots'), n, label, first, onWait: (_, line) => console.log(line) });
  }
  const started = Date.now();
  const workers = args.some((a) => a.startsWith('--maxWorkers')) ? [] : [`--maxWorkers=${workersFor(cores, n)}`];
  const vitest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'vitest', 'vitest.mjs');
  child = spawn(process.execPath, [vitest, mode, ...(mode === 'related' ? ['--run'] : []), ...workers, ...args], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    // A full run's time and its wait for a slot, for the metrics (BL-157, BL-138).
    if (full && commonDir) {
      const data = { ms: Date.now() - started, waitMs: started - queued, full, ok: code === 0, slots: n };
      recordEvent(path.resolve(cwd, commonDir), 'test-run', { ticket: ticketOfBranch(branch), data });
    }
    process.exit(code ?? (signal ? 1 : 0));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}

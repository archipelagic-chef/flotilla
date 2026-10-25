// Benchmark for ticket views (BL-50, after BL-10's refresh benchmark). Builds a repository with linked worktrees and a
// busy ticket (many activity entries, many commits that mention it) in a temporary folder, then times what the tab
// does: opening the ticket (its whole view), and an action's effect (a status, a comment): when the tab gets the part
// that shows it. The code is the real TicketPanels, bundled from the source; only the VS Code API is stubbed.
//
//   npm run bench:ticket -- [--worktrees 5] [--files 2000] [--entries 300] [--commits 300] [--runs 5]
//
// Markdown is not rendered (VS Code's renderer isn't here): entries show as plain text, so the numbers leave that out.
// Everything is removed afterwards, also on Ctrl+C. scripts/ is not in the vsix (.vscodeignore).
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as esbuild from 'esbuild';

const FLAGS = { worktrees: 'worktrees', files: 'files', entries: 'entries', commits: 'commits', runs: 'runs' };
const DEFAULTS = { worktrees: 5, files: 2000, entries: 300, commits: 300, runs: 5 };
const SETTINGS = { activeWindowMinutes: 5, staleAfterDays: 7, agentStatusStaleMinutes: 10, defaultBase: '' };
const BUDGET_MS = 300;
const ID = 'BL-1';

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m || !(m[1] in FLAGS))
      throw new Error(
        `Unknown option ${argv[i]}. Options: ${Object.keys(FLAGS)
          .map((f) => `--${f}`)
          .join(', ')}`,
      );
    const value = m[2] ?? argv[++i];
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw new Error(`--${m[1]} needs a whole number, not "${value}"`);
    opts[FLAGS[m[1]]] = n;
  }
  if (opts.runs < 1 || opts.worktrees < 1 || opts.files < 1) throw new Error('--runs, --worktrees and --files must be at least 1');
  return opts;
}

const git = (cwd, ...args) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Flotilla benchmark', '-c', 'user.email=benchmark@flotilla.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  ).trim();

/** A repository with `files` committed files, `commits` commits mentioning the ticket, and linked worktrees for it. */
function buildFixture(main, opts) {
  fs.mkdirSync(main, { recursive: true });
  git(main, 'init', '-q');
  git(main, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  fs.appendFileSync(path.join(main, '.git', 'info', 'exclude'), '/.worktrees/\n/.flotilla/\n');
  for (let i = 0; i < opts.files; i++) {
    const rel = path.join(`pkg${i % 100}`, `module${Math.floor(i / 100)}`, `file${i}.txt`);
    fs.mkdirSync(path.dirname(path.join(main, rel)), { recursive: true });
    fs.writeFileSync(path.join(main, rel), `file ${i}\n`);
  }
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'Benchmark fixture');
  // The ticket's commits: one fast-import stream, a history of its own (a branch that isn't the ticket's).
  const stream = [];
  for (let i = 1; i <= opts.commits; i++) {
    stream.push(
      `commit refs/heads/ticket-history`,
      `mark :${i}`,
      `committer Benchmark <b@flotilla.invalid> ${1760000000 + i} +0000`,
      `data ${`${ID}: step ${i} of the busy ticket\n`.length}`,
      `${ID}: step ${i} of the busy ticket`,
      ``,
    );
    if (i > 1) stream.push(`from :${i - 1}`);
    stream.push('');
  }
  if (opts.commits) {
    execFileSync('git', ['-C', main, 'fast-import', '--quiet'], { input: `${stream.join('\n')}\n`, stdio: ['pipe', 'ignore', 'pipe'] });
  }
  const linked = [];
  for (let i = 1; i <= opts.worktrees; i++) {
    const name = `${ID}-part-${i}`;
    const dir = path.join(main, '.worktrees', name);
    git(main, 'worktree', 'add', '-q', '-b', name, dir, 'main');
    linked.push(dir);
  }
  return linked;
}

/** The ticket's entries: comments, and agents' reports (signed, as the agents write them). */
function entries(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const agent = i % 3 === 0;
    const author = agent ? 'Nova-7' : i % 5 === 0 ? 'Flotilla' : 'You';
    const day = String(1 + (i % 28)).padStart(2, '0');
    out.push({
      date: `2026-10-${day} ${String(8 + (i % 12)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
      author,
      body: agent
        ? `### Report ${i}\n\nDone with step ${i}: the **refresh** reads every worktree, see [src/ui/backlog/ticketPanel.ts](src/ui/backlog/ticketPanel.ts#L${i % 900}).\n\n- a point\n- another point`
        : `Comment ${i}: looks right to me, with a bit of text so the entry has some length to it.`,
    });
  }
  return out;
}

/** A stub of the VS Code API: enough for the ticket panel's code to load and run without the editor. */
const VSCODE_STUB = `
const noop = () => undefined;
const disposable = { dispose: noop };
export class EventEmitter { constructor() { this.event = () => disposable; } fire() {} dispose() {} }
export class Range { constructor(...a) { this.args = a; } }
export const Uri = { file: (p) => ({ fsPath: p, path: p, scheme: 'file', toString: () => 'file://' + p }), parse: (s) => ({ fsPath: s, path: s, toString: () => s }), joinPath: (...a) => ({ fsPath: a.join('/') }) };
export const window = { createWebviewPanel: () => { throw new Error('no panels in the benchmark'); }, showErrorMessage: noop, showWarningMessage: noop, showInformationMessage: noop };
export const commands = { executeCommand: () => Promise.reject(new Error('no VS Code: Markdown is not rendered here')) };
export const workspace = { getConfiguration: () => ({ get: (_k, d) => d }) };
export const env = { openExternal: noop };
export const ViewColumn = { Active: 1, Beside: 2 };
export const ProgressLocation = { Notification: 15 };
export const FileSystemError = { FileNotADirectory: noop, FileNotFound: noop };
export const extensions = { getExtension: () => undefined };
export const tasks = { fetchTasks: async () => [] };
export const debug = { startDebugging: async () => false };
`;

async function bundleSource(dir) {
  const src = path.resolve(import.meta.dirname, '..', 'src');
  const stub = path.join(dir, 'vscode-stub.mjs');
  fs.writeFileSync(stub, VSCODE_STUB);
  const entry = path.join(dir, 'entry.ts');
  fs.writeFileSync(
    entry,
    [
      `export { TicketPanels } from ${JSON.stringify(path.join(src, 'ui/backlog/ticketPanel'))};`,
      `export { LocalBacklog } from ${JSON.stringify(path.join(src, 'features/backlog/localBacklog'))};`,
      `export { buildWorkstreams } from ${JSON.stringify(path.join(src, 'features/workstreams/workstream'))};`,
      `export { WorktreeService } from ${JSON.stringify(path.join(src, 'features/worktrees/worktreeService'))};`,
      `export { ticketUpdate, applyTicketParts } from ${JSON.stringify(path.join(src, 'webview/ticketParts'))};`,
    ].join('\n'),
  );
  const out = path.join(dir, 'flotilla.cjs');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: out,
    // The stub has only what the ticket panel's code touches: other names are never reached here.
    logLevel: 'error',
    plugins: [
      {
        name: 'vscode-stub',
        setup(build) {
          build.onResolve({ filter: /^vscode$/ }, () => ({ path: stub }));
        },
      },
    ],
  });
  return createRequire(import.meta.url)(out);
}

/** A tab as the benchmark sees it: it records what the host posts to it, with the time. */
function fakeTab() {
  const posted = [];
  const tab = {
    title: '',
    posted,
    webview: {
      cspSource: '',
      asWebviewUri: (u) => u,
      postMessage(m) {
        posted.push({ at: performance.now(), m });
        return Promise.resolve(true);
      },
    },
    reveal: noop,
    dispose: noop,
    onDidDispose: () => ({ dispose: noop }),
  };
  return tab;
}
const noop = () => undefined;

/** Waits (polling) until `check` finds something; gives up after ten seconds. */
async function until(check, what) {
  const end = performance.now() + 10_000;
  let found = check();
  while (!found) {
    if (performance.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    found = check();
  }
  return found;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fmt = (n) => n.toFixed(1).padStart(9);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'flotilla-bench-ticket-')));
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flotilla-bench-ticket-bundle-'));
  let panels;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    fs.rmSync(bundleDir, { recursive: true, force: true });
  };
  process.once('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  try {
    const { TicketPanels, LocalBacklog, buildWorkstreams, WorktreeService, ticketUpdate, applyTicketParts } = await bundleSource(bundleDir);
    const mainRoot = path.join(root, 'repo');
    const setupStart = performance.now();
    buildFixture(mainRoot, opts);
    const backlog = new LocalBacklog(mainRoot, path.join(mainRoot, '.git'));
    await backlog.change((d) => ({
      ...d,
      items: [...d.items, { id: ID, title: 'A busy ticket', status: 'doing', priority: 'medium', created: '2026-10-01T09:00:00.000Z' }],
    }));
    await backlog.writeTicket(ID, {
      title: 'A busy ticket',
      description: 'The ticket, with a description of a few lines.\n\n- one\n- two',
      activity: entries(opts.entries),
    });
    // The worktrees the ticket has (as Flotilla lists them), from the real worktree code.
    const service = new WorktreeService({ mainRoot, commonDir: path.join(mainRoot, '.git') }, () => ({ autoAdopt: true }));
    const workstreams = await buildWorkstreams(service, {
      currentWorktreeRoot: mainRoot,
      settings: SETTINGS,
      now: new Date(),
      claudeHome: path.join(root, 'claude-home'),
    });
    const setupMs = performance.now() - setupStart;

    const repository = { current: workstreams, onDidChange: () => ({ dispose: noop }) };
    const integrations = {
      current: [],
      issues: () => [],
      sourceOf: async () => undefined,
      refresh: async () => undefined,
      onDidChange: () => ({ dispose: noop }),
    };
    const memento = { get: (_k, d) => d, update: async () => undefined };
    panels = new TicketPanels({
      extensionUri: { fsPath: root },
      mainRoot,
      reference: { fsPath: mainRoot },
      backlog,
      integrations,
      repository,
      revealWorktree: noop,
      showCommits: async () => undefined,
      memento,
    });

    console.log(
      `Flotilla ticket benchmark: ${ID} with ${opts.entries} entries and ${opts.commits} commits, ${workstreams.length} worktrees (main + ${opts.worktrees - 0} linked) × ${opts.files} files`,
    );
    console.log(`  node ${process.version}, ${os.cpus()[0]?.model ?? 'unknown CPU'} (${os.cpus().length} cores), ${os.platform()} ${os.release()}`);
    console.log(`  setup ${(setupMs / 1000).toFixed(1)} s (fixture in ${root})`);
    console.log('');

    // Each measurement: a fresh tab (a whole view), then the action, on the open tab (its part). The backlog watcher
    // posts to the open tabs too: when its post supersedes ours, the view comes from that one, so each wait is for the
    // message the measurement needs, not for the post that was awaited.
    const results = { open: [], openBytes: 0, status: [], statusBytes: 0, comment: [], commentBytes: 0 };
    for (let r = 0; r < opts.runs; r++) {
      const tab = fakeTab();
      // The tab is open: the panels post to the tabs they hold.
      panels.panels.set(ID, tab);
      const t0 = performance.now();
      await panels.post(ID, tab);
      const shown = await until(() => tab.posted.find((p) => p.m.type === 'ticket'), 'the whole view');
      results.open.push(shown.at - t0);
      results.openBytes = JSON.stringify(shown.m).length;

      const s0 = performance.now();
      const before = tab.posted.length;
      await panels.onMessage(ID, tab, { type: 'status', status: r % 2 ? 'doing' : 'review' });
      const statusPart = await until(() => tab.posted.slice(before).find((p) => p.m.type === 'ticketParts' && 'item' in p.m.parts), 'the status part');
      results.status.push(statusPart.at - s0);
      results.statusBytes = JSON.stringify(statusPart.m).length;

      const c0 = performance.now();
      const mark = tab.posted.length;
      await panels.onMessage(ID, tab, { type: 'comment', text: `Benchmark comment ${r}` });
      const commentPart = await until(() => tab.posted.slice(mark).find((p) => p.m.type === 'ticketParts' && p.m.activity), 'the comment entry');
      results.comment.push(commentPart.at - c0);
      results.commentBytes = JSON.stringify(commentPart.m).length;
    }

    // What the webview does with a change, on the same ticket's view (its code, bundled from the source).
    const view = await (async () => {
      const tab = fakeTab();
      panels.panels.set(ID, tab);
      await panels.post(ID, tab);
      return tab.posted.find((p) => p.m.type === 'ticket').m.ticket;
    })();
    const next = { ...view, item: { ...view.item, status: 'done' }, activity: [...view.activity, { ...view.activity[0], body: 'new' }] };
    const merge = [];
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      const change = ticketUpdate(view, next);
      applyTicketParts(view, change);
      merge.push(performance.now() - t);
    }

    const row = (name, xs) => `${name.padEnd(34)}${fmt(median(xs))}${fmt(Math.max(...xs))}  ${median(xs) < BUDGET_MS ? 'under' : 'over '} ${BUDGET_MS} ms`;
    console.log('measure                              median ms  max ms   budget');
    console.log(row('open a busy ticket (whole view)', results.open));
    console.log(row('status change (the part that shows it)', results.status));
    console.log(row('a comment (the entry that shows it)', results.comment));
    console.log(`webview: diff and merge of one change  ${fmt(median(merge))}${fmt(Math.max(...merge))}  (200 runs; not a budget: pure code)`);
    console.log('');
    console.log(`sent: whole view ${(results.openBytes / 1024).toFixed(0)} KB; status part ${results.statusBytes} B; comment part ${results.commentBytes} B`);
    console.log(`${opts.runs} runs each; the first open of a view reads the fixture cold.`);
  } finally {
    panels?.dispose();
    cleanup();
    console.log('');
    console.log('Removed the fixture and the temporary files.');
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  })
  // The tab's watchers keep the process alive; the benchmark is done.
  .finally(() => process.exit());

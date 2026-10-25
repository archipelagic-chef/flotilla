import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runGit } from '../core/git/gitCli';
import {
  type AgentHold,
  installMain,
  type InstallNote,
  noteAction,
  type NoteStore,
  resumeFromNote,
} from '../features/installMain';
import {
  agentsPhrase,
  type BuildStamp,
  describeBuild,
  isFlotillaRepo,
  mergesLabel,
  mergesSince,
  parseBuildStamp,
} from '../features/selfUpdate';
import { runningAgentNames } from './backlog/agentRunner';
import { expectReinstall } from './installedVersion';

/** How often main is counted again: merges land on it while the window runs. */
const CHECK_EVERY_MS = 60_000;

let version = '0.0.0';
let stamp: BuildStamp | undefined;
let repo: { root: string; commonDir: string; base: () => Promise<string | undefined> } | undefined;
let behind: { count: number; base: string } | undefined;
let state: 'idle' | 'building' = 'idle';
/** Pause All (BL-160), which Install Main pauses the agents with across the reload. */
let hold: AgentHold | undefined;
/** This window installed a build: it reloads (or the user said not to), not because the note says so. */
let installedHere = false;
let item: vscode.StatusBarItem | undefined;
const changed = new vscode.EventEmitter<void>();

/** The build this window runs, in a line for hovers ("Flotilla 0.2.0, built from 814b863 on …"). */
export function buildLine(): string {
  return describeBuild(version, stamp, (iso) => new Date(iso).toLocaleString());
}

/** Fires when what's said about the build changes (main counted again, an update started or ended). */
export const onDidChangeBuild = changed.event;

/** Reads the build's stamp, and registers "Flotilla: About" and "Flotilla: Install Main and Reload" (BL-151, BL-161). */
export function registerSelfUpdate(context: vscode.ExtensionContext): void {
  version = String((context.extension.packageJSON as { version?: unknown }).version ?? '0.0.0');
  stamp = parseBuildStamp(read(path.join(context.extensionPath, 'dist', 'build.json')));
  context.subscriptions.push(
    changed,
    vscode.commands.registerCommand('flotilla.about', () => about()),
    vscode.commands.registerCommand('flotilla.updateFromMain', () => update()),
  );
}

/**
 * In Flotilla's own repository, counts main's merges since this build and shows them in the status bar; its click
 * updates. Elsewhere, nothing. Not in development, where the window runs the checkout's own build.
 */
export function watchMainBuild(context: vscode.ExtensionContext, root: string, commonDir: string, base: () => Promise<string | undefined>): void {
  if (!isFlotillaRepo(read(path.join(root, 'package.json')))) return;
  repo = { root, commonDir, base };
  if (context.extensionMode !== vscode.ExtensionMode.Production || !stamp) return;
  item = vscode.window.createStatusBarItem('flotilla.update', vscode.StatusBarAlignment.Left, 49);
  item.name = 'Flotilla Update';
  item.command = 'flotilla.updateFromMain';
  const timer = setInterval(() => void count(), CHECK_EVERY_MS);
  context.subscriptions.push(item, { dispose: () => clearInterval(timer) });
  void count();
}

async function count(): Promise<void> {
  if (!repo || !stamp) return;
  const base = await repo.base().catch(() => undefined);
  const n = base === undefined ? undefined : await mergesSince((args) => runGit(args, { cwd: repo!.root }), stamp.commit, base);
  const next = n && base ? { count: n, base } : undefined;
  if (next?.count !== behind?.count || next?.base !== behind?.base) {
    behind = next;
    changed.fire();
  }
  show();
}

function show(): void {
  if (!item) return;
  if (!behind && state === 'idle') return item.hide();
  const merges = behind ? `${mergesLabel(behind.count)} since your build` : 'update';
  item.text = state === 'building' ? '$(sync~spin) Flotilla: installing main…' : `$(cloud-download) Flotilla: ${merges}`;
  item.tooltip = `${buildLine()}.${behind ? `\n\n${behind.base} has ${mergesLabel(behind.count)} since. Click to build ${behind.base}, pause the agents, install it and reload: they resume on the new build.` : ''}`;
  item.show();
}

async function about(): Promise<void> {
  const lines = [`${buildLine()}.`];
  if (behind) lines.push(`${behind.base} has ${mergesLabel(behind.count)} since.`);
  const updateLabel = 'Install Main and Reload';
  const pick = await vscode.window.showInformationMessage(lines.join(' '), ...(repo ? [updateLabel] : []));
  if (pick === updateLabel) await update();
}

/** Builds main, pauses the agents, installs the build and reloads (BL-161); the new build resumes them. */
async function update(): Promise<void> {
  if (!repo) {
    void vscode.window.showInformationMessage("Installing main works in Flotilla's own repository: its package.json names it flotilla.");
    return;
  }
  if (state === 'building')
    return void vscode.window.showInformationMessage('Flotilla is installing main already: see its notification and the "Flotilla Update" terminal.');
  const r = repo;
  state = 'building';
  show();
  try {
    const base = await r.base();
    if (!base) throw new Error("the base branch isn't known (the flotilla.defaultBase setting)");
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Flotilla: Install Main and Reload', cancellable: true },
      (progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        return installMain({
          build: (signal) => buildInTerminal(r.root, base, signal),
          hold,
          running: runningAgentNames,
          install: async (vsix) => {
            expectReinstall();
            try {
              await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsix));
            } finally {
              fs.rmSync(path.dirname(vsix), { recursive: true, force: true });
            }
          },
          reload: async () => {
            installedHere = true;
            // Without Pause All, a reload ends the agents: asked first (their chats are kept to resume).
            const agents = hold ? [] : runningAgentNames();
            if (agents.length) {
              const reload = 'Reload Window';
              const sure = await vscode.window.showWarningMessage(
                `Flotilla from ${base} is installed. Reloading stops ${agentsPhrase(agents)}: their chats are kept, and the tickets offer to resume them.`,
                { modal: true },
                reload,
              );
              if (sure !== reload) return;
            }
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
          },
          notes: notes(r.commonDir),
          step: (text) => progress.report({ message: text.replace('main', base) }),
          ask: async (question, choices) => vscode.window.showWarningMessage(question, ...choices),
          signal: abort.signal,
        });
      },
    );
    if (result.kind === 'build-failed')
      void vscode.window.showErrorMessage(`Building ${base} failed: the "Flotilla Update" terminal says why. Nothing was paused or installed.`);
    else if (result.kind === 'failed') void vscode.window.showErrorMessage(`${result.error}.${result.resumed ? ' The agents it paused are resumed.' : ''}`);
    else if (result.kind === 'cancelled')
      void vscode.window.showInformationMessage(
        `Install Main cancelled: nothing was installed${result.resumed ? ', and the agents it paused are resumed' : ''}.`,
      );
  } catch (e) {
    void vscode.window.showErrorMessage(`Installing main failed: ${e instanceof Error ? e.message : String(e)}. The installed Flotilla is as it was.`);
  } finally {
    state = 'idle';
    show();
  }
}

/** The note in the repository's .git/flotilla/, which every window of it sees. */
function notes(commonDir: string): NoteStore & { file: string } {
  const file = path.join(commonDir, 'flotilla', 'install-main.json');
  return {
    file,
    read: () => {
      try {
        const o = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<InstallNote>;
        return typeof o.commit === 'string' && typeof o.at === 'string'
          ? { commit: o.commit, at: o.at, paused: Number(o.paused) || 0, resume: o.resume === true }
          : undefined;
      } catch {
        return undefined;
      }
    },
    write: (note) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(note, null, 2)}\n`);
      fs.renameSync(tmp, file);
    },
  };
}

/**
 * After a reload for Install Main (BL-161): resumes the agents it paused, and says whether this is the build it
 * installed. Then watches the note: when another window installs a build, this one reloads to run it too.
 */
export function resumeAfterInstall(context: vscode.ExtensionContext, commonDir: string, agentHold: AgentHold | undefined): void {
  hold = agentHold;
  const store = notes(commonDir);
  const startedAt = new Date();
  const action = noteAction(store.read(), stamp?.commit, startedAt);
  if (action.kind === 'resume')
    void resumeFromNote(store, stamp?.commit, hold).then(
      (said) => said && (action.expected ? vscode.window.showInformationMessage(said) : vscode.window.showWarningMessage(said)),
      (e: unknown) =>
        vscode.window.showErrorMessage(
          `Resuming the agents after the reload failed: ${e instanceof Error ? e.message : String(e)}. Resume All Agents goes on.`,
        ),
    );
  // In development the window runs the checkout's build: it isn't reloaded for an install.
  if (context.extensionMode !== vscode.ExtensionMode.Production) return;
  let reloading = false;
  fs.watchFile(store.file, { interval: 2000 }, () => {
    if (reloading || installedHere || noteAction(store.read(), stamp?.commit, startedAt).kind !== 'reload') return;
    reloading = true;
    void vscode.window.showInformationMessage('Another window installed Flotilla from main: this one reloads to run it.');
    setTimeout(() => void vscode.commands.executeCommand('workbench.action.reloadWindow'), 1500);
  });
  context.subscriptions.push({ dispose: () => fs.unwatchFile(store.file) });
}

/**
 * Packages base in a worktree in the temp folder (not under the repository, and not the user's checkout), with the
 * main checkout's node_modules, showing each step's output in a terminal. The .vsix's path and the commit built, or
 * undefined when a step failed or it was cancelled (the terminal stays open with its output).
 */
async function buildInTerminal(root: string, base: string, signal: AbortSignal): Promise<{ vsix: string; commit: string } | undefined> {
  const commit = (await runGit(['rev-parse', '--verify', `refs/heads/${base}^{commit}`], { cwd: root })).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flotilla-update-'));
  const tree = path.join(dir, 'main');
  const vsix = path.join(dir, 'flotilla.vsix');
  const write = new vscode.EventEmitter<string>();
  const close = new vscode.EventEmitter<number | void>();
  return new Promise((resolve) => {
    const say = (text: string) => write.fire(text.replace(/\r?\n/g, '\r\n'));
    const run = (cmd: string, args: string[], cwd: string) =>
      new Promise<void>((ok, fail) => {
        say(`\x1b[1m$ ${cmd} ${args.join(' ')}\x1b[0m\n`);
        if (signal.aborted) return fail(new Error('cancelled'));
        const child = spawn(cmd, args, { cwd, shell: process.platform === 'win32', env: { ...process.env, FORCE_COLOR: '0' } });
        const cancel = () => child.kill();
        signal.addEventListener('abort', cancel, { once: true });
        child.on('exit', () => signal.removeEventListener('abort', cancel));
        child.stdout.on('data', (d: Buffer) => say(d.toString()));
        child.stderr.on('data', (d: Buffer) => say(d.toString()));
        child.on('error', fail);
        child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} exited with ${code}`))));
      });
    const steps = async () => {
      await run('git', ['worktree', 'add', '--detach', tree, commit], root);
      try {
        const modules = path.join(root, 'node_modules');
        if (!fs.existsSync(modules)) throw new Error(`${modules} is missing: run npm install in the main checkout.`);
        fs.symlinkSync(modules, path.join(tree, 'node_modules'), 'junction');
        await run('npm', ['run', 'package', '--', '--out', vsix], tree);
      } finally {
        await run('git', ['worktree', 'remove', '--force', tree], root).catch(() => undefined);
      }
    };
    const pty: vscode.Pseudoterminal = {
      onDidWrite: write.event,
      onDidClose: close.event,
      open: () => {
        say(`Building Flotilla from ${base} (${commit.slice(0, 7)}) in ${tree}\n\n`);
        steps().then(
          () => {
            say('\nBuilt. Pausing the agents, then installing…\n');
            resolve({ vsix, commit });
            close.fire(0);
          },
          (e: unknown) => {
            say(
              `\n\x1b[31mThe build ${signal.aborted ? 'was cancelled' : `failed: ${e instanceof Error ? e.message : String(e)}`}. Nothing was paused or installed.\x1b[0m\n`,
            );
            fs.rmSync(dir, { recursive: true, force: true });
            resolve(undefined);
          },
        );
      },
      close: () => undefined,
    };
    vscode.window.createTerminal({ name: 'Flotilla Update', pty, iconPath: new vscode.ThemeIcon('cloud-download') }).show(true);
  });
}

function read(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

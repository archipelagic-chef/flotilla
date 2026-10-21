import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runGit } from '../core/git/gitCli';
import { agentsPhrase, describeBuild, isFlotillaRepo, mergesLabel, mergesSince, parseBuildStamp, type BuildStamp } from '../features/selfUpdate';
import { runningAgentNames } from './backlog/agentRunner';
import { expectReinstall } from './installedVersion';

/** How often main is counted again: merges land on it while the window runs. */
const CHECK_EVERY_MS = 60_000;
/** How often an update waiting for the agents looks whether they're done. */
const IDLE_EVERY_MS = 15_000;

let version = '0.0.0';
let stamp: BuildStamp | undefined;
let repo: { root: string; base: () => Promise<string | undefined> } | undefined;
let behind: { count: number; base: string } | undefined;
let state: 'idle' | 'waiting' | 'building' = 'idle';
let item: vscode.StatusBarItem | undefined;
const changed = new vscode.EventEmitter<void>();

/** The build this window runs, in a line for hovers ("Flotilla 0.2.0, built from 814b863 on …"). */
export function buildLine(): string {
  return describeBuild(version, stamp, (iso) => new Date(iso).toLocaleString());
}

/** Fires when what's said about the build changes (main counted again, an update started or ended). */
export const onDidChangeBuild = changed.event;

/** Reads the build's stamp, and registers "Flotilla: About" and "Flotilla: Update from Main Build" (BL-151). */
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
export function watchMainBuild(context: vscode.ExtensionContext, root: string, base: () => Promise<string | undefined>): void {
  if (!isFlotillaRepo(read(path.join(root, 'package.json')))) return;
  repo = { root, base };
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
  item.text =
    state === 'building' ? '$(sync~spin) Flotilla: building main…' : state === 'waiting' ? `$(watch) Flotilla: ${merges}, updates when idle` : `$(cloud-download) Flotilla: ${merges}`;
  item.tooltip = `${buildLine()}.${behind ? `\n\n${behind.base} has ${mergesLabel(behind.count)} since. Click to build ${behind.base}, install it and reload.` : ''}`;
  item.show();
}

async function about(): Promise<void> {
  const lines = [`${buildLine()}.`];
  if (behind) lines.push(`${behind.base} has ${mergesLabel(behind.count)} since.`);
  const updateLabel = 'Update from Main Build';
  const pick = await vscode.window.showInformationMessage(lines.join(' '), ...(repo ? [updateLabel] : []));
  if (pick === updateLabel) await update();
}

/** Builds main in a throwaway worktree, installs it and reloads; with agents running, offers to wait for them first. */
async function update(): Promise<void> {
  if (!repo) {
    void vscode.window.showInformationMessage("Updating from main works in Flotilla's own repository: its package.json names it flotilla.");
    return;
  }
  if (state === 'building') return void vscode.window.showInformationMessage('Flotilla is building main already: see the "Flotilla Update" terminal.');
  if (state === 'waiting') return void vscode.window.showInformationMessage('The update waits for the agents running in this window to be done.');
  const agents = runningAgentNames();
  if (agents.length > 0) {
    const whenIdle = 'Update When Idle';
    const now = 'Install Now, Reload Later';
    const pick = await vscode.window.showWarningMessage(
      `${agentsPhrase(agents)} ${agents.length === 1 ? 'is' : 'are'} running in this window: reloading stops ${agents.length === 1 ? 'it' : 'them'}. Update when they're done, or install now and reload yourself?`,
      whenIdle,
      now,
    );
    if (pick === whenIdle) return waitForIdle();
    if (pick !== now) return;
  }
  await buildAndInstall(false);
}

function waitForIdle(): void {
  state = 'waiting';
  show();
  const timer = setInterval(() => {
    if (runningAgentNames().length > 0) return;
    clearInterval(timer);
    void buildAndInstall(true);
  }, IDLE_EVERY_MS);
}

async function buildAndInstall(reloadWhenIdle: boolean): Promise<void> {
  const r = repo!;
  state = 'building';
  show();
  try {
    const base = await r.base();
    if (!base) throw new Error("The base branch isn't known (the flotilla.defaultBase setting).");
    const vsix = await buildInTerminal(r.root, base);
    if (!vsix) {
      void vscode.window.showErrorMessage(`Building ${base} failed: the "Flotilla Update" terminal says why. The installed Flotilla is as it was.`);
      return;
    }
    expectReinstall();
    try {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsix));
    } finally {
      fs.rmSync(path.dirname(vsix), { recursive: true, force: true });
    }
    await offerReload(base, reloadWhenIdle);
  } catch (e) {
    void vscode.window.showErrorMessage(`Updating Flotilla failed: ${e instanceof Error ? e.message : String(e)}. The installed Flotilla is as it was.`);
  } finally {
    state = 'idle';
    show();
  }
}

async function offerReload(base: string, reloadWhenIdle: boolean): Promise<void> {
  const agents = runningAgentNames();
  if (reloadWhenIdle && agents.length === 0) return void vscode.commands.executeCommand('workbench.action.reloadWindow');
  const reload = 'Reload Window';
  const pick = await vscode.window.showInformationMessage(
    `Flotilla from ${base} is installed: it runs once you reload the window.${agents.length ? ` Reloading stops ${agentsPhrase(agents)} (their chats are kept to resume).` : ''}`,
    reload,
  );
  if (pick !== reload) return;
  const now = runningAgentNames();
  if (now.length > 0) {
    const sure = await vscode.window.showWarningMessage(`Reloading stops ${agentsPhrase(now)}. Their chats are kept, and the tickets offer to resume them.`, { modal: true }, reload);
    if (sure !== reload) return;
  }
  await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

/**
 * Packages base in a worktree in the temp folder (not under the repository, and not the user's checkout), with the
 * main checkout's node_modules, showing each step's output in a terminal. The .vsix's path, or undefined when a step
 * failed (the terminal stays open with its output).
 */
function buildInTerminal(root: string, base: string): Promise<string | undefined> {
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
        const child = spawn(cmd, args, { cwd, shell: process.platform === 'win32', env: { ...process.env, FORCE_COLOR: '0' } });
        child.stdout.on('data', (d: Buffer) => say(d.toString()));
        child.stderr.on('data', (d: Buffer) => say(d.toString()));
        child.on('error', fail);
        child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} exited with ${code}`))));
      });
    const steps = async () => {
      await run('git', ['worktree', 'add', '--detach', tree, `refs/heads/${base}`], root);
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
        say(`Building Flotilla from ${base} in ${tree}\n\n`);
        steps().then(
          () => {
            say('\nBuilt. Installing…\n');
            resolve(vsix);
            close.fire(0);
          },
          (e: unknown) => {
            say(`\n\x1b[31mThe build failed: ${e instanceof Error ? e.message : String(e)}. The installed Flotilla is as it was.\x1b[0m\n`);
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

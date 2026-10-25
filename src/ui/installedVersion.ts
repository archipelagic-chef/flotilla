import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  type NewerInstall,
  newerInstall,
  newerMessage,
  obsoleteFolders,
  staleStartNote,
} from '../features/installedVersion';
import { runningAgentCount } from './backlog/agentRunner';

/** How often the extensions folder is looked at again: an update lands there while the window runs. */
const CHECK_EVERY_MS = 2 * 60_000;

let found: { newer: NewerInstall; running: string } | undefined;

/**
 * Watches for a newer Flotilla installed than the one this window runs (BL-85), and says so once, offering to reload.
 * Not in development, where the build changes under the window all the time.
 */
export function watchInstalledVersion(context: vscode.ExtensionContext): void {
  if (context.extensionMode !== vscode.ExtensionMode.Production) return;
  const id = context.extension.id;
  const running = String((context.extension.packageJSON as { version?: unknown }).version ?? '0.0.0');
  const folder = context.extension.extensionPath;
  const extensionsDir = path.dirname(folder);
  const main = path.join(folder, String((context.extension.packageJSON as { main?: unknown }).main ?? 'package.json'));
  const builtAt = mtime(main);
  if (builtAt === undefined) return;
  const check = (): void => {
    if (found) return;
    let folders: string[];
    try {
      folders = fs.readdirSync(extensionsDir);
    } catch {
      return;
    }
    const newer = newerInstall({
      id,
      running,
      folders,
      obsolete: obsoleteFolders(read(path.join(extensionsDir, '.obsolete'))),
      builtAt,
      builtNow: mtime(main),
    });
    if (!newer) return;
    found = { newer, running };
    clearInterval(timer);
    if (!quiet) void offerReload(newer, running);
  };
  const timer = setInterval(check, CHECK_EVERY_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  check();
}

/**
 * Flotilla installs a build itself and offers the reload (BL-151): the watcher doesn't say so again, but agents started
 * until the reload are noted as starting the old way.
 */
export function expectReinstall(): void {
  quiet = true;
}

let quiet = false;

/** What the autopilot adds to its note of an agent it starts or resumes while this window runs an older Flotilla. */
export function staleVersionNote(): string {
  return found ? staleStartNote(found.newer, found.running) : '';
}

async function offerReload(newer: NewerInstall, running: string): Promise<void> {
  const reload = 'Reload Window';
  const pick = await vscode.window.showInformationMessage(newerMessage(newer, running, runningAgentCount()), reload);
  if (pick !== reload) return;
  // Agents may have started since the message showed: reloading stops them, so that's asked first.
  const agents = runningAgentCount();
  if (agents > 0) {
    const sure = await vscode.window.showWarningMessage(
      `Reloading stops the ${agents === 1 ? 'agent' : `${agents} agents`} running in this window. Their chats are kept, and the tickets offer to resume them.`,
      { modal: true },
      reload,
    );
    if (sure !== reload) return;
  }
  await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

function mtime(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

function read(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * What a run block does in VS Code (BL-20): the ticket's terminal (reused, after asking when something still runs in
 * it), the worktree's folder in this window, launch and task blocks, and what the user already approved.
 */
import * as vscode from 'vscode';
import { samePath } from '../../core/paths';
import { toWorkspaceUri } from '../../core/uris';
import {
  planTerminal,
  unknownNameMessage,
} from '../../features/backlog/runWorktree';
import { addWorkspaceFolder } from '../workspaceFolders';

const APPROVALS = 'flotilla.backlog.runApprovals';
/** How many approvals are kept: the newest ones (a block that changes gets a new one anyway). */
const MAX_APPROVALS = 200;

/** The blocks the user approved, by fingerprint (kept per window, in its workspace state). */
export class RunApprovals {
  constructor(private readonly memento: vscode.Memento) {}

  has(fingerprint: string): boolean {
    return this.memento.get<string[]>(APPROVALS, []).includes(fingerprint);
  }

  async add(fingerprint: string): Promise<void> {
    const kept = this.memento.get<string[]>(APPROVALS, []).filter((f) => f !== fingerprint);
    await this.memento.update(APPROVALS, [...kept, fingerprint].slice(-MAX_APPROVALS));
  }
}

/**
 * The terminals of run blocks: one per ticket and worktree, named "Run BL-3", and reused. Something still running in
 * one is stopped only after asking. Whether something runs comes from VS Code's shell integration; without it, the
 * terminal is asked about all the same (we can't tell).
 */
export class RunTerminals implements vscode.Disposable {
  private readonly busy = new Set<vscode.Terminal>();
  private readonly subscriptions: vscode.Disposable[] = [
    vscode.window.onDidStartTerminalShellExecution((e) => this.busy.add(e.terminal)),
    vscode.window.onDidEndTerminalShellExecution((e) => this.busy.delete(e.terminal)),
    vscode.window.onDidCloseTerminal((t) => this.busy.delete(t)),
  ];

  dispose(): void {
    this.subscriptions.forEach((d) => d.dispose());
  }

  /** The ticket's terminal in dir: a new one, the one there is, or undefined when the user keeps what runs in it. */
  async forRun(id: string, dir: string): Promise<vscode.Terminal | undefined> {
    const name = `Run ${id}`;
    const existing = vscode.window.terminals.find((t) => t.name === name && samePath(terminalCwd(t) ?? '', dir));
    const plan = planTerminal(!existing ? 'none' : existing.shellIntegration === undefined ? 'unknown' : this.busy.has(existing) ? 'running' : 'idle');
    if (plan.action === 'new') return vscode.window.createTerminal({ name, cwd: dir });
    if (!existing) return undefined;
    if (plan.action === 'ask') {
      const question = plan.known ? `${name} is still running something.` : `${name} can't tell whether something is still running in its terminal.`;
      const answer = await vscode.window.showWarningMessage(`${question} Stop it and run the new commands?`, { modal: true }, 'Stop and Run');
      if (answer !== 'Stop and Run') return undefined;
      existing.sendText('\x03', false);
      this.busy.delete(existing);
    }
    return existing;
  }
}

function terminalCwd(t: vscode.Terminal): string | undefined {
  const cwd = (t.creationOptions as vscode.TerminalOptions).cwd;
  return typeof cwd === 'string' ? cwd : cwd?.fsPath;
}

/**
 * The workspace folder of a worktree in this window, for launch and task blocks. When it isn't here, asks whether to
 * add it to this workspace or open it in a window of its own. The run is then done again there (or here, once it's
 * added): undefined in both cases.
 */
export async function folderFor(dir: string, reference: vscode.Uri, label: string): Promise<vscode.WorkspaceFolder | undefined> {
  const here = vscode.workspace.workspaceFolders?.find((f) => samePath(f.uri.fsPath, dir));
  if (here) return here;
  const answer = await vscode.window.showInformationMessage(`${label} is in ${dir}, which isn't in this window.`, 'Add to Workspace', 'Open in New Window');
  if (answer === 'Add to Workspace') {
    // The folder list may not be updated yet (or the window may restart with the new workspace): so this run stops here,
    // and the block is run again once the folder is there.
    addWorkspaceFolder(reference, dir, label);
    void vscode.window.showInformationMessage(`${label} added to this workspace: run the block again.`);
    return undefined;
  }
  if (answer === 'Open in New Window') {
    await vscode.commands.executeCommand('vscode.openFolder', toWorkspaceUri(reference, dir), { forceNewWindow: true });
    void vscode.window.showInformationMessage(`${label} opened in a new window: run the block again there.`);
  }
  return undefined;
}

/** The launch configurations of a folder's launch.json, by name. */
export function launchNames(folder: vscode.WorkspaceFolder): string[] {
  const configs = vscode.workspace.getConfiguration('launch', folder.uri).get<Array<{ name?: unknown }>>('configurations', []);
  return configs.flatMap((c) => (typeof c.name === 'string' ? [c.name] : []));
}

/** The tasks of a folder's tasks.json. */
export async function folderTasks(folder: vscode.WorkspaceFolder): Promise<vscode.Task[]> {
  return (await vscode.tasks.fetchTasks()).filter((t) => {
    const scope = t.scope;
    return typeof scope === 'object' && scope !== null && 'uri' in scope && samePath(scope.uri.fsPath, folder.uri.fsPath);
  });
}

/** What a launch or task block with this name can't run, said for the user: undefined when it can. */
export async function missingName(kind: 'launch' | 'task', folder: vscode.WorkspaceFolder, name: string | undefined): Promise<string | undefined> {
  const names = kind === 'launch' ? launchNames(folder) : (await folderTasks(folder)).map((t) => t.name);
  return name && names.includes(name) ? undefined : unknownNameMessage(kind, name, names, folder.uri.fsPath);
}

export function startLaunch(folder: vscode.WorkspaceFolder, name: string): Thenable<boolean> {
  return vscode.debug.startDebugging(folder, name);
}

export async function startTask(folder: vscode.WorkspaceFolder, name: string): Promise<void> {
  const task = (await folderTasks(folder)).find((t) => t.name === name);
  if (task) await vscode.tasks.executeTask(task);
}

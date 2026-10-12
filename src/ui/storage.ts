import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { runGit, GitError } from '../core/git/gitCli';
import { pathKey } from '../core/paths';
import type { LocalBacklog } from '../features/backlog/localBacklog';
import { cleanUpInProgress, needsPacking, packRepository, PACKING_CHECK_MS, parseLooseCount } from '../features/storage/packing';
import { parseMountInfo, probeReadMs, slowStorageText, SLOW_STORAGE_DOCS, storageReport, type MountEntry, type StorageReport } from '../features/storage/storage';

export interface StorageDeps {
  mainRoot: string;
  commonDir: string;
  backlog: LocalBacklog;
  globalState: vscode.Memento;
  output: vscode.OutputChannel;
  /** How the storage is found out (the mount table, then reads); injected by tests. */
  mounts?: () => MountEntry[] | undefined;
  probe?: (gitDir: string) => number | undefined;
}

/** The mount table, where there is one (Linux). Undefined elsewhere or when it can't be read. */
function readMounts(): MountEntry[] | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    return parseMountInfo(fs.readFileSync('/proc/self/mountinfo', 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Tells the user once when the repository is on a slow drive, and keeps it packed: loose objects past a limit are packed
 * in the background (git maintenance), never during a history clean-up.
 */
export class StorageMonitor implements vscode.Disposable {
  private report: StorageReport | undefined;
  private packing = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly deps: StorageDeps) {}

  /** What the Overview shows while the repository is slow (undefined otherwise). */
  get slow(): { message: string; fix: string } | undefined {
    return this.report?.slow ? slowStorageText(this.report) : undefined;
  }

  /** Starts the checks. Never rejects: packing starts whether or not the storage could be measured. */
  async start(): Promise<void> {
    try {
      await this.measure();
    } catch {
      this.deps.output.appendLine('Checking the repository storage failed.');
    }
    this.timer = setInterval(() => void this.pack(), PACKING_CHECK_MS);
    void this.pack();
  }

  private async measure(): Promise<void> {
    const dir = (() => {
      try {
        return fs.realpathSync.native(this.deps.mainRoot);
      } catch {
        return this.deps.mainRoot;
      }
    })();
    const mounts = this.deps.mounts ?? readMounts;
    const probe = this.deps.probe ?? probeReadMs;
    const report = storageReport({ dir, mounts: mounts(), probe: () => probe(this.deps.commonDir) });
    this.deps.output.appendLine(report.slow ? `Repository storage is slow (${report.fsType ?? 'measured reads'}).` : 'Repository storage is local.');
    if (!report.slow) return;
    this.report = report;
    this.emitter.fire();
    await this.notifyOnce(report);
  }

  /** One notification per repository, remembered in this machine's VS Code state (no path in it). */
  private async notifyOnce(report: StorageReport): Promise<void> {
    const key = `flotilla.slowStorage:${crypto.createHash('sha256').update(pathKey(this.deps.mainRoot)).digest('hex').slice(0, 16)}`;
    if (this.deps.globalState.get<boolean>(key)) return;
    await this.deps.globalState.update(key, true);
    const { message, fix } = slowStorageText(report);
    const choice = await vscode.window.showWarningMessage(`${message} ${fix}`, 'How to Fix');
    if (choice) await vscode.env.openExternal(vscode.Uri.parse(SLOW_STORAGE_DOCS));
  }

  /** Packs the repository when it has too many loose objects; one run at a time. */
  async pack(): Promise<void> {
    if (this.packing) return;
    this.packing = true;
    try {
      const loose = parseLooseCount(await runGit(['count-objects', '-v'], { cwd: this.deps.mainRoot }));
      if (!needsPacking(loose)) return;
      const data = await this.deps.backlog.read();
      if (cleanUpInProgress(data.items)) {
        this.deps.output.appendLine('Not packing the repository now: a history clean-up is in progress.');
        return;
      }
      this.deps.output.appendLine(`Packing the repository (${loose} loose objects).`);
      const code = await packRepository(this.deps.mainRoot);
      this.deps.output.appendLine(code === 0 ? 'Packed the repository.' : `Packing the repository ended with exit code ${code}.`);
    } catch (error) {
      // No message: git's errors may name local paths.
      this.deps.output.appendLine(`Packing the repository failed${error instanceof GitError ? ` (exit ${error.exitCode})` : ''}.`);
    } finally {
      this.packing = false;
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.emitter.dispose();
  }
}

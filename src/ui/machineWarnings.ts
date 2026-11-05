import * as vscode from 'vscode';
import { pathKey } from '../core/paths';
import {
  formatMemory,
  isMemoryShort,
} from '../features/workstreams/memory';

/** A low-memory toast isn't shown again within this long, however often memory dips. */
export const MEMORY_WARNING_QUIET_MS = 30 * 60_000;

const DONT_SHOW = "Don't Show Again";

export interface MachineWarningsDeps {
  mainRoot: string;
  globalState: vscode.Memento;
  /** Shows a warning toast; resolves to the button clicked. */
  show?: (message: string, ...buttons: string[]) => Thenable<string | undefined>;
  /** Hide Worktrees: sets the missing exclusions in the user's settings. */
  hideWorktrees(): Promise<void>;
  /** Whether the first-time offer to hide .worktrees was shown in this window: it says the same. */
  offeredHere(): boolean;
  /** Marks that first-time offer made: this warning made it. */
  markOffered(): Thenable<void>;
  now?: () => number;
}

/**
 * The machine's warnings, as toasts (BL-293, once the Overview's notices): the worktrees folder isn't excluded from
 * what VS Code watches and searches, and memory is too low for agents to start. Each shows when it starts to apply, not
 * on every refresh. (A slow drive has its toast in StorageMonitor.)
 */
export class MachineWarnings {
  /** The missing exclusions last warned about in this window ('' when none are missing). */
  private warnedExclusions = '';
  private wasLow = false;
  private lastMemoryWarning = -Infinity;

  constructor(private readonly deps: MachineWarningsDeps) {}

  private get offKey(): string {
    return `flotilla.exclusionsWarningOff:${pathKey(this.deps.mainRoot)}`;
  }

  private show(message: string, ...buttons: string[]): Thenable<string | undefined> {
    return (this.deps.show ?? vscode.window.showWarningMessage)(message, ...buttons);
  }

  /** What VS Code's settings still let see the worktrees folder (empty: nothing). Warns once per new set. */
  async exclusions(missing: readonly string[]): Promise<void> {
    const key = missing.join(', ');
    if (key === this.warnedExclusions) return;
    this.warnedExclusions = key;
    if (!key || this.deps.offeredHere() || this.deps.globalState.get<boolean>(this.offKey)) return;
    await this.deps.markOffered();
    const choice = await this.show(
      `Worktrees here aren't excluded from: ${key}. That slows every window and can exhaust the file watchers.`,
      'Hide Worktrees',
      DONT_SHOW,
    );
    if (choice === 'Hide Worktrees') await this.deps.hideWorktrees();
    else if (choice === DONT_SHOW) await this.deps.globalState.update(this.offKey, true);
  }

  /** The machine's free memory, as each refresh measures it. Warns when it falls below the minimum. */
  memory(freeMB: number, minFreeMB: number): void {
    const low = isMemoryShort(freeMB, minFreeMB);
    const started = low && !this.wasLow;
    this.wasLow = low;
    const now = (this.deps.now ?? Date.now)();
    if (!started || now - this.lastMemoryWarning < MEMORY_WARNING_QUIET_MS) return;
    this.lastMemoryWarning = now;
    void this.show(`Low on memory: no agent starts below ${formatMemory(minFreeMB)} free (flotilla.agents.minFreeMemoryMB).`);
  }
}

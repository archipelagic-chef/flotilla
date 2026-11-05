import {
  formatMemory,
  isMemoryShort,
} from '../../features/workstreams/memory';
import type {
  MachineState,
  SlowStorageView,
} from '../protocol';
import { run } from './api';

/** The machine in a line (BL-293): the agent count's tooltip says it. */
export function machineLine(machine: MachineState | undefined): string | undefined {
  if (!machine) return undefined;
  return [
    `${machine.agents} ${machine.agents === 1 ? 'agent' : 'agents'} working`,
    `${machine.windows} ${machine.windows === 1 ? 'window' : 'windows'} open`,
    `${formatMemory(machine.freeMB)} memory free`,
  ].join(' · ');
}

interface Props {
  machine?: MachineState;
  /** What VS Code's settings still let see the worktrees in the main folder (empty: nothing to show). */
  missing: readonly string[];
  /** The repository is on a slow drive: say so, and how to fix it. */
  slow?: SlowStorageView;
}

/**
 * The machine's warnings, at the top of the Backlog with its integration problems (BL-293, from the Overview): the
 * worktrees folder isn't excluded, the repository is on a slow drive, memory is too low for agents to start. Each shows
 * only while it applies.
 */
export function BacklogNotices({ machine, missing, slow }: Props) {
  const low = machine !== undefined && isMemoryShort(machine.freeMB, machine.minFreeMB);
  return (
    <>
      {low && (
        <div class="backlog-problem machine-notice" role="status">
          <i class="codicon codicon-warning" />
          <span>Low on memory: no agent starts below {formatMemory(machine.minFreeMB)} free (flotilla.agents.minFreeMemoryMB).</span>
        </div>
      )}
      {missing.length > 0 && (
        <div class="backlog-problem machine-notice">
          <i class="codicon codicon-info" />
          <span>Worktrees here aren't excluded from: {missing.join(', ')}. That slows every window and can exhaust the file watchers.</span>
          <button class="link" onClick={() => run('flotilla.hideWorktrees')}>
            Hide Worktrees
          </button>
        </div>
      )}
      {slow && (
        <div class="backlog-problem machine-notice" role="status">
          <i class="codicon codicon-warning" />
          <span>
            {slow.message} {slow.fix}
          </span>
          <button class="link" onClick={() => run('flotilla.slowStorageHelp')}>
            How to Fix
          </button>
        </div>
      )}
    </>
  );
}

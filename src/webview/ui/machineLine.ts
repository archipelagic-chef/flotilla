import { formatMemory } from '../../features/workstreams/memory';
import type { MachineState } from '../protocol';

/** The machine in a line (BL-293): the agent count's tooltip says it. */
export function machineLine(machine: MachineState | undefined): string | undefined {
  if (!machine) return undefined;
  return [
    `${machine.agents} ${machine.agents === 1 ? 'agent' : 'agents'} working`,
    `${machine.windows} ${machine.windows === 1 ? 'window' : 'windows'} open`,
    `${formatMemory(machine.freeMB)} memory free`,
  ].join(' · ');
}

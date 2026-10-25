import type { AutopilotState } from '../protocol';

/** The backlog header's count of agents working, shown with the autopilot off (its bar says it while on); none when idle. */
export function agentCountLabel(autopilot: AutopilotState | undefined): string | undefined {
  if (!autopilot || autopilot.enabled) return undefined;
  if (!autopilot.running && !autopilot.waiting && !autopilot.merging) return undefined;
  const waiting = autopilot.waiting ? ` · ${autopilot.waiting} waiting` : '';
  // Merges' agents and checks (BL-164): Pause All, next to the count, pauses them too.
  const merging = autopilot.merging ? ` · ${autopilot.merging} merge${autopilot.merging === 1 ? '' : 's'} at work` : '';
  return `${autopilot.running} of ${autopilot.max} agents working${waiting}${merging}`;
}

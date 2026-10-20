import type { AutopilotState } from '../protocol';

/** The backlog header's count of agents working, shown with the autopilot off (its bar says it while on); none when idle. */
export function agentCountLabel(autopilot: AutopilotState | undefined): string | undefined {
  if (!autopilot || autopilot.enabled) return undefined;
  if (!autopilot.running && !autopilot.waiting) return undefined;
  const waiting = autopilot.waiting ? ` · ${autopilot.waiting} waiting` : '';
  return `${autopilot.running} of ${autopilot.max} agents working${waiting}`;
}

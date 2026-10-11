import * as crypto from 'node:crypto';
import { entryAgent, type BacklogItem, type BacklogStatus } from './backlog';

/**
 * What changed about an item, as sentences for its ticket's activity (its history): status, priority, title, parent,
 * an accepted proposal, branches, the agents' model and effort. The review loop and history clean-ups write their own
 * notes; links are noted where they're made.
 */
const STATUS: Record<BacklogStatus, string> = { todo: 'To Do', doing: 'In Progress', review: 'In Review', done: 'Done' };
const PRIORITY: Record<string, string> = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };

/** Who made a change, as its sentence starts: "You", "Nova-7 (an agent)", or nothing for Flotilla itself. */
function subject(by: string): string {
  if (by === 'You') return 'You';
  if (by === 'Agent') return 'An agent';
  if (by === 'Autopilot') return 'The autopilot';
  const agent = entryAgent(by);
  if (agent) return `${agent} (an agent)`;
  return '';
}

/** A sentence for who did what: "You moved it…", or "Moved it…" when Flotilla did. */
function sentence(by: string, verb: string): string {
  const who = subject(by);
  return who ? `${who} ${verb}` : `${verb[0].toUpperCase()}${verb.slice(1)}`;
}

export function describeChanges(before: BacklogItem, after: BacklogItem, by: string): string[] {
  const out: string[] = [];
  const say = (verb: string) => out.push(sentence(by, verb));
  if (before.proposed && !after.proposed) say('accepted it into the backlog.');
  if (before.status !== after.status) say(`moved it from **${STATUS[before.status]}** to **${STATUS[after.status]}**.`);
  if (before.priority !== after.priority) {
    if (!after.priority) say(`cleared its priority (was ${PRIORITY[before.priority!] ?? before.priority}).`);
    else if (!before.priority) say(`set its priority to **${PRIORITY[after.priority] ?? after.priority}**.`);
    else say(`changed its priority from ${PRIORITY[before.priority] ?? before.priority} to **${PRIORITY[after.priority] ?? after.priority}**.`);
  }
  if (before.title !== after.title) say(`renamed it from “${before.title}”.`);
  if (before.parent !== after.parent) {
    if (after.parent) say(`made it part of ${after.parent}${before.parent ? ` (was part of ${before.parent})` : ''}.`);
    else say(`took it out of ${before.parent}.`);
  }
  const branches = (i: BacklogItem) => i.branches ?? (i.branch ? [i.branch] : []);
  for (const b of branches(after).filter((b) => !branches(before).includes(b))) say(`started branch \`${b}\` for it.`);
  if (before.agent?.model !== after.agent?.model) {
    say(after.agent?.model ? `set its agents' model to **${after.agent.model}**.` : "set its agents' model back to the default.");
  }
  if (before.agent?.effort !== after.agent?.effort) {
    say(after.agent?.effort ? `set its agents' effort to **${after.agent.effort}**.` : "set its agents' effort back to the default.");
  }
  return out;
}

/** A description's fingerprint: whether it changed since last seen. */
export function descriptionHash(text: string): string {
  return crypto.createHash('sha1').update(text.trim()).digest('hex').slice(0, 12);
}

/** How many lines an edit added and removed (as a multiset of lines: moves don't count). */
export function lineDelta(before: string, after: string): { added: number; removed: number } {
  const count = (t: string) => {
    const m = new Map<string, number>();
    for (const l of t.split(/\r?\n/).map((l) => l.trimEnd())) if (l) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const a = count(before);
  const b = count(after);
  let added = 0;
  let removed = 0;
  for (const [l, n] of b) added += Math.max(0, n - (a.get(l) ?? 0));
  for (const [l, n] of a) removed += Math.max(0, n - (b.get(l) ?? 0));
  return { added, removed };
}

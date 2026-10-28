import {
  agentLead,
  type BacklogData,
  type BacklogItem,
  childrenOf,
} from './backlog';
import { lineDelta } from './changes';
import { SHAPE_RULE } from './descriptionShape';
import { dependsOn } from './mainDrift';
import { whenItsDone } from './ticket';

/**
 * Sister checks (BL-236): when a ticket of an epic changes scope (its description is reworked, it's merged or
 * discarded), an agent checks the epic's other open tickets, and those that depend on it, against it and main. The
 * check waits on the changed ticket (`sisterCheck`) a few minutes after the last change, so edits close together run
 * one; the leading window runs it (see SisterChecks). Meanwhile the sisters it covers are held from the autopilot.
 * Shared by the host and the webviews (no node or vscode APIs).
 */

/** What started a check: the ticket was merged, discarded, or its description reworked (an epic's: its parts'). */
export type SisterReason = 'merged' | 'discarded' | 'described';

/** A check waiting on, or running for, a changed ticket. */
export interface SisterCheck {
  /** What changed, in order, each once. */
  reasons: SisterReason[];
  /** When it starts (ISO 8601): a few minutes after the last change. */
  due: string;
  /** The tickets it checks: held from the autopilot until it's done. */
  covers: string[];
  /** Once it runs: its agent, its chat, and when it started (ISO 8601). */
  agent?: string;
  session?: string;
  started?: string;
}

/** What a check found for a sister that needs the user: it's covered by the change, or at odds with it. */
export interface SisterVerdict {
  /** The changed ticket. */
  from: string;
  kind: 'covered' | 'contradicts';
  /** Why, in a line. */
  line: string;
  /** ISO 8601. */
  since: string;
}

/** How long after the last change a check starts, by default (flotilla.sisterCheckDelaySeconds): edits close together run one. */
export const SISTER_DEBOUNCE_MS = 3 * 60_000;
/** A running check this window doesn't run, older than this, was left by a window that's gone: it's released. */
export const SISTER_STALE_MS = 45 * 60_000;
/** An edit of more lines than this (added and removed) reworks a description. */
const FEW_LINES = 3;

const open = (i: BacklogItem) => !i.discarded && i.status !== 'done';

/**
 * The tickets a change of this one may touch: its epic's other open parts, the open tickets whose description says
 * they depend on it, and, for an epic, its own open parts. descriptions: each ticket's description, by id.
 */
export function sistersOf(data: BacklogData, id: string, descriptions: ReadonlyMap<string, string>): BacklogItem[] {
  const item = data.items.find((i) => i.id === id);
  if (!item) return [];
  const ids = new Set<string>();
  if (item.parent) for (const s of childrenOf(data, item.parent)) ids.add(s.id);
  for (const c of childrenOf(data, id)) ids.add(c.id);
  for (const i of data.items) if (dependsOn(descriptions.get(i.id) ?? '', i.id).includes(id.toUpperCase())) ids.add(i.id);
  ids.delete(id);
  return data.items.filter((i) => ids.has(i.id) && open(i));
}

/** Whether a sister's description may be brought up to date by the check: nobody works on it yet. */
export function editableSister(item: Pick<BacklogItem, 'status' | 'proposed'>): boolean {
  return !!item.proposed || item.status === 'todo';
}

/** The text that says what a ticket is to do, for comparing two descriptions: its acceptance criteria unticked. */
const criteria = (d: string) =>
  d
    .split(/\r?\n/)
    .filter((l) => /^\s*[-*]\s+\[[ xX]\]/.test(l))
    .map((l) => l.replace(/\[[xX]\]/, '[ ]').trim())
    .join('\n');

/**
 * Whether a description's edit reworks the ticket: its "When it's done" or its acceptance criteria changed (ticking a
 * box doesn't count), or more than a few lines did.
 */
export function reworked(before: string, after: string): boolean {
  if ((whenItsDone(before) ?? '') !== (whenItsDone(after) ?? '')) return true;
  if (criteria(before) !== criteria(after)) return true;
  const untick = (d: string) => d.replace(/^(\s*[-*]\s+)\[[xX]\]/gm, '$1[ ]');
  const delta = lineDelta(untick(before), untick(after));
  return delta.added + delta.removed > FEW_LINES;
}

/**
 * The backlog with a change of ticket `id` noted (why, at `now`): its check is due a few minutes from now, covering
 * its open sisters and dependents (a check waiting already takes the reason and waits again). Unchanged when there's
 * nothing to check (no parent, no parts, no dependents), when the check is already running (it reads the ticket as it
 * is then), or for an edit of a ticket a check covers: an edit made while it's checked is that check's.
 */
export function noteChange(
  data: BacklogData,
  id: string,
  reason: SisterReason,
  descriptions: ReadonlyMap<string, string>,
  now: Date,
  delayMs = SISTER_DEBOUNCE_MS,
): BacklogData {
  const item = data.items.find((i) => i.id === id);
  if (!item || item.sisterCheck?.session) return data;
  if (reason === 'described' && checkingOf(data, id)) return data;
  const covers = sistersOf(data, id, descriptions).map((s) => s.id);
  if (!covers.length) return data;
  const reasons = [...(item.sisterCheck?.reasons ?? []).filter((r) => r !== reason), reason];
  const check: SisterCheck = { reasons, due: new Date(now.getTime() + delayMs).toISOString(), covers };
  return { ...data, items: data.items.map((i) => (i.id === id ? { ...i, sisterCheck: check } : i)) };
}

/** The ticket whose check (waiting or running) covers this one, if any: the autopilot doesn't start it meanwhile. */
export function checkingOf(data: Pick<BacklogData, 'items'>, id: string): string | undefined {
  return data.items.find((i) => i.id !== id && i.sisterCheck?.covers.includes(id))?.id;
}

/** The checks due to start now, oldest first. */
export function dueChecks(data: Pick<BacklogData, 'items'>, now: Date): BacklogItem[] {
  return data.items
    .filter((i) => i.sisterCheck && !i.sisterCheck.session && Date.parse(i.sisterCheck.due) <= now.getTime())
    .sort((a, b) => a.sisterCheck!.due.localeCompare(b.sisterCheck!.due));
}

/** The backlog without ticket `id`'s check: its sisters are released. */
export function endCheck(data: BacklogData, id: string): BacklogData {
  return {
    ...data,
    items: data.items.map((i) => {
      if (i.id !== id || !i.sisterCheck) return i;
      const { sisterCheck: _done, ...rest } = i;
      return rest;
    }),
  };
}

/** The backlog with a sister's verdict set (or, without one, cleared: Keep). */
export function setVerdict(data: BacklogData, id: string, verdict?: SisterVerdict): BacklogData {
  return {
    ...data,
    items: data.items.map((i) => {
      if (i.id !== id) return i;
      const { sisterVerdict: _old, ...rest } = i;
      return verdict ? { ...rest, sisterVerdict: verdict } : rest;
    }),
  };
}

/**
 * What a check's agent may do: read and search the code, and edit the tickets of the To Do and proposed sisters (as
 * shapingTools, with one Edit rule per ticket). Those in progress or review aren't on it: their work isn't changed.
 */
export function sisterCheckTools(tickets: readonly string[]): string[] {
  return ['Read', 'Grep', 'Glob', ...tickets.map((t) => `Edit(//${t.replace(/^\/+/, '')})`)];
}

const REASON_TEXT: Record<SisterReason, string> = {
  merged: 'was merged to main',
  discarded: "was discarded as won't do",
  described: 'had its description reworked',
};

/** What a check found for a sister, as its reply's heading says. */
export type SisterFinding = 'updated' | 'covered' | 'contradicts' | 'outdated' | 'unchanged';
const FINDINGS: readonly SisterFinding[] = ['updated', 'covered', 'contradicts', 'outdated', 'unchanged'];

/** A sister as the prompt names it: its id, title, ticket file, and whether its description may be edited. */
export interface SisterRef {
  id: string;
  title: string;
  ticket: string;
  editable: boolean;
  /** Its status, in words ("To Do", "proposed", "in progress", "in review"). */
  status: string;
  /** How it's related: "a part of BL-1 too", "depends on it", "a part of it". */
  relation: string;
}

/** The first message of a check's agent: the change, the sisters, what it may do, and the shape of its reply. */
export function sisterCheckPrompt(o: {
  item: Pick<BacklogItem, 'id' | 'title'>;
  agent: string;
  ticket: string;
  reasons: readonly SisterReason[];
  epic?: { id: string; ticket: string };
  sisters: readonly SisterRef[];
  base: string;
}): string {
  const what = o.reasons.map((r) => REASON_TEXT[r]).join(', and ');
  const list = o.sisters.map((s) => `- ${s.id} "${s.title}" (${s.status}; ${s.relation}): ${s.ticket}${s.editable ? '' : ' (read only)'}`);
  return [
    agentLead(o.item, o.agent),
    `You check its sister tickets against its change: ${o.item.id} ${what}. Its ticket is ${o.ticket}.${o.epic ? ` It's a part of ${o.epic.id}, whose ticket is ${o.epic.ticket}.` : ''} Read it (its description, and the latest entries of its "## Activity"), the epic's, and the code on ${o.base} where it matters (this folder is ${o.base}'s worktree), then each of these tickets:\n${list.join('\n')}`,
    `For each, decide whether it's still right as it stands: what of it is now done on ${o.base} or in ${o.item.id}, and what of it the change contradicts or makes pointless. Change nothing that's still right.`,
    `A To Do or proposed ticket that's partly covered: bring its description up to date, to what's left to do, in its shape (${SHAPE_RULE}) Edit only its description with the Edit tool, never its title (the "# " line) or its "## Activity", and leave the rest as it is. One that's fully covered, or at odds with the change, you don't edit: the user decides whether to discard or keep it. A ticket in progress or in review (read only) you never edit: its agent is told what changed. You change no code, run no commands, and edit no other file.`,
    `Your reply is your final message, and nothing else: Flotilla reads it and writes it into the tickets for you, signed with your name. Don't write in any Activity yourself. Its shape: first one to three lines for ${o.item.id}'s Activity, on what you checked and what you found. Then one section per ticket, headed "## <id> · <finding>", where the finding is one of:\n- updated: you brought its description up to date; say what you took out or changed, and which ticket covers it.\n- covered: it's fully covered; say by what.\n- contradicts: the change is at odds with it; say how.\n- outdated: in progress or review, and something in its work may now be outdated; say what changed in ${o.item.id} and what in its work it touches, for its agent and reviewer.\n- unchanged: still right as it stands (no text needed).\nKeep each section to a few lines, with links like [src/a.ts:42](src/a.ts#L42) where they help.`,
  ].join('\n\n');
}

/** A check's reply, read: its summary for the changed ticket, and what it found for each sister. */
export interface SisterReply {
  summary: string;
  findings: Array<{ id: string; finding: SisterFinding; text: string }>;
}

/** Reads a check's reply (see sisterCheckPrompt); sections for tickets it wasn't given, or findings it doesn't know, are left out. */
export function parseSisterReply(reply: string, ids: readonly string[]): SisterReply {
  const known = new Map(ids.map((id) => [id.toUpperCase(), id]));
  const parts = reply.split(/^#{2,3}\s+(?=[A-Za-z][A-Za-z0-9]{0,9}-\d+\s*[·:—-])/m);
  const summary = parts[0].trim();
  const findings: SisterReply['findings'] = [];
  for (const part of parts.slice(1)) {
    const m = /^([A-Za-z][A-Za-z0-9]{0,9}-\d+)\s*[·:—-]\s*\**([A-Za-z]+)\**[^\n]*\n?([\s\S]*)$/.exec(part);
    const id = m && known.get(m[1].toUpperCase());
    const finding = m?.[2].toLowerCase() as SisterFinding;
    if (!id || !FINDINGS.includes(finding) || findings.some((f) => f.id === id)) continue;
    findings.push({ id, finding, text: m![3].trim() });
  }
  return { summary, findings };
}

/** The first line of a finding's text, for its row in "Needs you". */
export function verdictLine(from: string, finding: 'covered' | 'contradicts', text: string): string {
  const first = text
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[#>*\-\s]+/, ''))
    .find(Boolean);
  const head = finding === 'covered' ? `Covered by ${from}` : `At odds with ${from}'s change`;
  return first ? `${head}: ${first}` : head;
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConflictedFile } from '../../core/git/conflictRegions';

/**
 * What Flotilla does and sees, as events (BL-157): one JSON object per line in
 * `<commonDir>/flotilla/metrics/events-YYYY-MM.jsonl` of the main repository, so every worktree and window writes to
 * one place that's never committed. The metrics are counted from them. Each line is written by one append (O_APPEND):
 * two windows writing at once don't lose or mix lines. Recording never slows or breaks what it records: it isn't
 * awaited, and a failed write is logged once and dropped.
 */
export const METRICS_DIR = path.join('flotilla', 'metrics');

/** An agent's role: working on a ticket, reviewing it, resolving a merge, discussing it while it's shaped, replying, or writing an improvement review (BL-159). */
export type AgentRole = 'work' | 'review' | 'merge' | 'discuss' | 'reply' | 'improve';

/** Each kind of event, and what its `data` holds. */
export interface EventData {
  'ticket-moved': { from: string; to: string; by: string };
  'agent-started': { role: AgentRole; model?: string; effort?: string; session: string };
  'agent-resumed': { role: AgentRole; model?: string; effort?: string; session: string };
  'agent-paused': { role: AgentRole; session: string; reason: 'limit' | 'user' | 'slot'; until?: string };
  'agent-ended': { role: AgentRole; session: string; code: number | null; ok: boolean; minutes: number; tokens?: Tokens; costUsd?: number; model?: string };
  /** A ticket's review state changed (BL-158): the waits for you (asking, yours, approved, stopped) are its spans. */
  'review-state': { from?: string; to?: string };
  'review-verdict': { verdict: 'approved' | 'changes'; round: number; by: string };
  'merge-started': { into: string; branch?: string };
  'merge-conflicted': { files: ConflictFile[] };
  'merge-checks-failed': { failure: 'timeout' | 'assertion' | 'other'; tests: string[] };
  'merge-resolved': { minutes: number; by: string };
  'merge-approved': { by: string };
  'merge-landed': { into: string; commit: string };
  'merge-cancelled': { reason?: string };
  /** Merge to main stopped on CI: it failed on the branch (its failed jobs), or main moved since the branch took it in. */
  'merge-ci-stopped': { reason: 'failed' | 'moved'; branch: string; jobs?: string[] };
  'branch-conflicts': { branch: string; files: string[] };
  'limit-hit': { limit: string; until?: string; known?: boolean };
  'limit-lifted': { minutes?: number; tries?: number };
  'autopilot-idle': { reason: string };
  'click-waited': { button: string; ms: number };
  'test-run': { ms: number; waitMs: number; full: boolean; ok: boolean; slots: number };
  'demo-recorded': { name: string; frames: number; ms: number; medianGapMs?: number; p90GapMs?: number };
}

export type EventKind = keyof EventData;

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** A conflicted file of a merge: its regions, each with its lines and whether both sides only added lines there. */
export type ConflictFile = ConflictedFile;

export interface FlotillaEvent<K extends EventKind = EventKind> {
  /** When, as an ISO time. */
  at: string;
  kind: K;
  ticket?: string;
  agent?: string;
  data: EventData[K];
  /** Read in from the history (the tickets' activity and git) rather than seen as it happened. */
  imported?: true;
}

let target: { commonDir: string; log?: (line: string) => void } | undefined;
let failed = false;
/** The appends under way, for tests (and a window's end) to wait for. */
let pending: Promise<unknown> = Promise.resolve();

/** Where this window records its events: the main repository's git dir. Until it's set, nothing is recorded. */
export function setEventLog(commonDir: string | undefined, log?: (line: string) => void): void {
  target = commonDir ? { commonDir, log } : undefined;
  failed = false;
}

export function eventsDir(commonDir: string): string {
  return path.join(commonDir, METRICS_DIR);
}

/** The month's file of a time. */
export function eventsFile(commonDir: string, at: Date): string {
  const month = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
  return path.join(eventsDir(commonDir), `events-${month}.jsonl`);
}

/** Records an event, without waiting for it: a failed write is logged once (per window) and dropped. */
export function recordEvent<K extends EventKind>(kind: K, e: { ticket?: string; agent?: string; data: EventData[K]; at?: Date }): void {
  recordEventOf(kind, { ...e, data: Promise.resolve(e.data) });
}

/**
 * Records an event whose data is still being measured (BL-168): in the log, the place and at the time of the call, so
 * that eventsWritten waits for it too.
 */
export function recordEventOf<K extends EventKind>(kind: K, e: { ticket?: string; agent?: string; data: Promise<EventData[K]>; at?: Date }): void {
  const t = target;
  if (!t) return;
  const at = e.at ?? new Date();
  // One after the other, so this window's events are in the order they happened.
  pending = pending.then(() =>
    e.data
      .then((data) => {
        const event: FlotillaEvent<K> = { at: at.toISOString(), kind, ...(e.ticket ? { ticket: e.ticket } : {}), ...(e.agent ? { agent: e.agent } : {}), data };
        return appendEvents(t.commonDir, [event]);
      })
      .catch((err: unknown) => {
        if (failed) return;
        failed = true;
        t.log?.(`Flotilla couldn't record an event (${kind}); the next ones that fail aren't logged: ${err instanceof Error ? err.message : String(err)}`);
      }),
  );
}

/** Waits for the events recorded so far to be written. */
export function eventsWritten(): Promise<void> {
  return pending.then(() => undefined);
}

/** Appends events to their months' files: one write per file, each line whole (O_APPEND). */
export async function appendEvents(commonDir: string, events: readonly FlotillaEvent[]): Promise<void> {
  const byFile = new Map<string, string>();
  for (const e of events) {
    const file = eventsFile(commonDir, new Date(e.at));
    byFile.set(file, (byFile.get(file) ?? '') + `${JSON.stringify(e)}\n`);
  }
  if (!byFile.size) return;
  await fs.promises.mkdir(eventsDir(commonDir), { recursive: true });
  for (const [file, text] of byFile) await fs.promises.appendFile(file, text, { flag: 'a' });
}

/** The events of a month's file; what isn't an event (a write cut short by a crash) is skipped. */
export async function readEventsFile(file: string): Promise<FlotillaEvent[]> {
  return parseEvents(await fs.promises.readFile(file, 'utf8').catch(() => ''));
}

/** The events of lines of a month's file; what isn't an event (a write cut short by a crash) is skipped. */
export function parseEvents(text: string): FlotillaEvent[] {
  const out: FlotillaEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // A write cut short (a crash) has the next event appended to it: that one is read from where it starts.
    for (const text of [line, line.slice(Math.max(0, line.lastIndexOf('{"at":')))]) {
      try {
        const e = JSON.parse(text) as FlotillaEvent;
        if (typeof e.at === 'string' && typeof e.kind === 'string') out.push(e);
        break;
      } catch {
        // Torn: tried from the last event's start, then skipped.
      }
    }
  }
  return out;
}

/** All the events recorded, oldest month first. */
export async function readEvents(commonDir: string): Promise<FlotillaEvent[]> {
  const names = (await fs.promises.readdir(eventsDir(commonDir)).catch(() => [] as string[])).filter((n) => /^events-\d{4}-\d{2}\.jsonl$/.test(n)).sort();
  const out: FlotillaEvent[] = [];
  for (const n of names) out.push(...(await readEventsFile(path.join(eventsDir(commonDir), n))));
  return out;
}

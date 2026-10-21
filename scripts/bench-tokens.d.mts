export interface Compaction {
  /** The turns before it. */
  turn: number;
  /** The context it compacted, in tokens (Claude Code's count). */
  tokens: number;
  /** auto or manual. */
  trigger: string;
}

export interface SessionNumbers {
  session: string;
  folder: string;
  start: string;
  model: string;
  turns: number;
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  peak: number;
  readPerTurn: number;
  compactions: Compaction[];
  kinds: Record<string, { results: number; tokens: number; reread: number }>;
  role: string;
  ticket: string;
}

export function sinceTime(since: string): string | undefined;
export function sessionOf(entries: unknown[], file: string): SessionNumbers;

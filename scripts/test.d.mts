/** A run in the test queue (a file in .git/flotilla-slots/). */
export interface QueueEntry {
  pid: number;
  host: string;
  label: string;
  first: boolean;
  since: number;
  running: boolean;
}
export function slotCount(cores: number, configured: unknown): number;
export function workersFor(cores: number, n: number): number;
export function namesFiles(args: readonly string[]): boolean;
export function describeRun(toplevel: string, branch: string | undefined): { label: string; first: boolean };
export function queueOrder(a: QueueEntry, b: QueueEntry): number;
export function mayStart(entries: readonly QueueEntry[], me: QueueEntry, n: number): { go: boolean; ahead: QueueEntry[] };
export function waitingLine(ahead: readonly QueueEntry[]): string;
export function readQueue(dir: string, now?: number, alive?: (pid: number) => boolean, host?: string): QueueEntry[];
export function takeSlot(o: {
  dir: string;
  n: number;
  label: string;
  first: boolean;
  onWait?: (ahead: QueueEntry[], line: string) => void;
  pollMs?: number;
}): Promise<() => void>;

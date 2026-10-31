export interface DemoRun {
  /** record, check, play or list. */
  mode: string;
  /** The demo's name, as the command gives it. */
  name: string;
}

export function demoRuns(command: string): DemoRun[];
export function quantile(values: number[], p: number): number;
export function failureKind(e: { step?: number | null; reason?: string }): string;
export function sessionRuns(entries: unknown[], from: string, until: string): string[] | undefined;

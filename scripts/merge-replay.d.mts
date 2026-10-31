export interface ConflictPlace {
  ours: string[];
  base: string[];
  theirs: string[];
  pureAddition: boolean;
  imports: boolean;
}
export interface Landing {
  id: string;
  before: string;
  last: string;
  merged?: boolean;
}
export function conflictsOf(text: string, reversed?: boolean): ConflictPlace[];
export function replay(cwd: string, first: string, second: string, base?: string, reversed?: boolean): { name: string; places: ConflictPlace[] }[] | undefined;
export function landings(cwd: string, ref: string, since: string, until?: string): Landing[];
export function branchStart(cwd: string, id: string): string | undefined;
export function replayLanding(cwd: string, landing: Landing, start: string): { name: string; places: ConflictPlace[] }[] | undefined;
export function summarize(results: { commit: string; files?: { name: string; places: ConflictPlace[] }[] }[]): {
  merges: number;
  conflicted: number;
  places: number;
  pureAdditions: number;
  imports: number;
  mostConflicted: [string, number][];
};

export interface ConflictPlace {
  ours: string[];
  base: string[];
  theirs: string[];
  pureAddition: boolean;
  imports: boolean;
}
export function conflictsOf(text: string): ConflictPlace[];
export function replay(cwd: string, first: string, second: string): { name: string; places: ConflictPlace[] }[] | undefined;
export function summarize(results: { commit: string; files?: { name: string; places: ConflictPlace[] }[] }[]): {
  merges: number;
  conflicted: number;
  places: number;
  pureAdditions: number;
  imports: number;
  mostConflicted: [string, number][];
};

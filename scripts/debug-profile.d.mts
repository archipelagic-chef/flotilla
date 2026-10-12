export const PROFILE_DIR: string;
export const EXTENSIONS_DIR: string;
export const FAKE_GITHUB_URL: string;

export interface InstalledFolder {
  name: string;
  path: string;
  version: number[];
  specific: boolean;
}

export function extensionFolders(home?: string): string[];
export function findClaudeCode(folders: string[], platform?: string, arch?: string): InstalledFolder | undefined;
export function installClaudeCode(source: string | undefined, extensionsDir: string): string | undefined;
export function writeProfileSettings(
  profileDir: string,
  options: { root: string; fakes?: boolean },
): { on: boolean; applied: string[] };
export function syncDebugProfile(options?: {
  root?: string;
  fakes?: boolean;
  folders?: string[];
  platform?: string;
  arch?: string;
}): { profile: string; extensions: string; claudeCode: string | undefined; on: boolean; applied: string[] };
export function fakesArg(argv?: string[]): boolean | undefined;
export function describeDebugProfile(result: ReturnType<typeof syncDebugProfile>): string;

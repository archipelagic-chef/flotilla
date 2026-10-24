export const PREVIOUS_HOOK: string;
export const PRE_COMMIT_HOOK: string;
export function installPreCommit(hooksDir: string): 'installed' | 'unchanged';

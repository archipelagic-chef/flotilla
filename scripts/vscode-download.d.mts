export function mainRoot(cwd?: string): string;
export function withLock<T>(lockDir: string, fn: () => T | Promise<T>, options?: { staleMs?: number; pollMs?: number; onWait?: () => void }): Promise<T>;
export function withDownloadLock<T>(cachePath: string, fn: () => T | Promise<T>): Promise<T>;

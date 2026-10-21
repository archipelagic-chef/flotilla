export const SHIPPED: string[];
export function stagedManifest<T extends { scripts?: Record<string, string> }>(manifest: T): T & { scripts: Record<string, string> };
export function outFile(argv: readonly string[], root: string, manifest: { name: string; version: string }, cwd?: string): string;

export function ticketOfBranch(branch: string | undefined): string | undefined;
export function recordEvent(commonDir: string | undefined, kind: string, e?: { ticket?: string; agent?: string; data?: unknown; at?: Date }): boolean;

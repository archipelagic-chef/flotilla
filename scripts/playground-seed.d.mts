/** Seeds a playground repo (on main, with its first commit) with a backlog and worktrees in every state (playground-seed.mjs). */
export function seedPlayground(dir: string, now?: Date): boolean;
/** Seeds the playground's chats (an agent's, working, a panel chat, and an agent's whose process ended but shows as working) with their transcripts in claudeHome's projects; returns their paths. */
export function seedChats(dir: string, claudeHome: string, now?: Date): string[];
/** Seeds a "Creating its worktree…" record for BL-5 whose window is gone, for a Check to clear (BL-167); returns its path. */
export function seedCreating(dir: string, now?: Date): string;
/** Takes the seed's unpublished branches off the playground's origin again, for a demo that pushes one (BL-222); returns them. */
export function unpublishSeeded(dir: string): string[];
export function forgetPullRequests(dir: string): string[];
/** Appends the seeded agent chat's next turn to its transcript; false when it has none left. */
export function appendAgentTurn(dir: string, claudeHome: string, now?: Date): boolean;

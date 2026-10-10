import { withFlotillaHooks } from '../features/chats/hookInstall';

/** The `hooks` section to paste into a worktree's `.claude/settings.local.json`, for people who install by hand. */
export function claudeHookConfig(): string {
  return JSON.stringify({ hooks: withFlotillaHooks({}).hooks }, null, 2);
}

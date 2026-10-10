import { describe, expect, it } from 'vitest';
import { HOOK_EVENTS, hookCommand } from '../../../src/features/chats/hookScript';
import { claudeHookConfig } from '../../../src/ui/claudeHooks';

describe('claudeHookConfig', () => {
  it('lists the hook command for every event', () => {
    const config = JSON.parse(claudeHookConfig()) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(Object.keys(config.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    for (const event of HOOK_EVENTS) expect(config.hooks[event][0].hooks[0].command).toBe(hookCommand());
  });
});

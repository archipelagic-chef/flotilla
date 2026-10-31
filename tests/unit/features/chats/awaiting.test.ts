import {
  describe,
  expect,
  it,
} from 'vitest';
import { awaiting } from '../../../../src/features/chats/chats';

describe('what a chat waits for', () => {
  it('tells approvals from output waiting for a reply', () => {
    expect(awaiting({ open: true, state: 'waiting-for-input', message: 'Claude needs your permission to use Bash' })).toBe('approval');
    expect(awaiting({ open: true, state: 'waiting-for-input', message: 'Claude is waiting for your input' })).toBe('reply');
    // It finished its turn: its output waits for the user, before Claude Code's idle notification.
    expect(awaiting({ open: true, state: 'done', firstPrompt: 'Fix the login' })).toBe('reply');
  });

  it("counts nothing for chats that work, haven't started, or are closed", () => {
    expect(awaiting({ open: true, state: 'working', firstPrompt: 'x' })).toBeUndefined();
    expect(awaiting({ open: true, state: 'done' })).toBeUndefined();
    expect(awaiting({ open: false, state: 'waiting-for-input', message: 'Claude needs your permission to use Bash' })).toBeUndefined();
  });
});

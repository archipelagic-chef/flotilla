import {
  describe,
  expect,
  it,
} from 'vitest';
import { agentCountLabel } from '../../../src/webview/ui/agentCount';

const state = (over: object) => ({ enabled: false, running: 0, max: 3, waiting: 0, elsewhere: false, ...over });

describe('agent count in the backlog header', () => {
  it('shows the agents working and the waiting starts with the autopilot off', () => {
    expect(agentCountLabel(state({ running: 2, waiting: 1 }))).toBe('2 of 3 agents working · 1 waiting');
    expect(agentCountLabel(state({ running: 1 }))).toBe('1 of 3 agents working');
  });
  it("counts merges' agents and checks at work, which Pause All pauses too (BL-164)", () => {
    expect(agentCountLabel(state({ merging: 1 }))).toBe('0 of 3 agents working · 1 merge at work');
  });
  it('shows nothing when idle', () => {
    expect(agentCountLabel(state({}))).toBeUndefined();
    expect(agentCountLabel(undefined)).toBeUndefined();
  });
  it('shows nothing with the autopilot on: its bar says it', () => {
    expect(agentCountLabel(state({ enabled: true, running: 2 }))).toBeUndefined();
  });
});

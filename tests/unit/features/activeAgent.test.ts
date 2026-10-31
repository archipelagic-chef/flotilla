import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  agentOf,
  hasActiveAgent,
} from '../../../src/features/backlog/activeAgent';
import type {
  BacklogItemView,
  WorkstreamView,
} from '../../../src/webview/protocol';

const item = (fields: Partial<BacklogItemView> = {}) => ({ id: 'BL-1', title: 'A', status: 'doing', ...fields }) as BacklogItemView;
const worktree = (attention: string) => ({ key: 'w', attention }) as unknown as WorkstreamView;
const review = (review: unknown) => ({ review }) as Partial<BacklogItemView>;

describe('hasActiveAgent', () => {
  it('counts an agent running in the review loop', () => {
    for (const state of ['working', 'reviewing', 'revising']) expect(hasActiveAgent(item(review({ state })), [])).toBe(true);
  });

  it('counts an agent busy or waiting for input in its worktree', () => {
    expect(hasActiveAgent(item(), [worktree('working')])).toBe(true);
    expect(hasActiveAgent(item(), [worktree('waiting-for-input')])).toBe(true);
    expect(hasActiveAgent(item(), [worktree('done')])).toBe(false);
  });

  it('counts a paused agent, which goes on later', () => {
    expect(hasActiveAgent(item(review({ state: 'paused' })), [])).toBe(true);
  });

  it("doesn't count an agent the user stopped, or a ticket without one", () => {
    const stopped = item(review({ state: 'stopped', stop: { kind: 'user', agent: 'Dash-9' } }));
    expect(agentOf(stopped, [])).toBe('stopped');
    expect(hasActiveAgent(stopped, [])).toBe(false);
    expect(hasActiveAgent(item(), [])).toBe(false);
  });

  it("doesn't count proposals", () => {
    expect(hasActiveAgent(item({ proposed: {} }), [worktree('working')])).toBe(false);
  });
});

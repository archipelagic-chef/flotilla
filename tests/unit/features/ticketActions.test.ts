import { describe, expect, it } from 'vitest';
import { actionKey } from '../../../src/webview/ticketActions';

describe('actionKey', () => {
  it('tells apart the actions of one type that do different things', () => {
    expect(actionKey({ type: 'start', agent: true })).not.toBe(actionKey({ type: 'start', agent: false }));
    expect(actionKey({ type: 'openCommit', hash: 'a1' })).not.toBe(actionKey({ type: 'openCommit', hash: 'b2' }));
    expect(actionKey({ type: 'run', key: 'r1', index: 0 })).not.toBe(actionKey({ type: 'run', key: 'r1', index: 1 }));
    expect(actionKey({ type: 'userReview', verdict: 'approved', text: '' })).not.toBe(actionKey({ type: 'userReview', verdict: 'changes', text: '' }));
  });

  it('is the same for the copy the host echoes back when it is done (a structured clone of the message)', () => {
    const messages = [
      { type: 'start', agent: true },
      { type: 'openCommit', hash: 'a1' },
      { type: 'reviewFix', fix: 'retry' },
      { type: 'comment', text: 'a comment, which has text the key ignores' },
    ] as const;
    for (const m of messages) expect(actionKey(structuredClone(m) as typeof m)).toBe(actionKey(m));
  });

  it('does not depend on what a review carries (the text is written while it runs)', () => {
    expect(actionKey({ type: 'userReview', verdict: 'changes', text: 'one' })).toBe(actionKey({ type: 'userReview', verdict: 'changes', text: '' }));
  });
});

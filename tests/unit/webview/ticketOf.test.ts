import { describe, expect, it } from 'vitest';
import { ticketOf, ticketOfCommit, ticketOfComparison } from '../../../src/webview/ui/ticketOf';
import type { BacklogItemView, WorkstreamView } from '../../../src/webview/protocol';

const item = (id: string, o: Partial<BacklogItemView> = {}) => ({ id, title: `Ticket ${id}`, ...o }) as BacklogItemView;
const backlog = [item('BL-3'), item('BL-30', { branch: 'feature/thirty' }), item('PROJ-7', { source: { kind: 'jira', label: '', url: '', statusName: '' } })];
const ws = (branch: string, isMain = false) => ({ key: branch, branch, isMain }) as WorkstreamView;

describe("finding Version Control's tickets (BL-173)", () => {
  it("finds a worktree's ticket by its branch, not main's", () => {
    expect(ticketOf(ws('feature/BL-3-a-thing'), backlog)?.id).toBe('BL-3');
    expect(ticketOf(ws('feature/thirty'), backlog)?.id).toBe('BL-30');
    expect(ticketOf(ws('main', true), backlog)).toBeUndefined();
  });

  it("finds a commit's ticket by the id its message starts with, or the branch it merges", () => {
    expect(ticketOfCommit({ subject: 'BL-30: Read the change' }, backlog)?.id).toBe('BL-30');
    expect(ticketOfCommit({ subject: "Merge branch 'feature/BL-3-a-thing'" }, backlog)?.id).toBe('BL-3');
    expect(ticketOfCommit({ subject: 'Fix BL-3 elsewhere' }, backlog)).toBeUndefined();
    expect(ticketOfCommit({ subject: 'BL-99: Not in the backlog' }, backlog)).toBeUndefined();
    // An issue's (no local ticket) isn't one.
    expect(ticketOfCommit({ subject: 'PROJ-7: Theirs' }, backlog)).toBeUndefined();
  });

  it("finds a comparison's ticket: the one it was opened for, else its head branch's", () => {
    expect(ticketOfComparison({ ticket: 'BL-3', head: 'abc1234' }, backlog)?.id).toBe('BL-3');
    expect(ticketOfComparison({ head: 'feature/BL-30-x' }, backlog)?.id).toBe('BL-30');
    expect(ticketOfComparison({ head: 'main' }, backlog)).toBeUndefined();
  });
});

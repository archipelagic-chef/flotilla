import {
  describe,
  expect,
  it,
} from 'vitest';
import { backFromTicketChanges } from '../../../src/webview/ui/ticketBack';

describe('Back from an expanded file (BL-211)', () => {
  it("switches the Backlog from the ticket's Changes to its list", () => {
    expect(backFromTicketChanges({ tool: 'backlog', backlogPart: 'changes' })).toEqual({ tool: 'backlog', backlogPart: 'list' });
  });

  it("switches the Backlog from the ticket's Commits to its list (By commit, BL-213)", () => {
    expect(backFromTicketChanges({ tool: 'backlog', backlogPart: 'commits' })).toEqual({ tool: 'backlog', backlogPart: 'list' });
  });

  it('leaves the sidebar where the user moved it since', () => {
    const files = { tool: 'files', backlogPart: 'changes' } as const;
    const ci = { tool: 'backlog', backlogPart: 'ci' } as const;
    expect(backFromTicketChanges(files)).toBe(files);
    expect(backFromTicketChanges(ci)).toBe(ci);
  });
});

import { describe, expect, it } from 'vitest';
import { backFromTicketChanges } from '../../../src/webview/ui/ticketBack';

describe('Back from an expanded file (BL-211)', () => {
  it("switches the sidebar from the ticket's Changes to the Backlog", () => {
    expect(backFromTicketChanges({ tool: 'vc', vcView: 'ticketChanges' })).toEqual({ tool: 'backlog', vcView: 'ticketChanges' });
  });

  it('leaves the sidebar where the user moved it since', () => {
    const files = { tool: 'files', vcView: 'ticketChanges' } as const;
    const history = { tool: 'vc', vcView: 'history' } as const;
    expect(backFromTicketChanges(files)).toBe(files);
    expect(backFromTicketChanges(history)).toBe(history);
  });
});

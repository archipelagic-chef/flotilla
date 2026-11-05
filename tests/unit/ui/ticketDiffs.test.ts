import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const vscode = vi.hoisted(() => ({
  commands: { executeCommand: vi.fn(async () => undefined) },
  ViewColumn: { Active: -1, One: 1 },
  window: {
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    tabGroups: { all: [], onDidChangeTabs: () => ({ dispose() {} }) },
  },
  StatusBarAlignment: { Left: 1 },
}));
vi.mock('vscode', () => vscode);
const { focusTicket } = await import('../../../src/ui/backlog/ticketDiffs');

describe("a diff from a ticket's Changes opens in the ticket's place (BL-276)", () => {
  it("brings the ticket's tab to the front in its own group, and makes no group beside it", async () => {
    const panel = { active: false, viewColumn: 2, reveal: vi.fn() };
    await focusTicket(panel as never);
    expect(panel.reveal).toHaveBeenCalledWith(2, false);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('leaves the ticket as it is when it is the active tab already', async () => {
    const panel = { active: true, viewColumn: 1, reveal: vi.fn() };
    await focusTicket(panel as never);
    expect(panel.reveal).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });
});

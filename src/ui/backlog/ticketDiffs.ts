import * as vscode from 'vscode';

/** Where a diff opened from a ticket's Changes came from: the ticket, and the file (none for Open All Changes). */
export interface DiffOrigin {
  id: string;
  path?: string;
}

/** The context key that shows Back to Ticket in a diff's title bar. */
const CONTEXT = 'flotilla.ticketDiff';

/**
 * The diffs opened from tickets' Changes (BL-171), so a diff leads back to its ticket: while one is the active tab,
 * its title bar (and the status bar) has Back to Ticket, which shows the ticket at that file. A file's diff is known by its right side; the
 * multi-file diff editor (no public tab input) by its title.
 */
export class TicketDiffs implements vscode.Disposable {
  private readonly diffs = new Map<string, DiffOrigin>();
  private readonly lists = new Map<string, DiffOrigin>();
  private current: DiffOrigin | undefined;
  private readonly subscriptions: vscode.Disposable[];
  /** Back to Ticket in the status bar too, with the ticket's id: easier to see than the title bar's arrow. */
  private readonly backItem = vscode.window.createStatusBarItem('flotilla.backToTicket', vscode.StatusBarAlignment.Left, 1000);

  constructor(private readonly showTicket: (origin: DiffOrigin) => Promise<void>) {
    this.backItem.name = 'Back to Its Ticket';
    this.backItem.command = 'flotilla.backToTicket';
    this.subscriptions = [
      this.backItem,
      vscode.window.tabGroups.onDidChangeTabs((e) => {
        // A diff whose tab closed is forgotten (not one whose tab isn't there yet: it's noted as it opens).
        for (const tab of e.closed) this.forget(tab);
        this.update();
      }),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.update()),
    ];
  }

  /** Back to Ticket (flotilla.backToTicket): the ticket of the diff in the active tab, at its file. */
  async back(): Promise<void> {
    if (this.current) await this.showTicket(this.current);
  }

  /** A file's diff, opened from a ticket (modified: its right side). */
  openedDiff(modified: vscode.Uri, origin: DiffOrigin): void {
    this.diffs.set(modified.toString(), origin);
    this.update();
  }

  /** The multi-file diff editor, opened from a ticket with this title. */
  openedList(title: string, origin: DiffOrigin): void {
    this.lists.set(title, origin);
    this.update();
  }

  /** The ticket a tab's diff came from. */
  originOf(tab: vscode.Tab | undefined): DiffOrigin | undefined {
    if (!tab) return undefined;
    if (tab.input instanceof vscode.TabInputTextDiff) return this.diffs.get(tab.input.modified.toString());
    // The multi-file diff editor's tab is labeled with its title, and VS Code adds the count: "BL-3: Changes (3 files)".
    for (const [title, origin] of this.lists) if (tab.label === title || tab.label.startsWith(`${title} (`)) return origin;
    return undefined;
  }

  private forget(tab: vscode.Tab): void {
    const open = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    if (tab.input instanceof vscode.TabInputTextDiff) {
      const key = tab.input.modified.toString();
      if (!open.some((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === key)) this.diffs.delete(key);
      return;
    }
    for (const [title] of this.lists) if (tab.label === title || tab.label.startsWith(`${title} (`)) if (!open.some((t) => t.label === tab.label)) this.lists.delete(title);
  }

  private update(): void {
    const current = this.originOf(vscode.window.tabGroups.activeTabGroup.activeTab);
    if (current?.id === this.current?.id && current?.path === this.current?.path) return;
    this.current = current;
    void vscode.commands.executeCommand('setContext', CONTEXT, !!current);
    if (current) {
      this.backItem.text = `$(arrow-left) Back to ${current.id}`;
      this.backItem.tooltip = `Back to ${current.id}'s Changes${current.path ? `, at ${current.path}` : ''}`;
      this.backItem.show();
    } else this.backItem.hide();
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
  }
}

/**
 * Makes the editor group beside a ticket's (to its right) the active one, made if there's none, so that what opens
 * next opens there and the ticket stays in view.
 */
export async function focusBeside(panel: vscode.WebviewPanel): Promise<void> {
  const column = panel.viewColumn ?? vscode.ViewColumn.One;
  const right = vscode.window.tabGroups.all.find((g) => g.viewColumn === column + 1);
  if (!panel.active) panel.reveal(column, false);
  await vscode.commands.executeCommand(right ? 'workbench.action.focusRightGroup' : 'workbench.action.newGroupRight');
}

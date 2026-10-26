import * as vscode from 'vscode';
import { acceptItem, removeItem, updateItem } from '../../../features/backlog/backlog';
import { keepAttachmentsFolded, keepDemoSpeed, keepShowActivity } from '../ticketPanel';
import type { Handlers } from './context';
import type { TicketMessage } from './ticket.messages';

/** The ticket itself: its title, description, status and priority, accepting or dismissing it, and how the tab shows it. */
export const ticketHandlers: Handlers<TicketMessage> = {
  ready: async ({ id, panel, panels }) => {
    // The webview has nothing yet (or reloaded): the whole view goes again, and its Ask chat.
    panels.sentViews.delete(panel);
    if (panels.asks.has(id)) panels.postAsk(id, panel, 0);
    panels.ci?.resend(id);
  },
  title: async ({ id, item, backlog, panels }, m) => {
    const title = m.title.trim();
    if (!title || title === item.title) return;
    if (item.remote) {
      await panels.writeRemote(id, (s) => s.update(id, { title }));
      return;
    }
    await backlog.change((d) => updateItem(d, id, { title }));
    await panels.changeTicket(item, (t) => ({ ...t, title }));
  },
  description: async ({ id, item, backlog, panels }, m) => {
    if (item.remote) {
      // As the tracker writes it (Jira: wiki markup), as it was shown for editing.
      await panels.writeRemote(id, (s) => s.update(id, { description: m.text }));
      return;
    }
    {
      const before = (await backlog.readTicket(item)).description;
      await panels.changeTicket(item, (t) => ({ ...t, title: item.title, description: m.text }));
      if (before.trim() !== m.text.trim()) await backlog.noteDescriptions({ id, before, by: 'You' });
    }
  },
  showActivity: async ({ panels }, m) => {
    // Remembered for the user, and every ticket shows it the same way; no view changes.
    await keepShowActivity(panels.deps.memento, m.shown);
  },
  foldAttachments: async ({ id, panels }, m) => {
    // Remembered for this ticket; the tab already shows it.
    await keepAttachmentsFolded(panels.deps.memento, id, m.folded);
  },
  demoSpeed: async ({ panels }, m) => {
    // Remembered for the user: every ticket's demos play at it; the tab already does.
    await keepDemoSpeed(panels.deps.memento, m.speed);
  },
  status: async ({ id, backlog }, m) => {
    await backlog.change((d) => updateItem(d, id, { status: m.status }));
  },
  priority: async ({ id, backlog }, m) => {
    await backlog.change((d) => updateItem(d, id, { priority: m.priority }));
  },
  accept: async ({ id, backlog }) => {
    await backlog.change((d) => acceptItem(d, id));
  },
  dismiss: async ({ id, item, backlog }) => {
    if (!item.proposed) return;
    await backlog.change((d) => removeItem(d, id));
    await backlog.deleteDocument(id);
  },
  discard: async ({ id }) => {
    // The command asks first (as the card's Discard does).
    await vscode.commands.executeCommand('flotilla.discardBacklogItem', id);
  },
  reopen: async ({ id }) => {
    // As the card's Reopen: its ticket says which branches of its earlier work are still there (BL-210).
    await vscode.commands.executeCommand('flotilla.reopenBacklogItem', id);
  },
  openTicket: async ({ panels }, m) => {
    await panels.open(m.id);
  },
};

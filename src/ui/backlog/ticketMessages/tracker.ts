import * as vscode from 'vscode';
import { linkIssue, unlinkIssue } from '../../../features/backlog/backlog';
import type { Handlers } from './context';

/** The issue tracker (Jira, GitHub Issues): the linked issue, its workflow and priority, and creating one. */
export const trackerHandlers: Handlers = {
  openRemote: async ({ item }) => {
    if (item.remote) await vscode.env.openExternal(vscode.Uri.parse(item.remote.url));
  },
  link: async ({ id }) => {
    await vscode.commands.executeCommand('flotilla.linkBacklogItem', id);
  },
  unlink: async ({ id, backlog }, m) => {
    await backlog.change((d) => unlinkIssue(d, id, m.id));
  },
  openLink: async ({ item }, m) => {
    const link = item.links?.find((l) => l.id === m.id);
    if (link) await vscode.env.openExternal(vscode.Uri.parse(link.url));
  },
  transition: async ({ id, item, panels }, m) => {
    const move = (await panels.remoteDetails(id)).edit?.transitions.find((t) => t.id === m.id);
    if (!move || !item.remote) return;
    if (move.needs?.length) {
      // The workflow asks for more on this move (a resolution, a reviewer): that's done in the tracker.
      const open = await vscode.window.showWarningMessage(
        `"${move.name}" needs ${move.needs.join(', ')}, which Flotilla can't fill in.`,
        'Do It in the Tracker',
      );
      if (open) await vscode.env.openExternal(vscode.Uri.parse(item.remote.url));
      return;
    }
    await panels.writeRemote(id, (s) => s.transition(id, move.id));
  },
  remotePriority: async ({ id, panels }, m) => {
    await panels.writeRemote(id, (s) => s.update(id, { priority: m.name }));
  },
  createIssue: async ({ id, item, backlog, panels }) => {
    if (item.remote) return;
    const ticket = await backlog.readTicket(item);
    const link = await panels.deps.integrations.createIssue(id, item.title, ticket.description);
    if (!link) return;
    await backlog.change((d) => linkIssue(d, id, link));
    await panels.addActivity(id, 'Flotilla', `Created [${link.id}](${link.url}) and linked it.`);
  },
};

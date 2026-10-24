import * as vscode from 'vscode';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import { showError, type Commands } from '../commandSet';
import { backlogIdOf } from './cardMenu';
import { readyToMerge, type Merger } from './merge';

/** The merge queue's commands: merge a ticket (or all ready ones), take one next, push what's merged. */
export function mergeCommands(deps: { backlog: LocalBacklog; merger: Merger }): Commands {
  const { backlog, merger } = deps;
  return {
    'flotilla.mergeBacklogItem': async (arg?: unknown) => {
      let id = backlogIdOf(arg);
      if (!id) {
        const ready = (await backlog.read()).items.filter(readyToMerge);
        id = (await vscode.window.showQuickPick(ready.map((i) => ({ label: i.id, description: i.title })), { title: 'Merge a Ticket', placeHolder: ready.length ? 'Tickets ready to merge' : 'No tickets are ready to merge' }))?.label;
      }
      if (id) await merger.merge(id).catch(showError);
    },
    'flotilla.mergeAllReady': () => merger.mergeAllReady().catch(showError),
    'flotilla.mergeNext': async (arg?: unknown) => {
      const id = backlogIdOf(arg);
      if (id) await merger.mergeNext(id).catch(showError);
    },
    'flotilla.pushMerged': () => merger.push().catch(showError),
  };
}

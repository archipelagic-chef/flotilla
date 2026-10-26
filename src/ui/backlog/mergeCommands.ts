import * as vscode from 'vscode';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import { showError, type Commands } from '../commandSet';
import { backlogIdOf } from './cardMenu';
import { readyToMerge, type Merger } from './merge';

/** The merge queue's commands: merge a ticket (or all ready ones), take one next, push what's merged, stop pushing the train; and open its pull request. */
export function mergeCommands(deps: { backlog: LocalBacklog; merger: Merger }): Commands {
  const { backlog, merger } = deps;
  return {
    'flotilla.mergeBacklogItem': async (arg?: unknown) => {
      let id = backlogIdOf(arg);
      if (!id) {
        const ready = (await backlog.read()).items.filter(readyToMerge);
        id = (
          await vscode.window.showQuickPick(
            ready.map((i) => ({ label: i.id, description: i.title })),
            { title: 'Merge a Ticket', placeHolder: ready.length ? 'Tickets ready to merge' : 'No tickets are ready to merge' },
          )
        )?.label;
      }
      if (id) await merger.merge(id).catch(showError);
    },
    'flotilla.mergeAllReady': () => merger.mergeAllReady().catch(showError),
    'flotilla.mergeNext': async (arg?: unknown) => {
      const id = backlogIdOf(arg);
      if (id) await merger.mergeNext(id).catch(showError);
    },
    'flotilla.updateAndMerge': async (arg?: unknown) => {
      const id = backlogIdOf(arg);
      if (id) await merger.updateAndMerge(id).catch(showError);
    },
    'flotilla.pushMerged': () => merger.push().catch(showError),
    'flotilla.stopPushingTrain': () => merger.stopPushingTrain().catch(showError),
    // A ticket's pull request on GitHub (BL-221): a choice when its branches have several.
    'flotilla.openPullRequest': async (arg?: unknown) => {
      const id = backlogIdOf(arg);
      const prs = (await backlog.read()).items.find((i) => i.id === id)?.pullRequests ?? [];
      const pr =
        prs.length > 1
          ? (
              await vscode.window.showQuickPick(
                prs.map((p) => ({ label: `#${p.number}`, description: `${p.branch} · ${p.state}`, pr: p })),
                { title: `${id}'s Pull Requests` },
              )
            )?.pr
          : prs[0];
      if (pr) await vscode.env.openExternal(vscode.Uri.parse(pr.url));
    },
  };
}

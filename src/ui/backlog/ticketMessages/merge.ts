import * as vscode from 'vscode';
import type { TicketHostMessage } from '../../../webview/ticketProtocol';
import type { Handlers } from './context';

/** Merging: the merge, its queue and checks, pushing, merging a sibling branch, and cleaning up the history. */
export const mergeHandlers: Handlers = {
  cleanUp: async ({ id }) => {
    await vscode.commands.executeCommand('flotilla.cleanUpHistory', id);
  },
  finishCleanUp: async ({ id }) => {
    await vscode.commands.executeCommand('flotilla.finishCleanUp', id);
  },
  cancelCleanUp: async ({ id }) => {
    await vscode.commands.executeCommand('flotilla.cancelCleanUp', id);
  },
  compareCleanUp: async ({ id }) => {
    await vscode.commands.executeCommand('flotilla.compareCleanUp', id);
  },
  merge: async ({ id, panels }) => {
    await panels.merger?.merge(id);
  },
  mergeResolve: async ({ id, panels }) => {
    await panels.merger?.resolveWithAgent(id);
  },
  mergeApprove: async ({ id, panels }) => {
    await panels.merger?.approveResolution(id);
  },
  mergeRecheck: async ({ id, panels }) => {
    await panels.merger?.recheck(id);
  },
  mergeCancel: async ({ id, panels }) => {
    await panels.merger?.cancel(id);
  },
  mergePause: async ({ id, panels }) => {
    await panels.merger?.pause(id);
  },
  // A paused agent's Resolve with Agent goes on in its chat.
  mergeResume: async ({ id, panels }) => {
    await panels.merger?.resolveWithAgent(id);
  },
  mergeCiCancel: async ({ id, panels }) => {
    await panels.merger?.cancelCiWait(id);
  },
  mergeChecksStop: async ({ id, panels }) => {
    panels.merger?.stopChecks(id);
  },
  mergeChecksLog: async ({ id, panel, panels }, m) => {
    const text = (await panels.merger?.checksLog(id, m.log)) ?? '';
    void panel.webview.postMessage({ type: 'checksLog', requestId: m.requestId, text } satisfies TicketHostMessage);
  },
  mergeChecksTerminal: async ({ id, panels }, m) => {
    panels.merger?.followChecksLog(id, m.log);
  },
  mergeQueueRemove: async ({ id, panels }) => {
    await panels.merger?.removeFromQueue(id);
  },
  mergeQueueResolve: async ({ id, panels }) => {
    await panels.merger?.resolveTrainConflict(id);
  },
  mergeNext: async ({ id, panels }) => {
    await panels.merger?.mergeNext(id);
  },
  mergeCiFix: async ({ id, panels }) => {
    await panels.merger?.fixCiStop(id);
  },
  push: async ({ panels }) => {
    await panels.merger?.push();
  },
  mergeSibling: async ({ item, panels }, m) => {
    await panels.mergeSibling(item, m.branch);
  },
  dismissUnmerged: async ({ item, panels }) => {
    await panels.dismissUnmerged(item);
  },
};

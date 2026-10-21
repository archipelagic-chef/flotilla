import * as vscode from 'vscode';
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
  mergeCiCancel: async ({ id, panels }) => {
    await panels.merger?.cancelCiWait(id);
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

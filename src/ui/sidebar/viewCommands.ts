import * as vscode from 'vscode';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import {
  type JobLogProvider,
  showJobLog,
} from '../../features/ci/jobLog';
import type { BacklogIntegrations } from '../backlog/integrations';
import { newBacklogItem } from '../backlog/newItem';
import type { Commands } from '../commandSet';
import type { NeedsYouNotifier } from '../notifications';
import { SidebarProvider } from './sidebarProvider';

export interface ViewCommandDeps {
  sidebar: SidebarProvider;
  needs: NeedsYouNotifier;
  jobLogs: JobLogProvider;
  backlog: LocalBacklog;
  integrations: BacklogIntegrations;
}

/** The sidebar's commands: show it or one of its tools, fold its lists, the Needs you list, a CI job's log. */
export function viewCommands(deps: ViewCommandDeps): Commands {
  const { sidebar, needs, jobLogs, backlog, integrations } = deps;
  return {
    'flotilla.showJobLog': (arg?: unknown) => showJobLog(arg, jobLogs),
    'flotilla.showSidebar': () => vscode.commands.executeCommand(`${SidebarProvider.viewId}.focus`),
    'flotilla.showNeedsYou': () => needs.showList(),
    'flotilla.showOverview': () => sidebar.showTool('overview'),
    'flotilla.showBacklog': () => sidebar.showTool('backlog'),
    'flotilla.foldAll': () => sidebar.fold(true),
    'flotilla.unfoldAll': () => sidebar.fold(false),
    'flotilla.addBacklogItem': async () => {
      await sidebar.showTool('backlog');
      await newBacklogItem(backlog, integrations);
    },
    'flotilla.showFiles': () => sidebar.showTool('files'),
    'flotilla.showSearch': () => sidebar.showTool('search'),
    'flotilla.showVersionControl': () => sidebar.showTool('vc'),
    'flotilla.showChats': () => sidebar.showTool('chats'),
  };
}

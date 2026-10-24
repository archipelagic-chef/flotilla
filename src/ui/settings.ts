import * as vscode from 'vscode';
import { DEFAULT_STUCK_RULES, type StuckRules } from '../features/chats/activity';
import type { CiNotify } from '../features/ci/notify';
import type { RemoveFinishedMode } from '../features/storage/finished';

/** `needsYou`: one notification for what needs you, gathered for a minute; `all`: one per event; `off`: none. */
export type NotifyMode = 'needsYou' | 'all' | 'off';

export interface Settings {
  copyFiles: string[];
  setupCommand: string;
  linkFolders: string[];
  removeFinishedWorktrees: RemoveFinishedMode;
  autoAdopt: boolean;
  defaultBase: string;
  activeWindowMinutes: number;
  staleAfterDays: number;
  agentStatusStaleMinutes: number;
  notify: NotifyMode;
  pollSeconds: number;
  ciNotify: CiNotify;
}

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration('flotilla');
  return {
    copyFiles: c.get<string[]>('copyFiles', []),
    setupCommand: c.get<string>('setupCommand', ''),
    linkFolders: c.get<string[]>('linkFolders', []),
    removeFinishedWorktrees: c.get<RemoveFinishedMode>('removeFinishedWorktrees', 'auto'),
    autoAdopt: c.get<boolean>('autoAdopt', true),
    defaultBase: c.get<string>('defaultBase', ''),
    activeWindowMinutes: c.get<number>('activeWindowMinutes', 5),
    staleAfterDays: c.get<number>('staleAfterDays', 7),
    agentStatusStaleMinutes: c.get<number>('agentStatusStaleMinutes', 10),
    notify: c.get<NotifyMode>('notify', 'needsYou'),
    pollSeconds: c.get<number>('pollSeconds', 15),
    ciNotify: c.get<CiNotify>('ci.notify', 'failures'),
  };
}

/** The thresholds of the "looks stuck" warnings on working agents (BL-175). */
export function stuckRules(): StuckRules {
  const c = vscode.workspace.getConfiguration('flotilla.agents.stuck');
  const n = (key: keyof StuckRules) => Math.max(0, c.get<number>(key, DEFAULT_STUCK_RULES[key]));
  return { silentMinutes: n('silentMinutes'), repeatedFailures: n('repeatedFailures'), commandMinutes: n('commandMinutes') };
}

import * as vscode from 'vscode';
import type { CiNotify } from '../features/ci/notify';

/** `needsYou`: one notification for what needs you, gathered for a minute; `all`: one per event; `off`: none. */
export type NotifyMode = 'needsYou' | 'all' | 'off';

export interface Settings {
  copyFiles: string[];
  setupCommand: string;
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

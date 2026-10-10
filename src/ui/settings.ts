import * as vscode from 'vscode';

export interface Settings {
  copyFiles: string[];
  setupCommand: string;
  autoAdopt: boolean;
  defaultBase: string;
  activeWindowMinutes: number;
  staleAfterDays: number;
  agentStatusStaleMinutes: number;
  notifyOnAttention: boolean;
  pollSeconds: number;
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
    notifyOnAttention: c.get<boolean>('notifyOnAttention', true),
    pollSeconds: c.get<number>('pollSeconds', 15),
  };
}

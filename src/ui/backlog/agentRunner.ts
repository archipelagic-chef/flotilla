import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AGENT_EFFORTS, type AgentChoice, type AgentEffort } from '../../features/backlog/backlog';

/** How much unattended agents may do without asking (Claude Code's permission modes); they can't ask anyone. */
export type AgentPermissionMode = 'auto' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions';

/**
 * The Claude Code CLI: flotilla.agents.claudePath, else the one the Claude Code extension ships with, else `claude`
 * on the PATH.
 */
export function claudeBinary(): string {
  const configured = vscode.workspace.getConfiguration('flotilla').get<string>('agents.claudePath', '').trim();
  if (configured) return configured;
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (ext) {
    const bundled = path.join(ext.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (fs.existsSync(bundled)) return bundled;
  }
  return 'claude';
}

/**
 * The model and effort for an agent on an item: the ticket's choice, else the settings (a reviewer's own first). Unset
 * parts are Claude Code's defaults.
 */
export function agentChoice(item: { agent?: AgentChoice } | undefined, role: 'work' | 'review' = 'work'): AgentChoice {
  const config = vscode.workspace.getConfiguration('flotilla');
  const effort = (v: string | undefined) => (AGENT_EFFORTS.includes(v as AgentEffort) ? (v as AgentEffort) : undefined);
  const model = (role === 'review' ? config.get<string>('review.model', '').trim() : '') || item?.agent?.model || config.get<string>('agents.model', '').trim();
  const level =
    (role === 'review' ? effort(config.get<string>('review.effort', '')) : undefined) ?? item?.agent?.effort ?? effort(config.get<string>('agents.effort', ''));
  return { ...(model ? { model } : {}), ...(level ? { effort: level } : {}) };
}

/** A choice, for notes: " (opus, high effort)", or nothing for Claude Code's defaults. */
export function describeChoice(c: AgentChoice): string {
  const parts = [...(c.model ? [c.model] : []), ...(c.effort ? [`${c.effort} effort`] : [])];
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/** The Claude Code CLI's flags for a choice. */
export function choiceArgs(c: AgentChoice): string[] {
  return [...(c.model ? ['--model', c.model] : []), ...(c.effort ? ['--effort', c.effort] : [])];
}

/** The sessions of agents running without a window now (in this window's extension host). */
const running = new Set<string>();

export function isRunningHeadless(sessionId: string): boolean {
  return running.has(sessionId);
}

export interface AgentRun {
  /** The chat's session: new (chosen here, so it's known at once) or resumed. */
  sessionId: string;
  /** Resolves when the agent stops: its exit code, and what it wrote last on stderr when it failed. */
  done: Promise<{ code: number | null; error?: string }>;
  stop(): void;
}

/**
 * Runs an agent without a window to type in (claude -p): a new chat with prompt, or a chat resumed with it. Its chat
 * shows up in Flotilla like any other (the hooks record it) and can be opened in Claude Code afterwards.
 */
export function runAgentHeadless(o: {
  cwd: string;
  prompt: string;
  resume?: string;
  name: string;
  choice?: AgentChoice;
  output: vscode.OutputChannel;
}): AgentRun {
  const sessionId = o.resume ?? crypto.randomUUID();
  const mode = vscode.workspace.getConfiguration('flotilla').get<AgentPermissionMode>('agents.permissionMode', 'auto');
  const args = [
    '-p',
    o.prompt,
    '--output-format',
    'json',
    '--permission-mode',
    mode,
    '--name',
    o.name,
    ...choiceArgs(o.choice ?? {}),
    ...(o.resume ? ['--resume', o.resume] : ['--session-id', sessionId]),
  ];
  o.output.appendLine(
    `Starting ${o.name} in ${o.cwd} (${o.resume ? `resuming ${o.resume}` : `session ${sessionId}`}, permission mode ${mode}${o.choice?.model ? `, model ${o.choice.model}` : ''}${o.choice?.effort ? `, ${o.choice.effort} effort` : ''}).`,
  );
  const child = spawn(claudeBinary(), args, { cwd: o.cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  running.add(sessionId);
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
  child.stdout.on('data', () => undefined);
  const done = new Promise<{ code: number | null; error?: string }>((resolve) => {
    child.on('exit', () => running.delete(sessionId));
    child.on('error', (e) => {
      running.delete(sessionId);
      resolve({ code: null, error: e.message });
    });
    child.on('close', (code) => {
      o.output.appendLine(`${o.name} stopped (exit code ${code}).${stderr.trim() ? ` ${stderr.trim()}` : ''}`);
      resolve(code === 0 ? { code } : { code, error: stderr.trim() || `exit code ${code}` });
    });
  });
  return { sessionId, done, stop: () => child.kill() };
}

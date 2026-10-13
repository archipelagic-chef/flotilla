import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AGENT_EFFORTS, type AgentChoice, type AgentEffort } from '../../features/backlog/backlog';
import { parseUsageLimit, type UsageLimit } from '../../features/backlog/limits';
import { formatMemory, shortageAfterStarting } from '../../features/workstreams/memory';
import { StartingAgents } from '../../features/workstreams/startingAgents';

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

/** Memory free on this machine, in MB: what Node reports (on Linux, MemAvailable; in WSL, the VM's share of the host's). */
export function freeMemoryMB(): number {
  return os.freemem() / (1024 * 1024);
}

/** The free memory (MB) that agents need before they start: flotilla.agents.minFreeMemoryMB. */
export function minFreeMemoryMB(): number {
  return Math.max(0, vscode.workspace.getConfiguration('flotilla').get<number>('agents.minFreeMemoryMB', 2048));
}

/**
 * Too little memory free to start an agent (how much is left once the agents starting now are counted, and how much is
 * asked for); undefined when there's room.
 */
export function memoryShortage(): { freeMB: number; minMB: number } | undefined {
  return shortageAfterStarting(freeMemoryMB(), startingMemoryMB(), minFreeMemoryMB());
}

/**
 * For a manual start (the user's own click): when memory is short, says so and offers "Start Anyway". True when the
 * agent may start.
 */
export async function confirmMemory(what: string): Promise<boolean> {
  const short = memoryShortage();
  if (!short) return true;
  const choice = await vscode.window.showWarningMessage(
    `${what} waits: ${formatMemory(short.freeMB)} of memory is left once the agents starting are counted, and flotilla.agents.minFreeMemoryMB asks for ${formatMemory(short.minMB)} before an agent starts. Starting one now may run the machine out of memory.`,
    'Start Anyway',
  );
  return choice === 'Start Anyway';
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

/**
 * A model name as the CLI takes it: an alias or a model id, nothing else. The choice is read from backlog.json, which
 * agents can write: a value like "--dangerously-skip-permissions" must never reach the command line as an option.
 */
export function validModel(model: string | undefined): string | undefined {
  return model && /^[A-Za-z0-9][A-Za-z0-9._:[\]/@-]{0,99}$/.test(model) ? model : undefined;
}

/** A chat session id (a UUID), as --resume takes it; anything else is refused. */
export function validSession(id: string | undefined): string | undefined {
  return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : undefined;
}

const PERMISSION_MODES: readonly AgentPermissionMode[] = ['auto', 'acceptEdits', 'dontAsk', 'bypassPermissions'];

/** The Claude Code CLI's flags for a choice (invalid parts left out). */
export function choiceArgs(c: AgentChoice): string[] {
  const model = validModel(c.model);
  const effort = c.effort && AGENT_EFFORTS.includes(c.effort) ? c.effort : undefined;
  return [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
}

/** The text of a run's JSON result (what it said last), if it printed one. */
function resultText(stdout: string): string | undefined {
  try {
    const r = JSON.parse(stdout.trim()) as { result?: unknown };
    return typeof r.result === 'string' ? r.result.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

/** The sessions of agents running without a window now (in this window's extension host). */
const running = new Set<string>();

/** The agents started in the last minute, not running yet (in this window's extension host). */
const starting = new StartingAgents();

/** The memory the agents starting now take, in MB (counts against the free memory before they're running). */
export function startingMemoryMB(): number {
  return starting.memoryMB();
}

/**
 * Takes an agent's memory off the free memory from now, until its agent spawns (runAgentHeadless takes the slot) or the
 * start is given up (releaseStart). Call it where the memory check passes, before the first await, so another start
 * checked meanwhile sees it.
 */
export function reserveStart(): number {
  return starting.reserve();
}

/** Gives a reserved slot back (a start given up before its agent spawned). Harmless when it's already given back. */
export function releaseStart(slot: number | undefined): void {
  if (slot !== undefined) starting.end(slot);
}

export function isRunningHeadless(sessionId: string): boolean {
  return running.has(sessionId);
}

export interface AgentResult {
  code: number | null;
  error?: string;
  /** It stopped on Claude's usage (or rate) limit: when to go on. */
  limit?: UsageLimit;
}

export interface AgentRun {
  /** The chat's session: new (chosen here, so it's known at once) or resumed. */
  sessionId: string;
  /** Resolves when the agent stops: its exit code, what it wrote last when it failed, and a usage limit it hit. */
  done: Promise<AgentResult>;
  stop(): void;
}

/** The claude -p arguments of a run: its prompt, output, permission mode, name, choice and chat (new or resumed). */
export function headlessArgs(o: {
  prompt: string;
  name: string;
  choice?: AgentChoice;
  resume?: string;
  sessionId: string;
  mode: AgentPermissionMode;
  tools?: string[];
}): string[] {
  return [
    '-p',
    o.prompt,
    '--output-format',
    'json',
    '--permission-mode',
    o.mode,
    '--name',
    o.name,
    ...choiceArgs(o.choice ?? {}),
    ...(o.resume ? ['--resume', o.resume] : ['--session-id', o.sessionId]),
    // Last: the lists are variadic, so no flag may follow them. --tools takes the tools' names, so Bash and the rest
    // are not there at all; --allowedTools lets the listed ones run (with a rule's path, when it has one).
    ...(o.tools?.length ? ['--tools', [...new Set(o.tools.map((t) => t.replace(/\(.*$/, '')))].join(','), '--allowedTools', ...o.tools] : []),
  ];
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
  /** The start's reserved slot (see reserveStart); without one, the start counts from now. */
  slot?: number;
  /** Only these tools, and no other: the run asks no one, so anything else is refused (see headlessArgs). */
  tools?: string[];
}): AgentRun {
  // Session ids come from backlog.json too (agents can write it): only a real one is resumed.
  if (o.resume !== undefined && !validSession(o.resume)) {
    releaseStart(o.slot);
    throw new Error(`Not a chat session id: ${o.resume.slice(0, 60)}`);
  }
  const sessionId = o.resume ?? crypto.randomUUID();
  const configured = vscode.workspace.getConfiguration('flotilla').get<string>('agents.permissionMode', 'auto');
  const configuredMode: AgentPermissionMode = PERMISSION_MODES.includes(configured as AgentPermissionMode) ? (configured as AgentPermissionMode) : 'auto';
  // With a tool list, what isn't on it is refused, not asked about: that's the list's whole point.
  const mode: AgentPermissionMode = o.tools ? 'dontAsk' : configuredMode;
  const args = headlessArgs({ prompt: o.prompt, name: o.name, choice: o.choice, resume: o.resume, sessionId, mode, tools: o.tools });
  o.output.appendLine(
    `Starting ${o.name} in ${o.cwd} (${o.resume ? `resuming ${o.resume}` : `session ${sessionId}`}, permission mode ${mode}${o.choice?.model ? `, model ${o.choice.model}` : ''}${o.choice?.effort ? `, ${o.choice.effort} effort` : ''}).`,
  );
  const child = spawn(claudeBinary(), args, { cwd: o.cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  running.add(sessionId);
  const start = o.slot ?? starting.begin();
  if (o.slot !== undefined) starting.spawned(o.slot);
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
  child.stdout.on('data', (d: Buffer) => (stdout = (stdout + d.toString()).slice(-8000)));
  const done = new Promise<AgentResult>((resolve) => {
    child.on('exit', () => {
      running.delete(sessionId);
      starting.end(start);
    });
    child.on('error', (e) => {
      running.delete(sessionId);
      starting.end(start);
      resolve({ code: null, error: e.message });
    });
    child.on('close', (code) => {
      o.output.appendLine(`${o.name} stopped (exit code ${code}).${stderr.trim() ? ` ${stderr.trim()}` : ''}`);
      // A run that failed (or whose result is an error) may have hit a limit: it goes on when that resets.
      const failed = code !== 0 || /"is_error"\s*:\s*true/.test(stdout);
      const limit = failed ? parseUsageLimit(`${stdout}\n${stderr}`, new Date()) : undefined;
      if (limit) o.output.appendLine(`${o.name} hit a ${limit.kind} limit; it goes on at ${limit.until.toLocaleString()}.`);
      resolve(code === 0 && !limit ? { code } : { code, error: stderr.trim() || resultText(stdout) || `exit code ${code}`, ...(limit ? { limit } : {}) });
    });
  });
  return { sessionId, done, stop: () => child.kill() };
}

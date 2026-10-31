import {
  type ChildProcessWithoutNullStreams,
  spawn,
} from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  AGENT_EFFORTS,
  type AgentChoice,
  type AgentEffort,
} from '../../features/backlog/backlog';
import {
  type Levels,
  lightNote,
  moveUpTarget,
  reviewModel,
  weaker,
  workModel,
} from '../../features/backlog/modelLevel';
import {
  parseUsageLimit,
  type UsageLimit,
} from '../../features/backlog/limits';
import { accountLimit } from '../../features/backlog/accountLimit';
import {
  LEAN_TOOLS,
  leanFlags,
  settingsFileOf,
  userPlugins,
  writeAgentSettings,
  writeOnce,
} from '../../features/backlog/leanStart';
import { askArgs } from '../../features/backlog/ask';
import { discussArgs } from '../../features/backlog/discussChat';
import {
  SUMMARY_MODEL,
  summaryAnswer,
  summaryArgs,
  summaryInput,
} from '../../features/chats/summary';
import { guardScript } from '../../features/backlog/agentGuard';
import {
  formatMemory,
  shortageAfterStarting,
} from '../../features/workstreams/memory';
import { StartingAgents } from '../../features/workstreams/startingAgents';
import {
  type AgentRole,
  recordEvent,
  type Tokens,
} from '../../features/metrics/events';
import {
  finishChatRecords,
  transcriptPath,
} from '../../features/chats/chats';
import { transcriptUsage } from '../../features/metrics/transcriptUsage';
import { locateRepo } from '../../core/repoLocator';

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
 * Folders every agent may reach besides its worktree: the backlog's, where its ticket is (BL-89). With Claude Code's
 * permissions.blockReadsOutsideWorkingDirectories on, an agent can't read or write its ticket otherwise.
 */
let agentDirs: string[] = [];
export function setAgentDirs(dirs: readonly string[]): void {
  agentDirs = [...dirs];
}

/** Where Flotilla writes its agents' settings files and guard script. */
const AGENT_FILES = path.join(os.tmpdir(), 'flotilla');

/**
 * How an agent on model (in cwd) starts, to keep what it re-reads on every turn small; undefined when nothing applies.
 * - flotilla.agents.lean (default on): no skills, plugins and MCP servers, and only the coding tools (LEAN_TOOLS): a
 *   quarter of a new agent's context (BL-68).
 * - flotilla.agents.autoCompactWindow: it compacts its context sooner (BL-72).
 * - flotilla.agents.subagentModel: its subagents, which search and report back, run on a cheaper model, never a
 *   stronger one than its own (BL-77).
 * - flotilla.agents.guardOutput: large file reads and diffs are refused, with how to look instead (BL-75).
 * The last three go in a settings file (--settings), with the plugins the lean start switches off. Every agent also
 * gets the backlog's folder as a working directory (--add-dir, see setAgentDirs).
 */
export function agentStart(cwd: string, model?: string): { flags: string[]; tools?: string[] } | undefined {
  const config = vscode.workspace.getConfiguration('flotilla');
  const lean = config.get<boolean>('agents.lean', true);
  const window = config.get<number>('agents.autoCompactWindow', 200000);
  const sub = validModel(config.get<string>('agents.subagentModel', 'sonnet').trim());
  const guardOn = config.get<boolean>('agents.guardOutput', true);
  let settings: string | undefined;
  try {
    settings = writeAgentSettings({
      cwd,
      configDir: process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'),
      outDir: AGENT_FILES,
      lean,
      ...(window > 0 ? { autoCompactWindow: Math.min(1_000_000, Math.max(100_000, window)) } : {}),
      ...(sub && !weaker(model, sub) ? { subagentModel: sub } : {}),
      ...(guardOn ? { guardCommand: guardCommand() } : {}),
    });
  } catch {
    // Started without them: the rest still applies.
  }
  // --add-dir takes several folders: the flags that follow it end them.
  const flags = [...(lean ? leanFlags(settings) : settings ? ['--settings', settings] : []), ...(agentDirs.length ? ['--add-dir', ...agentDirs] : [])];
  return flags.length || lean ? { flags, ...(lean ? { tools: [...LEAN_TOOLS] } : {}) } : undefined;
}

/** The guard hook's command: node runs its script (written once per version of it). */
function guardCommand(): string {
  const script = writeOnce(AGENT_FILES, 'flotilla-guard', 'js', guardScript(GUARD_LINES, GUARD_DIFF_LINES));
  return `node "${script.replace(/\\/g, '/')}"`;
}

/** The guard's limits: files over this many lines are read in parts, diffs over this many changed lines by file first. */
const GUARD_LINES = 400;
const GUARD_DIFF_LINES = 600;

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
  const levels = modelLevels();
  const model =
    role === 'review' ? reviewModel(item?.agent, { ...levels, review: config.get<string>('review.model', '').trim() }) : workModel(item?.agent, levels);
  const level =
    (role === 'review' ? effort(config.get<string>('review.effort', '')) : undefined) ?? item?.agent?.effort ?? effort(config.get<string>('agents.effort', ''));
  return { ...(model ? { model } : {}), ...(level ? { effort: level } : {}) };
}

/** The strong model (flotilla.agents.model) and the light one (flotilla.agents.lightModel; empty: no ticket is light). */
export function modelLevels(): Levels {
  const config = vscode.workspace.getConfiguration('flotilla');
  const strong = validModel(config.get<string>('agents.model', '').trim());
  const light = validModel(config.get<string>('agents.lightModel', '').trim());
  return { ...(strong ? { strong } : {}), ...(light ? { light } : {}) };
}

/** What an agent on a ticket's work is told about its model: on a lighter one, how to ask for the strong one. */
export function levelNote(item: { agent?: AgentChoice } | undefined): string | undefined {
  const move = moveUpTarget(item?.agent, modelLevels());
  return move && lightNote(move.from, move.to);
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

/** The text of a run's JSON result (what it said last, in full), if it printed one. */
export function resultOf(stdout: string): string | undefined {
  try {
    const r = JSON.parse(stdout.trim()) as { result?: unknown };
    return typeof r.result === 'string' ? r.result : undefined;
  } catch {
    return undefined;
  }
}

/** What a run's JSON result says it used: its tokens and cost. */
export function runUsage(stdout: string): { tokens?: Tokens; costUsd?: number } {
  try {
    const r = JSON.parse(stdout.trim()) as { total_cost_usd?: unknown; usage?: Record<string, unknown> };
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const u = r.usage;
    return {
      ...(u
        ? {
            tokens: {
              input: n(u.input_tokens),
              output: n(u.output_tokens),
              cacheRead: n(u.cache_read_input_tokens),
              cacheCreation: n(u.cache_creation_input_tokens),
            },
          }
        : {}),
      ...(typeof r.total_cost_usd === 'number' ? { costUsd: r.total_cost_usd } : {}),
    };
  } catch {
    return {};
  }
}

/** The start of a run's result, for a note about a failed run. */
function resultText(stdout: string): string | undefined {
  return resultOf(stdout)?.slice(0, 300);
}

/** The agents running without a window now (in this window's extension host): their names, by session. */
const running = new Map<string, string>();

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

/**
 * What a finished run says, from its exit code and output (stdout is its JSON result). A run that exits 0 but whose
 * result is an error failed too, and a usage limit it hit is an outcome of its own (it goes on when that resets).
 */
export function agentOutcome(o: { code: number | null; stdout: string; stderr: string; now: Date }): AgentResult {
  const failed = o.code !== 0 || /"is_error"\s*:\s*true/.test(o.stdout);
  if (!failed) return { code: o.code, reply: resultOf(o.stdout) };
  const limit = parseUsageLimit(`${o.stdout}\n${o.stderr}`, o.now);
  return { code: o.code, error: o.stderr.trim() || resultText(o.stdout) || `exit code ${o.code}`, ...(limit ? { limit } : {}) };
}

export function isRunningHeadless(sessionId: string): boolean {
  return running.has(sessionId);
}

/** How many agents this window runs now, without a window and in its terminals: reloading it stops them. */
export function runningAgentCount(): number {
  return runningAgentNames().length;
}

/** The names of the agents running in this window: without one, then in terminals. */
export function runningAgentNames(): string[] {
  return [...running.values(), ...[...terminals.values()].filter((t) => t.exitStatus === undefined).map((t) => t.name)];
}

/** Whose run an agent's is, for its events: its ticket, its agent name and its role. */
export interface AgentTrack {
  ticket?: string;
  agent: string;
  role: AgentRole;
}

/** Agents running in a terminal this window opened, by session: they're stopped by ending the terminal's process. */
const terminals = new Map<string, vscode.Terminal>();

/**
 * Starts an interactive Claude Code session in a terminal (in cwd): a new chat with prompt (its session chosen here, so
 * it's known at once), or a chat resumed with it.
 */
export function runAgentInTerminal(o: {
  cwd: string;
  prompt: string;
  resume?: string;
  name: string;
  choice?: AgentChoice;
  /** Records its start and end as events (BL-168), as a run without a window does. */
  track?: AgentTrack;
}): { sessionId: string; terminal: vscode.Terminal } {
  if (o.resume !== undefined && !validSession(o.resume)) throw new Error(`Not a chat session id: ${o.resume.slice(0, 60)}`);
  const sessionId = o.resume ?? crypto.randomUUID();
  // A lean start's tool list takes several values: the --name after it ends it, before the prompt.
  const lean = agentStart(o.cwd, o.choice?.model);
  const terminal = vscode.window.createTerminal({
    name: o.name,
    cwd: o.cwd,
    shellPath: claudeBinary(),
    shellArgs: [
      ...choiceArgs(o.choice ?? {}),
      ...(lean ? [...lean.flags, ...(lean.tools ? ['--tools', lean.tools.join(',')] : [])] : []),
      ...(o.resume ? ['--resume', o.resume] : ['--session-id', sessionId]),
      '--name',
      o.name,
      // Resumed without a prompt, it waits for one.
      ...(o.prompt ? [o.prompt] : []),
    ],
    iconPath: new vscode.ThemeIcon('hubot'),
  });
  terminals.set(sessionId, terminal);
  if (o.track) {
    const data = {
      role: o.track.role,
      session: sessionId,
      ...(o.choice?.model ? { model: o.choice.model } : {}),
      ...(o.choice?.effort ? { effort: o.choice.effort } : {}),
    };
    recordEvent(o.resume ? 'agent-resumed' : 'agent-started', { ticket: o.track.ticket, agent: o.track.agent, data });
    terminalRuns.set(sessionId, { track: o.track, cwd: o.cwd, started: new Date(), terminal, model: o.choice?.model });
  }
  terminal.show();
  return { sessionId, terminal };
}

/** The tracked runs in terminals (BL-168), by session, until their end is recorded. */
const terminalRuns = new Map<string, { track: AgentTrack; cwd: string; started: Date; terminal: vscode.Terminal; model?: string }>();

/**
 * Records a tracked terminal run's end, once: its exit code (none when it's unknown), and its tokens and model from its
 * transcript (a terminal gives no JSON result, and no cost). home: Claude's, for tests.
 */
export async function endTerminalRun(sessionId: string, code: number | null, home?: string): Promise<void> {
  const run = terminalRuns.get(sessionId);
  if (!run) return;
  terminalRuns.delete(sessionId);
  const minutes = Math.round((Date.now() - run.started.getTime()) / 600) / 100;
  const usage = await transcriptUsage(transcriptPath(run.cwd, sessionId, home), run.started).catch(() => ({}) as { tokens?: Tokens; model?: string });
  const model = run.model ?? usage.model;
  recordEvent('agent-ended', {
    ticket: run.track.ticket,
    agent: run.track.agent,
    data: {
      role: run.track.role,
      session: sessionId,
      code,
      ok: code === 0,
      minutes,
      ...(usage.tokens ? { tokens: usage.tokens } : {}),
      ...(model ? { model } : {}),
    },
  });
}

/** Forgets terminals that were closed, and records the end of the tracked runs in them. */
export function trackTerminals(): vscode.Disposable {
  return vscode.window.onDidCloseTerminal((t) => {
    for (const [session, terminal] of terminals) if (terminal === t) terminals.delete(session);
    for (const [session, run] of terminalRuns) if (run.terminal === t) void endTerminalRun(session, t.exitStatus?.code ?? null);
  });
}

/** Whether a chat runs in a terminal of this window (its process not ended). */
export function isRunningInTerminal(sessionId: string): boolean {
  const t = terminals.get(sessionId);
  return !!t && t.exitStatus === undefined;
}

/**
 * Whether an agent's session works here now: without a window, or in a terminal of this window. The one test the
 * review loop's count (the autopilot's agents) and a ticket's Check share (BL-201): such a session is working, whatever
 * its chat's record, a pause or an end says.
 */
export function isWorkingHere(sessionId: string): boolean {
  return isRunningHeadless(sessionId) || isRunningInTerminal(sessionId);
}

/**
 * Ends the process of an agent's terminal (the terminal stays, and says the process ended; its chat is kept). False if
 * it doesn't run in a terminal of this window.
 */
export async function stopTerminalAgent(sessionId: string): Promise<boolean> {
  const t = terminals.get(sessionId);
  terminals.delete(sessionId);
  // Stopped: its terminal may stay open, so its end is recorded now.
  void endTerminalRun(sessionId, t?.exitStatus?.code ?? null);
  if (!t || t.exitStatus !== undefined) return false;
  const pid = await t.processId;
  try {
    if (pid === undefined) throw new Error('no process');
    process.kill(pid);
  } catch {
    t.dispose();
  }
  return true;
}

export interface AgentResult {
  code: number | null;
  error?: string;
  /** It stopped on Claude's usage (or rate) limit: when to go on. */
  limit?: UsageLimit;
  /** What the agent wrote last, when it finished without an error (its final message). */
  reply?: string;
}

export interface AgentRun {
  /** The chat's session: new (chosen here, so it's known at once) or resumed. */
  sessionId: string;
  /** Resolves when the agent stops: its exit code, its last message if it finished, what it wrote last when it failed, and a usage limit it hit. */
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
  /** Tools offered besides the list's, allowed only by its rules (Write, allowed where an Edit(path) rule says). */
  offer?: string[];
  /** How it starts (agentStart): its flags, and the tools offered when there's no tools list. */
  lean?: { flags: string[]; tools?: string[] };
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
    ...(o.lean?.flags ?? []),
    ...(o.resume ? ['--resume', o.resume] : ['--session-id', o.sessionId]),
    // Last: the lists are variadic, so no flag may follow them. --tools takes the tools' names, so Bash and the rest
    // are not there at all; --allowedTools lets the listed ones run (with a rule's path, when it has one).
    ...(o.tools?.length
      ? ['--tools', [...new Set([...o.tools.map((t) => t.replace(/\(.*$/, '')), ...(o.offer ?? [])])].join(','), '--allowedTools', ...o.tools]
      : o.lean?.tools
        ? ['--tools', o.lean.tools.join(',')]
        : []),
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
  /** Tools offered besides those, allowed only by the tools' rules (see headlessArgs). */
  offer?: string[];
  /** What the run is, for its events (BL-157): its ticket, agent and role. */
  track?: AgentTrack;
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
  const lean = agentStart(o.cwd, o.choice?.model);
  const args = headlessArgs({ prompt: o.prompt, name: o.name, choice: o.choice, resume: o.resume, sessionId, mode, tools: o.tools, offer: o.offer, lean });
  // A missing one shows: the agent then starts without Flotilla's settings (BL-85).
  const settingsFile = settingsFileOf(lean?.flags ?? []);
  o.output.appendLine(
    `Starting ${o.name} in ${o.cwd} (${o.resume ? `resuming ${o.resume}` : `session ${sessionId}`}, permission mode ${mode}${o.choice?.model ? `, model ${o.choice.model}` : ''}${o.choice?.effort ? `, ${o.choice.effort} effort` : ''}${lean?.tools ? ', lean start' : ''}, ${settingsFile ? `settings ${settingsFile}` : 'no settings file'}).`,
  );
  const child = spawn(claudeBinary(), args, { cwd: o.cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  running.set(sessionId, o.name);
  const spawnedAt = Date.now();
  const track = o.track;
  const who = { ticket: track?.ticket, agent: track?.agent };
  if (track) {
    const data = {
      role: track.role,
      session: sessionId,
      ...(o.choice?.model ? { model: o.choice.model } : {}),
      ...(o.choice?.effort ? { effort: o.choice.effort } : {}),
    };
    recordEvent(o.resume ? 'agent-resumed' : 'agent-started', { ...who, data });
  }
  const start = o.slot ?? starting.begin();
  if (o.slot !== undefined) starting.spawned(o.slot);
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
  // The whole JSON result is kept (a reply is read from it), up to a cap that a result this long won't reach.
  child.stdout.on('data', (d: Buffer) => (stdout = (stdout + d.toString()).slice(-1_000_000)));
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
      // Its chat is done now, even when the hooks' last word was "working" (BL-131).
      void locateRepo(o.cwd)
        .then((repo) => repo && finishChatRecords(repo.commonDir, sessionId))
        .catch(() => undefined);
      const result = agentOutcome({ code, stdout, stderr, now: new Date() });
      // The account's limit (BL-248): a reset said holds every start; a run begun since that got through lifts it.
      if (result.limit) accountLimit.hit(result.limit);
      else if (!result.error) accountLimit.gotThrough(spawnedAt);
      if (result.limit)
        o.output.appendLine(
          `${o.name} hit a ${result.limit.kind} limit; it goes on at ${result.limit.until.toLocaleString()}.${result.limit.said ? ` Claude said: ${result.limit.said} (reset time not understood).` : ''}`,
        );
      if (track) {
        const role = track.role;
        if (result.limit) {
          const until = result.limit.until.toISOString();
          recordEvent('limit-hit', { ...who, data: { limit: result.limit.kind, until, known: result.limit.known } });
          recordEvent('agent-paused', { ...who, data: { role, session: sessionId, reason: 'limit', until } });
        } else {
          const minutes = Math.round((Date.now() - spawnedAt) / 600) / 100;
          recordEvent('agent-ended', {
            ...who,
            data: { role, session: sessionId, code, ok: !result.error, minutes, ...runUsage(stdout), ...(o.choice?.model ? { model: o.choice.model } : {}) },
          });
        }
      }
      resolve(result);
    });
  });
  return { sessionId, done, stop: () => child.kill() };
}

/**
 * Whether Claude takes work again after a limit, asked without touching the agent's chat: a one-line question that
 * keeps no session, runs no hooks (no chat for Flotilla to record), and has no tools. The limit it still hits, or undefined
 * when it got through (or failed otherwise: the resumed chat then says why).
 */
export function probeLimit(o: { choice?: AgentChoice; output: vscode.OutputChannel }): Promise<UsageLimit | undefined> {
  const args = [
    '-p',
    'Reply with just: OK',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--max-turns',
    '1',
    '--settings',
    JSON.stringify({ disableAllHooks: true }),
    // A few hundred tokens instead of Claude Code's whole prompt, tools and servers.
    '--system-prompt',
    'Reply with just: OK',
    '--tools',
    '',
    '--strict-mcp-config',
    ...choiceArgs({ model: o.choice?.model }),
  ];
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(claudeBinary(), args, { cwd: os.tmpdir(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.stdout.on('data', (d: Buffer) => (out = (out + d.toString()).slice(-4000)));
    child.stderr.on('data', (d: Buffer) => (out = (out + d.toString()).slice(-4000)));
    child.on('error', () => (clearTimeout(timer), resolve(undefined)));
    child.on('close', (code) => {
      clearTimeout(timer);
      const failed = code !== 0 || /"is_error"\s*:\s*true/.test(out);
      const limit = failed ? parseUsageLimit(out, new Date()) : undefined;
      if (limit) accountLimit.hit(limit);
      else if (!failed) accountLimit.lift();
      o.output.appendLine(
        limit
          ? `Claude is still limited (${limit.kind}).${limit.said ? ` Claude said: ${limit.said}` : ''}`
          : `Claude takes work again${failed ? ` (the check failed otherwise: exit code ${code})` : ''}.`,
      );
      resolve(limit);
    });
  });
}

/** The transcript's end read for a summary (BL-180): enough for its last calls and messages. */
const SUMMARY_TAIL_BYTES = 512 * 1024;

/**
 * Summarizes a working agent's status (BL-180): its transcript's last part to a small model (flotilla.agents.lightModel,
 * else Haiku), in one short request that keeps no session and has no tools or hooks. Its two lines, or why it failed.
 */
export async function summarizeAgent(transcript: string, o: { output: vscode.OutputChannel }): Promise<{ text: string } | { error: string }> {
  const handle = await fs.promises.open(transcript, 'r');
  let tail: string;
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - SUMMARY_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    tail = buffer.toString('utf8');
  } finally {
    await handle.close();
  }
  const input = summaryInput(tail.split('\n'));
  if (!input) return { error: 'Nothing in its transcript to summarize yet.' };
  const model = modelLevels().light ?? SUMMARY_MODEL;
  o.output.appendLine(`Summarize: ${transcript} (model ${model}, ${input.length} characters).`);
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(claudeBinary(), summaryArgs(model), { cwd: os.tmpdir(), env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', (e) => (clearTimeout(timer), resolve({ error: e.message })));
    child.on('close', (code) => {
      clearTimeout(timer);
      const answer = summaryAnswer(out);
      if ('error' in answer) o.output.appendLine(`Summarize failed (exit code ${code}): ${answer.error}`);
      resolve(answer);
    });
    child.stdin.end(`The agent's transcript, its last part:\n\n${input}`);
  });
}

/** The model a ticket's Ask chat answers with: flotilla.ask.model (an alias or a model id). */
export function askModel(): string {
  return validModel(vscode.workspace.getConfiguration('flotilla').get<string>('ask.model', 'sonnet').trim()) ?? 'sonnet';
}

/**
 * Starts a ticket's Ask process in cwd (BL-80, see askArgs): lean, read-only, nothing kept, and no hooks, so it isn't
 * recorded as a chat. It isn't one of the running agents (flotilla.agents.maxRunning), but its memory counts against
 * the free memory for its first minute, like an agent's.
 */
export function spawnAsk(cwd: string, o: { instructions: string; output: vscode.OutputChannel; ticket?: string }): ChildProcessWithoutNullStreams {
  let plugins: string[] = [];
  try {
    plugins = userPlugins(cwd, process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'));
  } catch {
    // Started with them.
  }
  const model = askModel();
  o.output.appendLine(`Ask: starting in ${cwd} (model ${model}).`);
  const child = spawn(claudeBinary(), askArgs({ model, instructions: o.instructions, plugins }), {
    cwd,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const slot = starting.begin();
  child.on('exit', () => starting.end(slot));
  child.on('error', () => starting.end(slot));
  trackAsk(child, { ticket: o.ticket, model });
  return child;
}

/**
 * Starts a ticket's discussion process in cwd (BL-241, see discussArgs): its session new or resumed, the ticket the only
 * file it may change, and no hooks (it isn't listed as a chat). Like Ask, it isn't one of the running agents
 * (flotilla.agents.maxRunning), but its memory counts against the free memory for its first minute.
 */
export function spawnDiscussion(
  cwd: string,
  o: {
    instructions: string;
    session: string;
    resume: boolean;
    tools: readonly string[];
    choice?: AgentChoice;
    output: vscode.OutputChannel;
    ticket: string;
    agent: string;
  },
): ChildProcessWithoutNullStreams {
  if (!validSession(o.session)) throw new Error(`Not a chat session id: ${o.session.slice(0, 60)}`);
  let plugins: string[] = [];
  try {
    plugins = userPlugins(cwd, process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'));
  } catch {
    // Started with them.
  }
  const model = validModel(o.choice?.model);
  o.output.appendLine(
    `Discussion of ${o.ticket}: ${o.agent} ${o.resume ? `resuming ${o.session}` : `in session ${o.session}`} in ${cwd}${model ? ` (model ${model})` : ''}.`,
  );
  const args = discussArgs({ choice: choiceArgs(o.choice ?? {}), instructions: o.instructions, plugins, session: o.session, resume: o.resume, tools: o.tools });
  const child = spawn(claudeBinary(), args, { cwd, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const slot = starting.begin();
  child.on('exit', () => starting.end(slot));
  child.on('error', () => starting.end(slot));
  trackAsk(child, { ticket: o.ticket, model, agent: o.agent, role: 'discuss', session: o.session, resumed: o.resume });
  return child;
}

/**
 * Records an Ask process's start and end (BL-168), as the agent "Ask" in the role reply. Its tokens and cost are its
 * last result's: a result counts the whole process so far. It keeps no session: the event's is made up here. A
 * discussion's (BL-241) is recorded the same way, as its agent, its role and its session.
 */
export function trackAsk(
  child: Pick<ChildProcessWithoutNullStreams, 'stdout' | 'on'>,
  o: { ticket?: string; model?: string; agent?: string; role?: AgentRole; session?: string; resumed?: boolean },
): void {
  const who = { ticket: o.ticket, agent: o.agent ?? 'Ask' };
  const session = o.session ?? crypto.randomUUID();
  const role = o.role ?? 'reply';
  const startedAt = Date.now();
  recordEvent(o.resumed ? 'agent-resumed' : 'agent-started', { ...who, data: { role, session, ...(o.model ? { model: o.model } : {}) } });
  let rest = '';
  let last = '';
  child.stdout.on('data', (d: Buffer) => {
    const lines = (rest + d.toString()).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) if (line.includes('"type":"result"')) last = line;
  });
  let ended = false;
  const end = (code: number | null) => {
    if (ended) return;
    ended = true;
    const minutes = Math.round((Date.now() - startedAt) / 600) / 100;
    recordEvent('agent-ended', {
      ...who,
      data: { role, session, code, ok: code === 0, minutes, ...runUsage(last), ...(o.model ? { model: o.model } : {}) },
    });
  };
  child.on('error', () => end(null));
  child.on('close', (code: number | null) => end(code));
}

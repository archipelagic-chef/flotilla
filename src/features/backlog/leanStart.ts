import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The tools an agent gets with a lean start: what coding takes (subagents to explore, the web for documentation).
 * Every tool's definition is part of the context the agent re-reads on each turn.
 */
export const LEAN_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Agent', 'TodoWrite', 'WebFetch', 'WebSearch'] as const;

/** The plugins these Claude Code settings files enable, later files overriding earlier ones (user, project, local). */
export function enabledPlugins(settingsTexts: ReadonlyArray<string | undefined>): string[] {
  const enabled = new Map<string, boolean>();
  for (const text of settingsTexts) {
    if (!text) continue;
    let settings: unknown;
    try {
      settings = JSON.parse(text);
    } catch {
      continue;
    }
    const plugins = (settings as { enabledPlugins?: unknown })?.enabledPlugins;
    if (!plugins || typeof plugins !== 'object') continue;
    for (const [id, on] of Object.entries(plugins)) if (typeof on === 'boolean') enabled.set(id, on);
  }
  return [...enabled].filter(([, on]) => on).map(([id]) => id).sort();
}

/**
 * The flags of a lean start, before the tool list: no skills, no MCP servers, and (through a settings file) none of
 * the plugins the user enabled. The user's own Claude Code sessions keep all of them.
 */
export function leanFlags(settingsFile: string | undefined): string[] {
  return ['--disable-slash-commands', '--strict-mcp-config', ...(settingsFile ? ['--settings', settingsFile] : [])];
}

const read = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

/** What an agent's settings file sets, beyond the user's own settings. */
export interface AgentSettings {
  /** A lean start: the plugins enabled for it are switched off. */
  lean?: boolean;
  /** The context size Claude Code compacts against (its autoCompactWindow, BL-72). */
  autoCompactWindow?: number;
  /** The model its subagents run (CLAUDE_CODE_SUBAGENT_MODEL, BL-77). */
  subagentModel?: string;
  /** The command of a PreToolUse hook that keeps large outputs out of its context (BL-75). */
  guardCommand?: string;
}

/** The settings file's content, or undefined when it sets nothing. */
export function agentSettingsText(plugins: readonly string[], s: AgentSettings): string | undefined {
  const settings = {
    ...(s.lean && plugins.length ? { enabledPlugins: Object.fromEntries(plugins.map((id) => [id, false])) } : {}),
    ...(s.autoCompactWindow ? { autoCompactWindow: s.autoCompactWindow } : {}),
    ...(s.subagentModel ? { env: { CLAUDE_CODE_SUBAGENT_MODEL: s.subagentModel } } : {}),
    ...(s.guardCommand ? { hooks: { PreToolUse: [{ matcher: 'Read|Bash', hooks: [{ type: 'command', command: s.guardCommand, timeout: 15 }] }] } } : {}),
  };
  return Object.keys(settings).length ? `${JSON.stringify(settings, null, 1)}
` : undefined;
}

/**
 * Writes the settings file for an agent in cwd into outDir (see AgentSettings; the plugins are those enabled by the
 * user's settings in configDir, or the project's) and returns its path, or undefined when it would set nothing. The
 * same settings give the same file, so it's written once.
 */
export function writeAgentSettings(o: { cwd: string; configDir: string; outDir: string } & AgentSettings): string | undefined {
  const plugins = o.lean
    ? enabledPlugins([
        read(path.join(o.configDir, 'settings.json')),
        read(path.join(o.cwd, '.claude', 'settings.json')),
        read(path.join(o.cwd, '.claude', 'settings.local.json')),
      ])
    : [];
  const text = agentSettingsText(plugins, o);
  if (!text) return undefined;
  return writeOnce(o.outDir, 'flotilla-agent', 'json', text);
}

/** Writes text into outDir under a name from its hash (once: the same text gives the same file); returns the path. */
export function writeOnce(outDir: string, prefix: string, ext: string, text: string): string {
  const file = path.join(outDir, `${prefix}-${crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)}.${ext}`);
  if (read(file) !== text) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(file, text);
  }
  return file;
}

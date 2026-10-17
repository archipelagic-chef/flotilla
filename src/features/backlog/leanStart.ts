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

/**
 * Writes the settings file that switches off the plugins enabled for an agent in cwd (by the user's settings in
 * configDir, or the project's), into outDir; returns its path, or undefined when no plugin is enabled. The same
 * plugins give the same file, so it's written once.
 */
export function writeLeanSettings(o: { cwd: string; configDir: string; outDir: string }): string | undefined {
  const plugins = enabledPlugins([
    read(path.join(o.configDir, 'settings.json')),
    read(path.join(o.cwd, '.claude', 'settings.json')),
    read(path.join(o.cwd, '.claude', 'settings.local.json')),
  ]);
  if (!plugins.length) return undefined;
  const text = `${JSON.stringify({ enabledPlugins: Object.fromEntries(plugins.map((id) => [id, false])) }, null, 1)}\n`;
  const file = path.join(o.outDir, `flotilla-lean-${crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)}.json`);
  if (read(file) !== text) {
    fs.mkdirSync(o.outDir, { recursive: true });
    fs.writeFileSync(file, text);
  }
  return file;
}

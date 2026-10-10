import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ensureExcludeLine } from '../../core/git/exclude';
import { HOOK_EVENTS, HOOK_MARKER, hookCommand } from './hookScript';

export const SETTINGS_FILE = path.join('.claude', 'settings.local.json');

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
}
type Settings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

/** Flotilla's own hooks, current or from earlier versions (which wrote workstream.json). */
function isOurs(command: string | undefined): boolean {
  return typeof command === 'string' && (command.includes(HOOK_MARKER) || command.includes('workstream.json'));
}

/** Returns settings with Flotilla's hooks (re)installed; every other setting and hook is kept. */
export function withFlotillaHooks(settings: Settings, command = hookCommand()): Settings {
  const hooks: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    const kept = (Array.isArray(entries) ? entries : [])
      .map((entry) => ({ ...entry, hooks: (entry.hooks ?? []).filter((h) => !isOurs(h.command)) }))
      .filter((entry) => entry.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
  }
  for (const event of HOOK_EVENTS) {
    hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: 'command', command }] }];
  }
  return { ...settings, hooks };
}

export function hasCurrentHooks(settings: Settings, command = hookCommand()): boolean {
  return HOOK_EVENTS.every((event) => settings.hooks?.[event]?.some((entry) => entry.hooks?.some((h) => h.command === command)));
}

async function readSettings(file: string): Promise<Settings> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return {};
  }
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${file} does not contain a JSON object.`);
  return parsed as Settings;
}

export async function hooksInstalled(worktreeRoot: string): Promise<boolean> {
  try {
    return hasCurrentHooks(await readSettings(path.join(worktreeRoot, SETTINGS_FILE)));
  } catch {
    return false;
  }
}

/**
 * Installs the hooks into the worktree's `.claude/settings.local.json` (per checkout, so every worktree needs its own)
 * and keeps that file out of git. Throws, without writing, when the existing file is not valid JSON.
 */
export async function installHooks(worktreeRoot: string, commonDir: string): Promise<'installed' | 'unchanged'> {
  const file = path.join(worktreeRoot, SETTINGS_FILE);
  const settings = await readSettings(file);
  await ensureExcludeLine(commonDir, '.claude/settings.local.json', ['.claude/settings.local.json', '/.claude/settings.local.json']);
  if (hasCurrentHooks(settings)) return 'unchanged';
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(withFlotillaHooks(settings), null, 2)}\n`);
  return 'installed';
}

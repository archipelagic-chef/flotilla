import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ensureExcludeLine } from '../../core/git/exclude';
import { HOOK_EVENTS, HOOK_FILE, HOOK_MARKER, hookCommand, hookFileContent } from './hookScript';

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

async function hookFileIsCurrent(worktreeRoot: string): Promise<boolean> {
  try {
    return (await fs.readFile(path.join(worktreeRoot, HOOK_FILE), 'utf8')) === hookFileContent();
  } catch {
    return false;
  }
}

/** Whether Flotilla's hooks were ever installed in a worktree (current or not): the user agreed to them there. */
export async function hooksPresent(worktreeRoot: string): Promise<boolean> {
  try {
    await fs.access(path.join(worktreeRoot, HOOK_FILE));
    return true;
  } catch {
    try {
      return Object.values((await readSettings(path.join(worktreeRoot, SETTINGS_FILE))).hooks ?? {}).some((entries) =>
        (Array.isArray(entries) ? entries : []).some((e) => e.hooks?.some((h) => isOurs(h.command))),
      );
    } catch {
      return false;
    }
  }
}

export async function hooksInstalled(worktreeRoot: string): Promise<boolean> {
  try {
    return hasCurrentHooks(await readSettings(path.join(worktreeRoot, SETTINGS_FILE))) && (await hookFileIsCurrent(worktreeRoot));
  } catch {
    return false;
  }
}

/**
 * Installs the hooks: the hook script as `.claude/flotilla-hook.js`, and the commands that run it in the worktree's
 * `.claude/settings.local.json` (per checkout, so every worktree needs its own). Both are kept out of git. Throws,
 * without writing, when the existing settings file is not valid JSON.
 */
export async function installHooks(worktreeRoot: string, commonDir: string): Promise<'installed' | 'unchanged'> {
  const file = path.join(worktreeRoot, SETTINGS_FILE);
  const settings = await readSettings(file);
  await ensureExcludeLine(commonDir, '.claude/settings.local.json', ['.claude/settings.local.json', '/.claude/settings.local.json']);
  await ensureExcludeLine(commonDir, `/${HOOK_FILE}`, [HOOK_FILE, `/${HOOK_FILE}`]);
  const scriptCurrent = await hookFileIsCurrent(worktreeRoot);
  if (hasCurrentHooks(settings) && scriptCurrent) return 'unchanged';
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (!scriptCurrent) await fs.writeFile(path.join(worktreeRoot, HOOK_FILE), hookFileContent());
  if (!hasCurrentHooks(settings)) await fs.writeFile(file, `${JSON.stringify(withFlotillaHooks(settings), null, 2)}\n`);
  return 'installed';
}

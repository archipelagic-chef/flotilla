/**
 * Whether a newer Flotilla is installed than the one this window runs (BL-85). VS Code installs an update next to the
 * running one (`<publisher>.<name>-<version>` in the extensions folder) and only switches to it when the window
 * reloads; until then every agent it starts comes up the old way. Pure: the caller lists the folder and stats files.
 */

/** A newer install: its version, or the same version built again (reinstalled over the running one). */
export type NewerInstall = { kind: 'version'; version: string } | { kind: 'build' };

/** The version in an extension folder's name ("archipelagic.flotilla-0.2.0", "…-0.2.0-win32-x64"), if it's this extension's. */
export function folderVersion(folder: string, id: string): string | undefined {
  const prefix = `${id.toLowerCase()}-`;
  if (!folder.toLowerCase().startsWith(prefix)) return undefined;
  const m = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/.exec(folder.slice(prefix.length).replace(/-(?:win32|linux|darwin|alpine|web)-[a-z0-9]+$/, ''));
  return m?.[1];
}

/** Compares two versions by their numbers (1.10.0 after 1.9.0); a pre-release comes before its release. */
export function compareVersions(a: string, b: string): number {
  const [an, ap] = split(a);
  const [bn, bp] = split(b);
  for (let i = 0; i < 3; i++) if (an[i] !== bn[i]) return an[i] - bn[i];
  if (ap === bp) return 0;
  if (!ap) return 1;
  if (!bp) return -1;
  return ap < bp ? -1 : 1;
}

function split(v: string): [number[], string] {
  const [nums, ...pre] = v.split('-');
  const n = nums.split('.').map((x) => Number.parseInt(x, 10) || 0);
  return [[n[0] ?? 0, n[1] ?? 0, n[2] ?? 0], pre.join('-')];
}

/**
 * What's installed beyond what runs: the highest version among the extension folders that isn't being removed
 * (VS Code lists those in the extensions folder's `.obsolete`), or the running folder's main file changed since the
 * window started it. Undefined when the window runs what's installed.
 */
export function newerInstall(o: {
  id: string;
  running: string;
  folders: readonly string[];
  obsolete: ReadonlySet<string>;
  /** The main file's modification time when the window started it, and now (undefined: it's gone). */
  builtAt: number;
  builtNow: number | undefined;
}): NewerInstall | undefined {
  let newest: string | undefined;
  for (const f of o.folders) {
    if (o.obsolete.has(f)) continue;
    const v = folderVersion(f, o.id);
    if (v && compareVersions(v, o.running) > 0 && (!newest || compareVersions(v, newest) > 0)) newest = v;
  }
  if (newest) return { kind: 'version', version: newest };
  return o.builtNow !== undefined && o.builtNow !== o.builtAt ? { kind: 'build' } : undefined;
}

/** The folders VS Code is to remove, from its `.obsolete` file ({ "<folder>": true }); none when it's unreadable. */
export function obsoleteFolders(text: string | undefined): Set<string> {
  if (!text) return new Set();
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return new Set();
    return new Set(Object.entries(parsed as Record<string, unknown>).filter(([, v]) => v === true).map(([k]) => k));
  } catch {
    return new Set();
  }
}

/** What's installed, said in a sentence ("Flotilla 0.2.0 is installed, but this window still runs 0.1.0"). */
export function describeNewer(newer: NewerInstall, running: string): string {
  return newer.kind === 'version'
    ? `Flotilla ${newer.version} is installed, but this window still runs ${running}`
    : `Flotilla ${running} was installed again, but this window still runs the build it started with`;
}

/** The notification: what's installed, and what reloading does to the agents running in this window. */
export function newerMessage(newer: NewerInstall, running: string, agents: number): string {
  const stops = agents === 0 ? '' : ` Reloading stops the ${agents === 1 ? 'agent' : `${agents} agents`} running in this window (${agents === 1 ? 'its chat is' : 'their chats are'} kept to resume).`;
  return `${describeNewer(newer, running)}: agents start the old way until you reload the window.${stops}`;
}

/** Added to the autopilot's notes of agents it starts or resumes while the window runs an older Flotilla. */
export function staleStartNote(newer: NewerInstall, running: string): string {
  return ` (${describeNewer(newer, running)}: the agent starts the old way until you reload the window.)`;
}

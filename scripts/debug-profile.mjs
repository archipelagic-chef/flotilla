// The debug window's own profile, so a debug session never changes the user's VS Code: its settings, secret storage and
// global state live in .vscode-test/debug-profile, and its extensions in .vscode-test/debug-extensions. That folder holds
// only a copy of Claude Code (chats need it), so the installed Flotilla doesn't run next to the one being debugged.
// The launch configurations run this on every F5, through scripts/playground.mjs or the pre-launch task.
//
//   npm run debug-profile -- --fakes     the debug window uses the fake Claude and the fake GitHub
//   npm run debug-profile -- --no-fakes  the real ones (the default)
//   npm run debug-profile                keeps the last choice
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROFILE_DIR = path.join('.vscode-test', 'debug-profile');
export const EXTENSIONS_DIR = path.join('.vscode-test', 'debug-extensions');
/** The address scripts/fake-github.mjs listens on by default. */
export const FAKE_GITHUB_URL = 'http://127.0.0.1:4010';
const CLAUDE_EXTENSION = 'anthropic.claude-code';
const FAKE_KEYS = ['flotilla.agents.claudePath', 'flotilla.dev.githubApi'];

/** Where VS Code keeps installed extensions: desktop, dev container, Insiders. */
export function extensionFolders(home = os.homedir()) {
  return ['.vscode-server', '.vscode', '.vscode-insiders', '.vscode-server-insiders'].map((dir) => path.join(home, dir, 'extensions'));
}

/** The newest installed Claude Code for this platform (its folder name is `anthropic.claude-code-<version>[-<platform>]`). */
export function findClaudeCode(folders, platform = process.platform, arch = process.arch) {
  const wanted = `${platform}-${arch}`;
  const found = [];
  for (const folder of folders) {
    let names = [];
    try {
      names = fs.readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(name);
      if (!match || (match[4] && match[4] !== wanted)) continue;
      const version = match.slice(1, 4).map(Number);
      found.push({ name, path: path.join(folder, name), version, specific: Boolean(match[4]) });
    }
  }
  found.sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1] || b.version[2] - a.version[2] || Number(b.specific) - Number(a.specific));
  return found[0];
}

/**
 * Puts Claude Code (or nothing, when it isn't installed) in the debug extensions, and removes any other copy there, so
 * a removed or updated Claude Code doesn't linger. Returns the folder name it installed.
 */
export function installClaudeCode(source, extensionsDir) {
  fs.mkdirSync(extensionsDir, { recursive: true });
  const name = source ? path.basename(source) : undefined;
  if (source) {
    const dest = path.join(extensionsDir, name);
    if (!fs.existsSync(path.join(dest, 'package.json'))) {
      // Copied under a temporary name and renamed when whole, so an interrupted copy isn't taken for a finished one.
      const partial = `${dest}.partial`;
      fs.rmSync(partial, { recursive: true, force: true });
      fs.cpSync(source, partial, { recursive: true });
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(partial, dest);
    }
  }
  for (const other of fs.readdirSync(extensionsDir)) {
    if (other.startsWith(`${CLAUDE_EXTENSION}-`) && other !== name) fs.rmSync(path.join(extensionsDir, other), { recursive: true, force: true });
  }
  return name;
}

/**
 * The profile's settings: {} when there are none, undefined when the file isn't plain JSON. VS Code allows comments in
 * settings, so such a file is left as it is rather than rewritten (which would drop them).
 */
function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Not plain JSON: reported by the caller.
  }
  return undefined;
}

/**
 * Writes the profile's settings, keeping the ones this doesn't manage. With fakes on, Flotilla's Claude and GitHub point
 * at the fakes (for each fake file that exists); off, they're removed. `fakes` undefined keeps the last choice. A file
 * that isn't plain JSON is left alone.
 */
export function writeProfileSettings(profileDir, { root, fakes }) {
  const file = path.join(profileDir, 'User', 'settings.json');
  const settings = readSettings(file);
  if (!settings) return { on: false, applied: [], unreadable: true };
  const on = fakes ?? FAKE_KEYS.some((key) => key in settings);
  for (const key of FAKE_KEYS) delete settings[key];
  const applied = [];
  if (on) {
    const claude = path.join(root, 'scripts', 'fake-claude.mjs');
    const github = path.join(root, 'scripts', 'fake-github.mjs');
    if (fs.existsSync(claude)) {
      settings['flotilla.agents.claudePath'] = claude;
      applied.push('fake Claude');
    }
    if (fs.existsSync(github)) {
      settings['flotilla.dev.githubApi'] = FAKE_GITHUB_URL;
      applied.push('fake GitHub');
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { on, applied, unreadable: false };
}

/** Makes the debug profile ready. `root` is the project folder; the rest is for tests. */
export function syncDebugProfile({ root = process.cwd(), fakes, folders, platform, arch } = {}) {
  const extensionsDir = path.resolve(root, EXTENSIONS_DIR);
  const claude = findClaudeCode(folders ?? extensionFolders(), platform, arch);
  const claudeCode = installClaudeCode(claude?.path, extensionsDir);
  const settings = writeProfileSettings(path.resolve(root, PROFILE_DIR), { root: path.resolve(root), fakes });
  return { profile: PROFILE_DIR, extensions: EXTENSIONS_DIR, claudeCode, ...settings };
}

/** `--fakes` or `--no-fakes` from the command line; undefined when neither is given. */
export function fakesArg(argv = process.argv.slice(2)) {
  if (argv.includes('--fakes')) return true;
  if (argv.includes('--no-fakes')) return false;
  return undefined;
}

/** What the log says about the debug profile, in a few lines. */
export function describeDebugProfile(result) {
  const claude = result.claudeCode ? `Claude Code (${result.claudeCode}) is in ${result.extensions}` : 'no Claude Code found to copy: chats will not start in the debug window';
  let fakes = 'fakes off';
  if (result.unreadable) fakes = "settings.json isn't plain JSON, so it was left as it is and the fakes weren't changed";
  else if (result.on) fakes = `fakes on${result.applied.length ? `: ${result.applied.join(', ')}` : ' (no fake files in scripts/ yet, so the real ones are used)'}`;
  return [`Debug profile: ${result.profile} (its own settings, secrets and state)`, `Debug extensions: ${claude}`, `Debug window: ${fakes}`].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = syncDebugProfile({ fakes: fakesArg() });
  console.log(describeDebugProfile(result));
}

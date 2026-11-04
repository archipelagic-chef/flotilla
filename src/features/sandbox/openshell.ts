import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  networkPolicy,
  type RuleError,
  type SecurityPolicy,
} from './policy';

/**
 * Agents in NVIDIA OpenShell sandboxes (BL-270): the commands that start one in its worktree's sandbox, stop it and
 * remove the sandbox. OpenShell's CLI is only ever called from here, so the policy, audit and approval tickets (BL-271,
 * BL-272, BL-273) build on the same calls.
 *
 * A start runs a launcher script (launcherScript) that checks the CLI and the gateway, makes the Claude provider and
 * the sandbox when they're missing, and then runs claude in the sandbox with `openshell sandbox exec`. Any failure ends
 * the start with a "Flotilla: …" line on stderr: an agent never falls back to running unsandboxed.
 */

/** Where Claude keeps its config in a sandbox: only this worktree's transcripts are bound into it from the host. */
export const SANDBOX_CLAUDE_DIR = '/sandbox/.claude';

/** The OpenShell provider that hands Claude's login to sandboxes (OpenShell's credential placeholders). */
export const PROVIDER = 'flotilla-claude';

/** The exit code of a start the launcher refused (OpenShell missing, its gateway down, the sandbox failed). */
export const LAUNCH_FAILED = 125;

/** A host folder the sandbox reaches, at the same path. */
export interface Mount {
  path: string;
  readOnly?: boolean;
  /** Where it is in the sandbox when not at the same path. */
  target?: string;
}

/**
 * The sandbox of the agents working in cwd: named after its folder (a ticket's worktree is named after the ticket), with
 * a hash of the whole path so two checkouts never share one. Lower case, at most 63 characters (a DNS label).
 */
export function sandboxName(cwd: string): string {
  const base = path
    .basename(path.resolve(cwd))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^flotilla-/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  const hash = crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 6);
  return `flotilla-${base || 'repo'}-${hash}`;
}

/**
 * The git dir and common dir of the checkout at cwd, when they're outside it (a linked worktree's `.git` file points to
 * them): the hooks write their records there, and commits go there.
 */
export function gitDirsOf(cwd: string): string[] {
  const dotGit = path.join(cwd, '.git');
  let text: string;
  try {
    if (fs.statSync(dotGit).isDirectory()) return [];
    text = fs.readFileSync(dotGit, 'utf8');
  } catch {
    return [];
  }
  const m = /^gitdir:\s*(.+)$/m.exec(text);
  if (!m) return [];
  const gitDir = path.resolve(cwd, m[1].trim());
  let common: string | undefined;
  try {
    common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
  } catch {
    // A git dir without a commondir file is its own.
  }
  return [...new Set([gitDir, ...(common ? [common] : [])])].filter((d) => !inside(d, cwd));
}

/**
 * What a sandbox for cwd reaches: cwd, the agents' other folders (the backlog's), the git dirs, Flotilla's agent files
 * (read only), and cwd's transcript folder, at Claude's config dir in the sandbox. A folder inside another is left out.
 */
export function sandboxMounts(o: { cwd: string; dirs: readonly string[]; gitDirs: readonly string[]; agentFiles: string; transcripts?: string }): Mount[] {
  const rw = [o.cwd, ...o.dirs, ...o.gitDirs].map((d) => path.resolve(d));
  const kept = rw.filter((d, i) => rw.indexOf(d) === i && !rw.some((other, j) => j !== i && other !== d && inside(d, other)));
  return [
    ...kept.map((p) => ({ path: p })),
    { path: path.resolve(o.agentFiles), readOnly: true },
    ...(o.transcripts ? [{ path: o.transcripts, target: path.posix.join(SANDBOX_CLAUDE_DIR, 'projects', path.basename(o.transcripts)) }] : []),
  ];
}

/** OpenShell's Docker driver config binding the mounts in (the gateway must allow bind mounts). */
export function driverConfig(mounts: readonly Mount[]): string {
  return JSON.stringify({
    docker: { mounts: mounts.map((m) => ({ type: 'bind', source: m.path, target: m.target ?? m.path, read_only: !!m.readOnly })) },
  });
}

/**
 * The launcher: started with FLOTILLA_SANDBOX* in its environment (the sandbox's name first) and `sandbox exec`'s
 * arguments. It says what failed, and how to fix it, on stderr, and exits with LAUNCH_FAILED.
 */
export function launcherScript(): string {
  return `#!/bin/sh
# Flotilla's OpenShell launcher (BL-270): starts an agent in its worktree's sandbox, never outside one.
n="$FLOTILLA_SANDBOX"
fail() { echo "Flotilla: $1" >&2; exit ${LAUNCH_FAILED}; }
command -v openshell >/dev/null 2>&1 || fail "OpenShell's CLI (openshell) isn't on the PATH, so the agent didn't start. Install it (https://github.com/NVIDIA/OpenShell), or set flotilla.agents.sandbox to none."
openshell status >/dev/null 2>&1 || fail "OpenShell's gateway isn't running, so the agent didn't start. Start it with: openshell gateway start"
if ! openshell provider get "$FLOTILLA_SANDBOX_PROVIDER" >/dev/null 2>&1; then
  if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then cred="--credential CLAUDE_CODE_OAUTH_TOKEN"; else cred="--from-existing"; fi
  err=$(openshell provider create --name "$FLOTILLA_SANDBOX_PROVIDER" --type claude-code $cred 2>&1 >/dev/null) || fail "OpenShell couldn't make the provider $FLOTILLA_SANDBOX_PROVIDER for Claude's login: $err. Set ANTHROPIC_API_KEY, or CLAUDE_CODE_OAUTH_TOKEN (claude setup-token), where VS Code starts."
fi
ready() { openshell sandbox exec -n "$n" --no-tty -- true </dev/null >/dev/null 2>&1; }
create() {
  if [ -n "$FLOTILLA_SANDBOX_FROM" ]; then set -- --from "$FLOTILLA_SANDBOX_FROM"; else set --; fi
  openshell sandbox create --name "$n" --detach --no-bootstrap --provider "$FLOTILLA_SANDBOX_PROVIDER" --policy "$FLOTILLA_SANDBOX_POLICY" --driver-config-json "$FLOTILLA_SANDBOX_MOUNTS" "$@" -- sleep infinity </dev/null 2>&1 >/dev/null
}
if ! ready; then
  openshell sandbox delete "$n" >/dev/null 2>&1
  err=$(create) || fail "OpenShell couldn't create the sandbox $n: $err. Its gateway must allow bind mounts: [openshell.drivers.docker] enable_bind_mounts = true in gateway.toml, then restart it."
  i=0
  until ready; do
    i=$((i + 1))
    [ "$i" -ge 120 ] && fail "The sandbox $n didn't get ready in two minutes (openshell sandbox get $n says why)."
    sleep 1
  done
  openshell sandbox exec -n "$n" --no-tty -- sh -c 'command -v claude && command -v node && command -v git' </dev/null >/dev/null 2>&1 || fail "The sandbox $n has no claude, node or git: set flotilla.agents.sandboxImage to an image with all three."
fi
exec openshell sandbox exec -n "$n" "$@"
`;
}

/** Writes the launcher into dir (once per version of it); returns its path. */
export function writeLauncher(dir: string): string {
  const text = launcherScript();
  const file = path.join(dir, `flotilla-openshell-${crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)}.sh`);
  try {
    if (fs.readFileSync(file, 'utf8') === text) return file;
  } catch {
    // Not written yet.
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o755 });
  return file;
}

/** A start in a sandbox: the command to run on the host, its arguments and what to add to its environment. */
export interface SandboxedCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  sandbox: string;
}

/**
 * The host command that runs `claude args` in cwd's sandbox: the launcher, given the sandbox (name, mounts, policy,
 * image) in its environment, and `sandbox exec`'s arguments: the working directory, a terminal or none, Claude's config
 * dir and the git identity. claude is the image's: the host's binary may not run there.
 */
export function sandboxedCommand(o: {
  launcher: string;
  args: readonly string[];
  /** The working directory in the sandbox (mounted at the same path), or the sandbox's own. */
  cwd: string;
  name: string;
  mounts: readonly Mount[];
  policyFile: string;
  tty?: boolean;
  image?: string;
  identity?: { name?: string; email?: string };
}): SandboxedCommand {
  const id = o.identity ?? {};
  const env = [
    `CLAUDE_CONFIG_DIR=${SANDBOX_CLAUDE_DIR}`,
    ...(id.name ? [`GIT_AUTHOR_NAME=${id.name}`, `GIT_COMMITTER_NAME=${id.name}`] : []),
    ...(id.email ? [`GIT_AUTHOR_EMAIL=${id.email}`, `GIT_COMMITTER_EMAIL=${id.email}`] : []),
  ];
  return {
    command: o.launcher,
    args: ['--workdir', o.cwd, o.tty ? '--tty' : '--no-tty', ...env.flatMap((e) => ['--env', e]), '--', 'claude', ...o.args],
    env: {
      FLOTILLA_SANDBOX: o.name,
      FLOTILLA_SANDBOX_PROVIDER: PROVIDER,
      FLOTILLA_SANDBOX_POLICY: o.policyFile,
      FLOTILLA_SANDBOX_MOUNTS: driverConfig(o.mounts),
      FLOTILLA_SANDBOX_FROM: o.image ?? '',
    },
    sandbox: o.name,
  };
}

/** `openshell` arguments that end a session's claude in its sandbox (Stop): its session id is on its command line. */
export function stopArgs(name: string, sessionId: string): string[] {
  return ['sandbox', 'exec', '-n', name, '--no-tty', '--', 'pkill', '-f', '--', sessionId];
}

/** `openshell` arguments that remove a sandbox. */
export function deleteArgs(name: string): string[] {
  return ['sandbox', 'delete', name];
}

/**
 * `openshell` arguments that load a policy into a running sandbox (BL-271): OpenShell reloads its network rules at
 * once. It exits 0 when it's loaded, 1 when OpenShell refused the policy.
 */
export function policySetArgs(name: string, policyFile: string): string[] {
  return ['policy', 'set', name, '--policy', policyFile, '--wait'];
}

/** The exit code of a `policy set` OpenShell refused (its validation failed). */
export const POLICY_REFUSED = 1;

/** Runs openshell and waits: its exit code (-1 when it couldn't start) and what it wrote. */
export function runOpenshell(args: string[], timeoutMs = 60_000): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn('openshell', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    } catch (error) {
      resolve({ code: -1, output: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
    child.on('error', (error) => resolve({ code: -1, output: error.message }));
    child.on('close', (code) => resolve({ code: code ?? -1, output: output.trim() }));
  });
}

/** `openshell` arguments that say whether a sandbox is there (exit 0). */
export function sandboxGetArgs(name: string): string[] {
  return ['sandbox', 'get', name];
}

/** The rule OpenShell's refusal names (a host, a command), else the network rules as a whole. */
export function refusedRule(p: SecurityPolicy, output: string, sandbox: string): RuleError {
  const message = `OpenShell refused the policy (sandbox ${sandbox}): ${output || 'no reason given'}`;
  const host = p.network.findIndex((r) => r.host.trim() && output.includes(r.host.trim()));
  if (host >= 0) return { section: 'network', index: host, message };
  const command = p.commands.findIndex((r) => r.path.trim() && output.includes(r.path.trim()));
  if (command >= 0) return { section: 'commands', index: command, message };
  return { section: 'network', index: -1, message };
}

/**
 * Loads p's network rules into the sandboxes that are there, one after the other, and stops at the first that OpenShell
 * refuses: so the first running sandbox checks the policy before it's saved. Sandboxes that aren't there (or no
 * OpenShell) are skipped: they get the policy when they're made.
 */
export async function applyNetworkPolicy(
  p: SecurityPolicy,
  names: readonly string[],
  file: string,
  run: (args: string[]) => Promise<{ code: number; output: string }> = runOpenshell,
  /** Each sandbox's policy, when it isn't p: p with the rules Allow once loaded into it (BL-273). */
  policyOf: (name: string) => SecurityPolicy = () => p,
): Promise<{ applied: string[]; error?: RuleError }> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const applied: string[] = [];
  for (const name of names) {
    if ((await run(sandboxGetArgs(name))).code !== 0) continue;
    const own = policyOf(name);
    fs.writeFileSync(file, networkPolicy(own));
    const result = await run(policySetArgs(name, file));
    if (result.code === 0) applied.push(name);
    else if (result.code === POLICY_REFUSED) return { applied, error: refusedRule(own, result.output, name) };
  }
  return { applied };
}

/** `openshell` arguments that print a sandbox's log (BL-272): the gateway keeps its last 2,000 lines. */
export function logsArgs(name: string): string[] {
  return ['logs', name, '--source', 'sandbox'];
}

/**
 * A sandbox's log, as `openshell logs` prints it: what it printed in timeoutMs, should it go on streaming. Undefined
 * without OpenShell, or when it fails (no such sandbox, no gateway).
 */
export function readLogs(name: string, timeoutMs = 15_000): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('openshell', logsArgs(name), { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(out);
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 || out ? out : undefined);
    });
  });
}

/** Runs openshell in the background, for what may fail unseen (no sandbox, no OpenShell). */
export function runQuietly(args: string[]): void {
  try {
    const child = spawn('openshell', args, { stdio: 'ignore', detached: false });
    child.on('error', () => undefined);
  } catch {
    // No OpenShell: nothing to end or remove.
  }
}

/** Whether p is inside (or is) dir. */
function inside(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

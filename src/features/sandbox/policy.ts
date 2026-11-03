import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Mount } from './openshell';

/**
 * The security policy sandboxed agents run under (BL-271): what the user sets in the Security panel, kept in VS Code's
 * storage (outside every folder a sandbox mounts), and the OpenShell policy made of it for each sandbox.
 *
 * Files are Landlock's (filesystem_policy): set when a sandbox is made, so they apply at an agent's next start. Network
 * hosts and the commands that may reach them are one network_policies entry, which OpenShell reloads in a running
 * sandbox (`openshell policy set`), so they apply at once. OpenShell has no list of the commands a sandbox may run: a
 * command rule says which programs may use the network.
 */

export type FileAccess = 'read' | 'read-write';

export interface FileRule {
  path: string;
  access: FileAccess;
}

export interface NetworkRule {
  host: string;
  port: number;
}

export interface CommandRule {
  /** The program's path; `*` and `**` match as OpenShell's binaries do. */
  path: string;
}

export interface SecurityPolicy {
  files: FileRule[];
  network: NetworkRule[];
  commands: CommandRule[];
}

export type PolicySection = keyof SecurityPolicy;

/** A rule Flotilla always adds: the user sees it, and why, but can't remove it. */
export interface FixedFileRule extends FileRule {
  reason: string;
}

/** What's wrong with a rule: its section and place in it, or the whole policy (index -1). */
export interface RuleError {
  section: PolicySection;
  index: number;
  message: string;
}

/** Which policy is in force: the one for all repositories, or this repository's own. */
export type PolicyScope = 'all' | 'repository';

/** The policy's file name, in VS Code's global storage (all repositories) or the workspace's (this repository). */
export const POLICY_FILE = 'security-policy.json';
/** Which of the two is in force, in the workspace's storage. */
export const SCOPE_FILE = 'security-scope.json';

/** Claude's API: every agent needs it. */
export const CLAUDE_API: NetworkRule = { host: 'api.anthropic.com', port: 443 };

/**
 * The strict default: the system's folders to read and the sandbox's own to write (besides the fixed rows), Claude's
 * API and the git remote's host, reached only by Claude, node, git and ssh.
 */
export function defaultPolicy(remote?: NetworkRule): SecurityPolicy {
  return {
    files: [
      ...['/usr', '/lib', '/bin', '/etc', '/opt', '/proc', '/dev'].map((p) => ({ path: p, access: 'read' as const })),
      ...['/sandbox', '/tmp', '/dev/null'].map((p) => ({ path: p, access: 'read-write' as const })),
    ],
    network: [CLAUDE_API, ...(remote && remote.host !== CLAUDE_API.host ? [remote] : [])],
    commands: [{ path: '/usr/**/claude' }, { path: '/usr/**/node' }, { path: '/usr/bin/git' }, { path: '/usr/lib/git-core/*' }, { path: '/usr/bin/ssh' }],
  };
}

/** The host (and port) git reaches for a remote's URL: https://host/…, ssh://[user@]host[:port]/…, or user@host:path. */
export function remoteHost(url: string | undefined): NetworkRule | undefined {
  const u = url?.trim();
  if (!u) return undefined;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)/.exec(u);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return { host: scp[1].toLowerCase(), port: 22 };
  try {
    const parsed = new URL(u);
    const defaults: Record<string, number> = { 'https:': 443, 'http:': 80, 'ssh:': 22, 'git:': 9418 };
    const port = parsed.port ? Number(parsed.port) : defaults[parsed.protocol];
    return parsed.hostname && port ? { host: parsed.hostname.toLowerCase(), port } : undefined;
  } catch {
    return undefined;
  }
}

/** The folders Flotilla mounts (BL-270's sandboxMounts), as the fixed rows the panel shows, each with its reason. */
export function fixedFileRules(o: { agentDirs: readonly string[]; agentFiles: string; configDir: string }): FixedFileRule[] {
  return [
    { path: '{worktree}', access: 'read-write', reason: 'The agent works in its worktree' },
    ...o.agentDirs.map((d) => ({ path: d, access: 'read-write' as const, reason: 'The agent reports in its ticket' })),
    { path: '{worktree}’s git dirs', access: 'read-write', reason: 'The agent commits on its branch' },
    { path: o.agentFiles, access: 'read', reason: 'Flotilla’s hooks track the agent' },
    { path: path.join(o.configDir, 'projects', '{worktree}'), access: 'read-write', reason: 'Flotilla reads the agent’s chat' },
  ];
}

const HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** The policy's errors, rule by rule: OpenShell's rules for paths and hosts, checked before it's saved. */
export function validatePolicy(p: SecurityPolicy): RuleError[] {
  const errors: RuleError[] = [];
  const checkPath = (section: PolicySection, index: number, value: string) => {
    const v = value.trim();
    if (!v) errors.push({ section, index, message: 'Give a path.' });
    else if (!v.startsWith('/')) errors.push({ section, index, message: 'The path must be absolute (start with /).' });
    else if (v.split('/').includes('..')) errors.push({ section, index, message: 'The path can’t contain “..”.' });
    else if (section === 'files' && v.replace(/\/+$/, '') === '') errors.push({ section, index, message: 'All of “/” is too broad: name the folders.' });
    else if (v.length > 4096) errors.push({ section, index, message: 'The path is too long (at most 4096 characters).' });
  };
  p.files.forEach((r, i) => checkPath('files', i, r.path));
  if (p.files.length > 200) errors.push({ section: 'files', index: -1, message: 'At most 200 folders (OpenShell takes 256, Flotilla adds its own).' });
  p.network.forEach((r, i) => {
    if (!HOST.test(r.host.trim())) errors.push({ section: 'network', index: i, message: `“${r.host}” isn’t a host name: give the port in its own field.` });
    else if (!Number.isInteger(r.port) || r.port < 1 || r.port > 65535)
      errors.push({ section: 'network', index: i, message: 'The port is a number from 1 to 65535.' });
  });
  p.commands.forEach((r, i) => checkPath('commands', i, r.path));
  if (p.network.length && !p.commands.length)
    errors.push({ section: 'commands', index: -1, message: 'Name at least one command that may reach the network hosts.' });
  return errors;
}

const quoted = (items: readonly string[]) => items.map((p) => `    - ${JSON.stringify(p)}`).join('\n');

/** The network part of OpenShell's policy: the part a running sandbox reloads. */
function networkLines(p: SecurityPolicy): string[] {
  if (!p.network.length) return [];
  return [
    'network_policies:',
    '  flotilla:',
    '    name: flotilla',
    '    endpoints:',
    ...p.network.map((r) => `      - { host: ${JSON.stringify(r.host.trim())}, port: ${r.port} }`),
    '    binaries:',
    ...p.commands.map((r) => `      - { path: ${JSON.stringify(r.path.trim())} }`),
  ];
}

/**
 * A sandbox's OpenShell policy: the user's folders and the mounts (Landlock), the host's user (uid), so files written
 * in the mounts stay the user's, and the network rules.
 */
export function openshellPolicy(p: SecurityPolicy, mounts: readonly Mount[], uid?: number, gid?: number): string {
  const target = (m: Mount) => m.target ?? m.path;
  const unique = (items: string[]) => [...new Set(items.map((s) => s.trim()))];
  const rw = unique([...p.files.filter((r) => r.access === 'read-write').map((r) => r.path), ...mounts.filter((m) => !m.readOnly).map(target)]);
  const ro = unique([...p.files.filter((r) => r.access === 'read').map((r) => r.path), ...mounts.filter((m) => m.readOnly).map(target)]).filter(
    (d) => !rw.includes(d),
  );
  return [
    'version: 1',
    'filesystem_policy:',
    '  include_workdir: true',
    ...(ro.length ? ['  read_only:', quoted(ro)] : ['  read_only: []']),
    ...(rw.length ? ['  read_write:', quoted(rw)] : ['  read_write: []']),
    ...(uid && gid ? ['process:', `  run_as_user: "${uid}"`, `  run_as_group: "${gid}"`] : []),
    ...networkLines(p),
    '',
  ].join('\n');
}

/** The policy `openshell policy set` loads into a running sandbox: only its network rules, which it reloads. */
export function networkPolicy(p: SecurityPolicy): string {
  return ['version: 1', ...networkLines(p), ''].join('\n');
}

/** Reads a policy file; a missing or broken one is undefined, so the default applies. */
export function readPolicy(file: string): SecurityPolicy | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SecurityPolicy>;
    const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
    return {
      files: list<FileRule>(raw.files)
        .filter((r) => typeof r?.path === 'string')
        .map((r) => ({ path: r.path, access: r.access === 'read' ? 'read' : 'read-write' })),
      network: list<NetworkRule>(raw.network)
        .filter((r) => typeof r?.host === 'string')
        .map((r) => ({ host: r.host, port: Number(r.port) })),
      commands: list<CommandRule>(raw.commands)
        .filter((r) => typeof r?.path === 'string')
        .map((r) => ({ path: r.path })),
    };
  } catch {
    return undefined;
  }
}

export function writePolicy(file: string, p: SecurityPolicy): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(p, null, 2)}\n`);
}

export function readScope(dir: string | undefined): PolicyScope {
  if (!dir) return 'all';
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, SCOPE_FILE), 'utf8')) as { scope?: string }).scope === 'repository' ? 'repository' : 'all';
  } catch {
    return 'all';
  }
}

export function writeScope(dir: string, scope: PolicyScope): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SCOPE_FILE), `${JSON.stringify({ scope })}\n`);
}

/**
 * Where the policies are: VS Code's global storage (all repositories) and the workspace's (this repository, when
 * there's a workspace). The scope file says which is in force; the default policy applies until one is saved.
 */
export class PolicyStore {
  constructor(
    readonly globalDir: string,
    readonly workspaceDir: string | undefined,
    private readonly fallback: () => SecurityPolicy,
  ) {}

  scope(): PolicyScope {
    return this.workspaceDir ? readScope(this.workspaceDir) : 'all';
  }

  file(scope: PolicyScope = this.scope()): string {
    return path.join(scope === 'repository' && this.workspaceDir ? this.workspaceDir : this.globalDir, POLICY_FILE);
  }

  /** The policy of a scope (the one in force by default): its file's, else the default. */
  read(scope: PolicyScope = this.scope()): SecurityPolicy {
    return readPolicy(this.file(scope)) ?? this.fallback();
  }

  /** Whether a scope has a policy of its own saved, or runs on the default. */
  saved(scope: PolicyScope = this.scope()): boolean {
    return fs.existsSync(this.file(scope));
  }

  write(scope: PolicyScope, p: SecurityPolicy): void {
    writePolicy(this.file(scope), p);
  }

  setScope(scope: PolicyScope): void {
    if (this.workspaceDir) writeScope(this.workspaceDir, scope);
  }

  defaults(): SecurityPolicy {
    return this.fallback();
  }
}

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Need } from '../backlog/needs';
import type { AuditEntry } from './audit';
import type {
  CommandRule,
  NetworkRule,
  SecurityPolicy,
} from './policy';

/**
 * A blocked request asks the user (BL-273): what the sandbox blocked, from the audit (audit.ts), is one request per
 * ticket however often it was tried, until the user decides. Allow once loads the rule into that ticket's sandbox only,
 * Always allow adds it to the policy in force, Keep blocked asks no more. The decisions are kept with the audit, in
 * Flotilla's own storage, which no sandbox mounts: nothing an agent writes can allow a request.
 */

export type Choice = 'once' | 'always' | 'blocked';

/** What was blocked, as a rule could allow it. */
export interface Request {
  /** The same request, however often it's tried: its kind, then the host and port and program, or the path. */
  key: string;
  kind: 'network' | 'file';
  /** The host and port, or the path. */
  target: string;
  host?: string;
  port?: number;
  /** The program that connected, when the sandbox said. */
  program?: string;
}

/** A request the user hasn't decided yet, for a ticket: who tried it, when last, and how often. */
export interface BlockedRequest extends Request {
  ticket: string;
  sandbox: string;
  agent?: string;
  /** When it was last tried, ISO. */
  at: string;
  /** When it was first tried, ISO: how long it waits on the user. */
  since: string;
  times: number;
}

/** The rules Allow once loaded into a sandbox: they're added to whatever policy it gets, until it's removed. */
export interface Grants {
  network: NetworkRule[];
  commands: CommandRule[];
}

export interface Decisions {
  /** Each ticket's decided requests, by key. */
  tickets: Record<string, Record<string, { choice: Choice; at: string }>>;
  once: Record<string, Grants>;
}

const PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 };

/** The request an audit entry is, if a rule could allow it: a connection to a host, or a path. Programs run aren't. */
export function requestOf(e: Pick<AuditEntry, 'kind' | 'target' | 'detail'>): Request | undefined {
  if (e.kind === 'file') {
    const target = e.target.trim();
    return target.startsWith('/') ? { key: `file:${target}`, kind: 'file', target } : undefined;
  }
  if (e.kind !== 'network') return undefined;
  let host: string | undefined;
  let port: number | undefined;
  const hostPort = /^\[?([^\s/[\]]+?)\]?:(\d+)$/.exec(e.target.trim());
  if (hostPort) [host, port] = [hostPort[1], Number(hostPort[2])];
  else {
    // An HTTP request ("POST https://host/path").
    const url = /\b(https?:\/\/\S+)/.exec(e.target)?.[1];
    try {
      const u = url ? new URL(url) : undefined;
      if (u) [host, port] = [u.hostname, u.port ? Number(u.port) : PORTS[u.protocol]];
    } catch {
      // Not a URL: nothing a rule could name.
    }
  }
  if (!host || !port) return undefined;
  // The detail starts with the program when the sandbox named it ("/usr/bin/curl · no matching policy").
  const first = e.detail?.split(' · ')[0]?.trim();
  const program = first?.startsWith('/') ? first : undefined;
  return {
    key: `network:${host}:${port}${program ? `:${program}` : ''}`,
    kind: 'network',
    target: `${host}:${port}`,
    host,
    port,
    ...(program ? { program } : {}),
  };
}

/** Whether p already allows r: an Always allow made since, or the user's own rule in the Security panel. */
export function allows(p: SecurityPolicy, r: Request): boolean {
  if (r.kind === 'file') return p.files.some((f) => r.target === f.path || r.target.startsWith(`${f.path.replace(/\/+$/, '')}/`));
  const host = p.network.some((n) => n.host.trim() === r.host && n.port === r.port);
  return host && (!r.program || p.commands.some((c) => matchesProgram(c.path.trim(), r.program!)));
}

/** Whether a command rule's path names a program: `*` matches within a folder, `**` across folders, as OpenShell's do. */
function matchesProgram(rule: string, program: string): boolean {
  const re = rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?|\*/g, (m) => (m === '*' ? '[^/]*' : '(?:.*/)?'));
  return new RegExp(`^${re}$`).test(program);
}

/** p with the rules that allow r: its host and port, and the program making it; or its path, to read. */
export function withRule(p: SecurityPolicy, r: Request): SecurityPolicy {
  if (r.kind === 'file') return allows(p, r) ? p : { ...p, files: [...p.files, { path: r.target, access: 'read' }] };
  return withGrants(p, grantsOf(r));
}

/** The network rules that allow r. */
export function grantsOf(r: Request): Grants {
  return {
    network: r.host && r.port ? [{ host: r.host, port: r.port }] : [],
    commands: r.program ? [{ path: r.program }] : [],
  };
}

/** p with g's rules added, each once. */
export function withGrants(p: SecurityPolicy, g: Grants | undefined): SecurityPolicy {
  if (!g) return p;
  const network = [...p.network];
  for (const n of g.network) if (!network.some((m) => m.host.trim() === n.host && m.port === n.port)) network.push(n);
  const commands = [...p.commands];
  for (const c of g.commands) if (!commands.some((m) => matchesProgram(m.path.trim(), c.path))) commands.push(c);
  return { ...p, network, commands };
}

/**
 * Each ticket's requests the sandbox blocked that wait on the user, oldest first: not decided for that ticket, and not
 * allowed by the policy in force (or by an Allow once in its sandbox) since.
 */
export function pendingRequests(entries: readonly AuditEntry[], d: Decisions, policy: SecurityPolicy): Map<string, BlockedRequest[]> {
  const byTicket = new Map<string, Map<string, BlockedRequest>>();
  for (const e of entries) {
    if (!e.blocked || !e.ticket || e.decision) continue;
    const r = requestOf(e);
    if (!r || d.tickets[e.ticket]?.[r.key]) continue;
    if (allows(withGrants(policy, d.once[e.sandbox]), r)) continue;
    const mine = byTicket.get(e.ticket) ?? new Map<string, BlockedRequest>();
    byTicket.set(e.ticket, mine);
    const had = mine.get(r.key);
    if (!had) mine.set(r.key, { ...r, ticket: e.ticket, sandbox: e.sandbox, ...(e.agent ? { agent: e.agent } : {}), at: e.at, since: e.at, times: 1 });
    else {
      had.times++;
      if (e.at < had.since) had.since = e.at;
      // The last try's agent and sandbox: that's where Allow once applies.
      if (e.at > had.at) Object.assign(had, { at: e.at, sandbox: e.sandbox, ...(e.agent ? { agent: e.agent } : {}) });
    }
  }
  return new Map([...byTicket].map(([t, m]) => [t, [...m.values()].sort((a, b) => a.since.localeCompare(b.since))]));
}

/** The line its "Needs you" row says: who tried what. */
export function requestLine(r: Pick<BlockedRequest, 'kind' | 'target' | 'program' | 'agent'>): string {
  const who = r.agent ?? 'Its agent';
  if (r.kind === 'file') return `Blocked: ${who} opened ${r.target}`;
  return `Blocked: ${who} reached ${r.target}${r.program ? ` with ${path.posix.basename(r.program)}` : ''}`;
}

/** A ticket's "Needs you" row for its blocked requests: the oldest, and how many more wait after it. */
export function blockedNeed(requests: readonly BlockedRequest[]): Need {
  const more = requests.length - 1;
  return { kind: 'blocked', since: requests[0].since, line: `${requestLine(requests[0])}${more ? ` (${more} more)` : ''}` };
}

const CHOICE_DETAIL: Record<Choice, string> = {
  once: 'You allowed it once, in this sandbox',
  always: 'You allowed it always: added to the Security policy',
  blocked: 'You kept it blocked',
};

/** The audit entry a decision is: the user's, on the request it's about. */
export function decisionEntry(r: BlockedRequest, choice: Choice, at: Date = new Date()): AuditEntry {
  const iso = at.toISOString();
  return {
    at: iso,
    sandbox: r.sandbox,
    ticket: r.ticket,
    agent: 'You',
    kind: r.kind,
    target: r.target,
    blocked: choice === 'blocked',
    detail: [r.program, CHOICE_DETAIL[choice]].filter(Boolean).join(' · '),
    decision: choice,
    key: crypto.createHash('sha1').update(`${r.ticket} ${r.key} ${choice} ${iso}`).digest('hex').slice(0, 16),
  };
}

function decisionsFile(dir: string): string {
  return path.join(dir, 'decisions.json');
}

export function readDecisions(dir: string): Decisions {
  try {
    const raw = JSON.parse(fs.readFileSync(decisionsFile(dir), 'utf8')) as Partial<Decisions>;
    return { tickets: raw.tickets ?? {}, once: raw.once ?? {} };
  } catch {
    return { tickets: {}, once: {} };
  }
}

export function writeDecisions(dir: string, d: Decisions): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(decisionsFile(dir), JSON.stringify(d, null, 1));
}

/** d with the user's choice on r noted: for its ticket, and an Allow once's rules for its sandbox. */
export function decide(d: Decisions, r: BlockedRequest, choice: Choice, at: Date = new Date()): Decisions {
  const tickets = { ...d.tickets, [r.ticket]: { ...d.tickets[r.ticket], [r.key]: { choice, at: at.toISOString() } } };
  if (choice !== 'once') return { ...d, tickets };
  const had = d.once[r.sandbox] ?? { network: [], commands: [] };
  const merged = withGrants({ files: [], ...had }, grantsOf(r));
  return { tickets, once: { ...d.once, [r.sandbox]: { network: merged.network, commands: merged.commands } } };
}

/** Drops the rules Allow once loaded into a sandbox that's removed. */
export function forgetGrants(dir: string, sandbox: string): void {
  const d = readDecisions(dir);
  if (!d.once[sandbox]) return;
  const { [sandbox]: _gone, ...once } = d.once;
  writeDecisions(dir, { ...d, once });
}

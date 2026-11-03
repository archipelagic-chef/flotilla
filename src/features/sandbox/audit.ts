import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * What sandboxed agents did, and what their sandbox blocked (BL-272): OpenShell's log lines, read with `openshell logs`
 * (openshell.ts), kept in Flotilla's own storage, outside every sandbox's mounts, so an agent can't edit them and they
 * stay after its sandbox is removed. Each entry is linked to its ticket and agent through its sandbox: a ticket's agents
 * share the sandbox of its worktree, and an entry is the agent's that ran there last before it.
 */

export type AuditKind = 'network' | 'file' | 'process';

export interface AuditEntry {
  /** When, as an ISO time. */
  at: string;
  sandbox: string;
  ticket?: string;
  agent?: string;
  kind: AuditKind;
  /** The host and port, the request, the path or the command. */
  target: string;
  blocked: boolean;
  /** The program that connected, then why it was blocked or the policy that allowed it. */
  detail?: string;
  /** The line's hash: a line read twice is kept once. */
  key: string;
}

/** The agents that ran in a sandbox, and the ticket it's for. */
export interface SandboxRuns {
  ticket?: string;
  runs: Array<{ agent: string; from: string }>;
  /** Its sandbox was removed: its log is all copied, and nothing is read from it anymore. */
  removed?: true;
}

export type Registry = Record<string, SandboxRuns>;

const NETWORK = new Set(['NET', 'HTTP', 'SSH']);
const FILE = new Set(['FILE', 'FS']);
/** The OCSF event: its class and activity, severity, then the rest ("NET:OPEN [MED] DENIED … [policy:- engine:opa]"). */
const EVENT = /\b([A-Z]+):([A-Z_]+) \[([A-Z]+)\]\s*(.*)$/;

/**
 * An entry of one of OpenShell's log lines, as `openshell logs` prints it ("[1775014132.690] [sandbox] [OCSF ] [ocsf]
 * NET:OPEN …") or its log file has it ("2026-04-01T04:04:32.690Z OCSF NET:OPEN …"). Lines that aren't a network
 * connection, a file or a process (the sandbox starting, its policy loading) are none.
 */
export function parseAuditLine(line: string, sandbox: string): AuditEntry | undefined {
  const text = line.trim();
  if (!/\bOCSF\b|\[ocsf\]/.test(text)) return undefined;
  const at = lineTime(text);
  const m = EVENT.exec(text);
  if (!at || !m) return undefined;
  const [, cls, activity, , rest] = m;
  const context: Record<string, string> = {};
  // The trailing [key:value …] groups.
  let body = rest.replace(/(?:\s*\[[^\]]*\])+\s*$/, (groups) => {
    for (const g of groups.matchAll(/\[([^\]]*)\]/g)) {
      for (const kv of g[1].matchAll(/(\w+):((?:(?! \w+:).)+)/g)) context[kv[1]] = kv[2].trim();
    }
    return '';
  });
  const decision = /^(ALLOWED|DENIED|BLOCKED)\b\s*/.exec(body);
  if (decision) body = body.slice(decision[0].length);
  const blocked = decision?.[1] === 'DENIED' || decision?.[1] === 'BLOCKED';
  let kind: AuditKind;
  let target: string;
  // A network connection's program: OpenShell allows programs to reach hosts, so a blocked one shows as its connection.
  let program: string | undefined;
  if (NETWORK.has(cls)) {
    // The proxy listening isn't the agent's.
    if (activity === 'LISTEN') return undefined;
    kind = 'network';
    const net = cls === 'NET' ? /^(.*?)\s*->\s*(\S+)/.exec(body) : null;
    target = net ? net[2] : body || cls;
    program = net?.[1].replace(/\(\d+\)$/, '').trim() || undefined;
  } else if (cls === 'PROC') {
    kind = 'process';
    target = body.replace(/\(\d+\)/, '').trim();
  } else if (FILE.has(cls)) {
    kind = 'file';
    target = context.path ?? body;
  } else return undefined;
  if (!target) return undefined;
  const why = context.reason ?? (context.policy && context.policy !== '-' ? `policy ${context.policy}` : undefined);
  const detail = [program, why].filter(Boolean).join(' · ') || undefined;
  return {
    at,
    sandbox,
    kind,
    target,
    blocked,
    ...(detail ? { detail } : {}),
    key: crypto.createHash('sha1').update(text).digest('hex').slice(0, 16),
  };
}

/** A line's time, as ISO: epoch seconds in brackets (the CLI's), or an ISO time (the log file's). */
function lineTime(text: string): string | undefined {
  const epoch = /^\[(\d+(?:\.\d+)?)\]/.exec(text);
  if (epoch) return new Date(Number(epoch[1]) * 1000).toISOString();
  const iso = /^(\d{4}-\d\d-\d\dT[\d:.]+Z?)/.exec(text);
  if (!iso) return undefined;
  const d = new Date(iso[1]);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** The agent of an entry at `at`: the one that started in its sandbox last before it, else its first. */
export function agentAt(runs: SandboxRuns | undefined, at: string): string | undefined {
  const sorted = [...(runs?.runs ?? [])].sort((a, b) => a.from.localeCompare(b.from));
  return sorted.filter((r) => r.from <= at).pop()?.agent ?? sorted[0]?.agent;
}

/** The entries of a log's text that aren't kept yet, linked to their ticket and agent. */
export function newEntries(text: string, sandbox: string, runs: SandboxRuns | undefined, kept: ReadonlySet<string>): AuditEntry[] {
  const seen = new Set(kept);
  const out: AuditEntry[] = [];
  for (const line of text.split('\n')) {
    const e = parseAuditLine(line, sandbox);
    if (!e || seen.has(e.key)) continue;
    seen.add(e.key);
    const agent = agentAt(runs, e.at);
    out.push({ ...e, ...(runs?.ticket ? { ticket: runs.ticket } : {}), ...(agent ? { agent } : {}) });
  }
  return out;
}

export interface AuditFilter {
  ticket?: string;
  agent?: string;
  result?: 'blocked' | 'allowed';
}

export function matches(e: AuditEntry, f: AuditFilter): boolean {
  if (f.ticket && e.ticket !== f.ticket) return false;
  if (f.agent && e.agent !== f.agent) return false;
  if (f.result && e.blocked !== (f.result === 'blocked')) return false;
  return true;
}

/** Blocked entries first, then the others, each newest first. */
export function auditOrder(a: AuditEntry, b: AuditEntry): number {
  return Number(b.blocked) - Number(a.blocked) || b.at.localeCompare(a.at);
}

/** A page of the entries that match f, in auditOrder, with the counts of all of them. */
export function auditPage(
  entries: readonly AuditEntry[],
  f: AuditFilter,
  limit: number,
): { entries: AuditEntry[]; total: number; blocked: number; allowed: number } {
  const all = entries.filter((e) => matches(e, { ...f, result: undefined }));
  const shown = all.filter((e) => matches(e, f)).sort(auditOrder);
  const blocked = all.filter((e) => e.blocked).length;
  return { entries: shown.slice(0, limit), total: shown.length, blocked, allowed: all.length - blocked };
}

/** Where the runs of each sandbox are kept. */
function registryFile(dir: string): string {
  return path.join(dir, 'sandboxes.json');
}

function logFile(dir: string, sandbox: string): string {
  return path.join(dir, `${sandbox.replace(/[^a-z0-9-]/gi, '_')}.jsonl`);
}

export function readRegistry(dir: string): Registry {
  try {
    return JSON.parse(fs.readFileSync(registryFile(dir), 'utf8')) as Registry;
  } catch {
    return {};
  }
}

function writeRegistry(dir: string, registry: Registry): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(registryFile(dir), JSON.stringify(registry, null, 1));
}

/** Notes that agent started in sandbox for ticket at `at`: the entries after it are its. */
export function recordRun(dir: string, sandbox: string, o: { ticket?: string; agent: string; at?: Date }): void {
  const registry = readRegistry(dir);
  const runs = registry[sandbox] ?? { runs: [] };
  registry[sandbox] = {
    ...((o.ticket ?? runs.ticket) ? { ticket: o.ticket ?? runs.ticket } : {}),
    runs: [...runs.runs, { agent: o.agent, from: (o.at ?? new Date()).toISOString() }],
  };
  writeRegistry(dir, registry);
}

/** Notes that sandbox was removed. */
export function markRemoved(dir: string, sandbox: string): void {
  const registry = readRegistry(dir);
  if (!registry[sandbox]) return;
  registry[sandbox] = { ...registry[sandbox], removed: true };
  writeRegistry(dir, registry);
}

export function readAudit(dir: string, sandbox?: string): AuditEntry[] {
  let files: string[];
  try {
    files = sandbox
      ? [logFile(dir, sandbox)]
      : fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
  return files.flatMap((file) => {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    return text.split('\n').flatMap((line) => {
      try {
        return line.trim() ? [JSON.parse(line) as AuditEntry] : [];
      } catch {
        return [];
      }
    });
  });
}

/** Keeps the entries of a sandbox's log text that aren't kept yet: how many there were. */
export function keepAudit(dir: string, sandbox: string, text: string): number {
  const kept = new Set(readAudit(dir, sandbox).map((e) => e.key));
  const added = newEntries(text, sandbox, readRegistry(dir)[sandbox], kept);
  if (!added.length) return 0;
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(logFile(dir, sandbox), added.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return added.length;
}

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  type AuditEntry,
  keepAudit,
  markRemoved,
  readAudit,
  readRegistry,
  recordRun,
} from '../../features/sandbox/audit';
import { readLogs } from '../../features/sandbox/openshell';
import { forgetGrants } from '../../features/sandbox/requests';

/** How often the sandboxes' logs are copied while their agents may run: the gateway keeps only its last 2,000 lines. */
const POLL_MS = 60_000;

/** Where a repository's audit is kept: in VS Code's storage for Flotilla, one folder for each repository (its git common dir). */
export function auditDir(globalStorage: string, commonDir: string): string {
  return path.join(globalStorage, 'audit', crypto.createHash('sha256').update(path.resolve(commonDir)).digest('hex').slice(0, 12));
}

let shared: SandboxAudit | undefined;

/**
 * The sandboxed agents' audit (BL-272), kept in VS Code's storage for Flotilla, which no sandbox mounts: every minute it
 * copies the new lines of each sandbox's log that isn't removed, and once more before a sandbox is removed.
 */
export class SandboxAudit implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private cache: AuditEntry[] | undefined;
  private readonly timer: NodeJS.Timeout;
  private copying: Promise<void> | undefined;

  constructor(
    readonly dir: string,
    private readonly log?: (line: string) => void,
  ) {
    shared = this;
    this.timer = setInterval(() => void this.copyAll(), POLL_MS);
  }

  /** Every entry kept, of every sandbox. */
  entries(): AuditEntry[] {
    this.cache ??= readAudit(this.dir);
    return this.cache;
  }

  /** How many entries of each ticket were blocked. */
  blockedByTicket(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const e of this.entries()) if (e.blocked && e.ticket && !e.decision) counts.set(e.ticket, (counts.get(e.ticket) ?? 0) + 1);
    return counts;
  }

  /** Reads the entries again (one Flotilla added, BL-273), and says so. */
  refresh(): void {
    this.cache = undefined;
    this.changed.fire();
  }

  /** Notes an agent's start in a sandbox: the entries after it are its. */
  noteRun(sandbox: string, ticket: string | undefined, agent: string): void {
    try {
      recordRun(this.dir, sandbox, { ticket, agent });
    } catch (e) {
      this.log?.(`Sandbox audit: couldn't note ${agent} in ${sandbox}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Copies the new lines of every sandbox that's still there. */
  copyAll(): Promise<void> {
    this.copying ??= (async () => {
      try {
        const registry = readRegistry(this.dir);
        for (const [name, runs] of Object.entries(registry)) if (!runs.removed) await this.copy(name);
      } finally {
        this.copying = undefined;
      }
    })();
    return this.copying;
  }

  /** Copies a sandbox's new lines. */
  async copy(sandbox: string): Promise<number> {
    const text = await readLogs(sandbox);
    if (!text) return 0;
    let added = 0;
    try {
      added = keepAudit(this.dir, sandbox, text);
    } catch (e) {
      this.log?.(`Sandbox audit: couldn't keep ${sandbox}'s log: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (added) {
      this.cache = undefined;
      this.changed.fire();
    }
    return added;
  }

  /** Copies a sandbox's last lines before it's removed: its log stays here. */
  async beforeRemove(sandbox: string): Promise<void> {
    if (!readRegistry(this.dir)[sandbox]) return;
    await this.copy(sandbox);
    markRemoved(this.dir, sandbox);
    // What Allow once let it reach ends with it (BL-273).
    forgetGrants(this.dir, sandbox);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.changed.dispose();
    if (shared === this) shared = undefined;
  }
}

/** The audit agents' starts are noted in, once the extension made it. */
export function sandboxAudit(): SandboxAudit | undefined {
  return shared;
}

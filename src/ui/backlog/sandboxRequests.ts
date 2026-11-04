import * as path from 'node:path';
import * as vscode from 'vscode';
import { appendAudit } from '../../features/sandbox/audit';
import { applyNetworkPolicy } from '../../features/sandbox/openshell';
import {
  type PolicyStore,
  type SecurityPolicy,
  validatePolicy,
} from '../../features/sandbox/policy';
import {
  type BlockedRequest,
  type Choice,
  decide,
  decisionEntry,
  type Grants,
  pendingRequests,
  readDecisions,
  withGrants,
  withRule,
  writeDecisions,
} from '../../features/sandbox/requests';
import type { SandboxAudit } from './sandboxAudit';

/**
 * The requests sandboxes blocked that ask the user (BL-273), and what their choice does: Allow once loads the rule into
 * the ticket's sandbox, Always allow adds it to the policy in force and loads it into the running sandboxes, Keep blocked
 * asks no more. Only a click in "Needs you" decides: the request is looked up here, by its key, in the audit.
 */
export class SandboxRequests implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly audit: Pick<SandboxAudit, 'dir' | 'entries' | 'refresh'>,
    private readonly store: PolicyStore,
    /** The sandboxes of this repository's worktrees, by name. */
    private readonly sandboxes: () => string[],
    /** Where the policies loaded into running sandboxes are written: outside every mount. */
    private readonly policyDir: string,
    private readonly sandboxed: () => boolean,
  ) {}

  /** Each ticket's blocked requests that wait on the user, oldest first: none while agents don't run sandboxed. */
  pending(): Map<string, BlockedRequest[]> {
    if (!this.sandboxed()) return new Map();
    return pendingRequests(this.audit.entries(), readDecisions(this.audit.dir), this.store.read());
  }

  /** The rules Allow once loaded into a sandbox. */
  grants(sandbox: string): Grants | undefined {
    return readDecisions(this.audit.dir).once[sandbox];
  }

  /** The policy a sandbox runs under: the one in force, with its Allow once rules. */
  policyOf(sandbox: string, p: SecurityPolicy = this.store.read()): SecurityPolicy {
    return withGrants(p, this.grants(sandbox));
  }

  /** Does the user's choice on a ticket's request: what it did, for the user, or why it couldn't. */
  async decide(ticket: string, key: string, choice: Choice): Promise<{ done?: string; error?: string }> {
    const r = this.pending()
      .get(ticket)
      ?.find((q) => q.key === key);
    if (!r) return { error: 'That request waits on you no more.' };
    if (r.kind === 'file' && choice === 'once') return { error: "A folder can't be allowed in a running sandbox: Always allow applies it at the next start." };
    let done: string;
    const decisions = decide(readDecisions(this.audit.dir), r, choice);
    if (choice === 'once') {
      const p = withGrants(this.store.read(), decisions.once[r.sandbox]);
      const result = this.sandboxed()
        ? await applyNetworkPolicy(p, [r.sandbox], path.join(this.policyDir, `${r.sandbox}-network-policy.yaml`))
        : { applied: [] as string[] };
      if (result.error) return { error: result.error.message };
      done = result.applied.length
        ? `Allowed ${r.target} once: ${r.ticket}'s sandbox reaches it now.`
        : `Allowed ${r.target} once: ${r.ticket}'s sandbox reaches it when its agent next starts.`;
    } else if (choice === 'always') {
      const p = withRule(this.store.read(), r);
      const errors = validatePolicy(p);
      if (errors.length) return { error: errors[0].message };
      if (r.kind === 'network' && this.sandboxed()) {
        const result = await applyNetworkPolicy(p, this.sandboxes(), path.join(this.policyDir, 'network-policy.yaml'), undefined, (name) =>
          withGrants(p, decisions.once[name]),
        );
        if (result.error) return { error: result.error.message };
      }
      this.store.write(this.store.scope(), p);
      done =
        r.kind === 'file'
          ? `Added ${r.target} to the Security policy: agents reach it from their next start.`
          : `Added ${r.target} to the Security policy: running sandboxes reach it now.`;
    } else done = `Kept ${r.target} blocked: ${r.ticket} won't ask about it again.`;
    writeDecisions(this.audit.dir, decisions);
    appendAudit(this.audit.dir, decisionEntry(r, choice));
    this.audit.refresh();
    this.changed.fire();
    return { done };
  }

  dispose(): void {
    this.changed.dispose();
  }
}

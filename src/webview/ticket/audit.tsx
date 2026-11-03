import type {
  AuditEntryView,
  AuditView,
} from '../ticketProtocol';
import { send } from './actions';
import './audit.css';

/** The Audit section's id: the card's blocked count scrolls to it (BL-272). */
export const AUDIT_SECTION = 'audit';

const KIND_ICON: Record<AuditEntryView['kind'], string> = { network: 'globe', file: 'file', process: 'terminal' };

/** An entry's time: the hour and minute today, else its day too. */
export function auditTime(iso: string): string {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
}

/** The entries, as a table: blocked rows marked, the agent's column when there's more than one ticket's or agent's. */
export function AuditTable({ entries, ticketColumn }: { entries: readonly AuditEntryView[]; ticketColumn?: boolean }) {
  return (
    <table class="audit-table">
      <thead>
        <tr>
          <th>Time</th>
          {ticketColumn && <th>Ticket</th>}
          <th>Agent</th>
          <th>Kind</th>
          <th>Target</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.key} class={e.blocked ? 'blocked' : 'allowed'}>
            <td class="audit-time" title={new Date(e.at).toLocaleString()}>
              {auditTime(e.at)}
            </td>
            {ticketColumn && <td>{e.ticket ?? '—'}</td>}
            <td>{e.agent ?? '—'}</td>
            <td class="audit-kind">
              <i class={`codicon codicon-${KIND_ICON[e.kind]}`} /> {e.kind}
            </td>
            <td class="audit-target" title={e.detail ? `${e.target}: ${e.detail}` : e.target}>
              {e.target}
              {/* Why it was blocked, and the program that tried, shown in its row; an allowed one's policy is in its tooltip. */}
              {e.blocked && e.detail && <div class="audit-detail">{e.detail}</div>}
            </td>
            <td class="audit-result" title={e.detail}>
              {e.blocked ? (
                <>
                  <i class="codicon codicon-error" /> blocked
                </>
              ) : (
                <>
                  <i class="codicon codicon-check" /> allowed
                </>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const FILTERS: Array<{ result?: 'blocked' | 'allowed'; label: string }> = [
  { label: 'All' },
  { result: 'blocked', label: 'Blocked' },
  { result: 'allowed', label: 'Allowed' },
];

/**
 * A ticket's Audit section (BL-272): what its sandboxed agents reached or tried to, and what the sandbox blocked, blocked
 * entries first. Long logs load a page at a time; the audit of all agents opens in a tab of its own.
 */
export function Audit({ audit }: { audit: AuditView }) {
  const left = audit.total - audit.entries.length;
  return (
    <section class="block audit" id={AUDIT_SECTION}>
      <div class="block-head">
        <h2>Audit</h2>
        <span class="muted">
          {audit.blocked} blocked · {audit.allowed} allowed
        </span>
        <span class="audit-filter" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button
              key={f.label}
              class={audit.result === f.result ? 'on' : ''}
              onClick={() => send({ type: 'audit', ...(f.result ? { result: f.result } : {}) })}
            >
              {f.label}
            </button>
          ))}
        </span>
      </div>
      {audit.entries.length > 0 ? (
        <AuditTable entries={audit.entries} />
      ) : (
        <p class="muted">
          {audit.blocked + audit.allowed === 0
            ? 'Nothing yet: what its agents reach in their sandbox shows here, a minute or so after they do.'
            : `No ${audit.result ?? ''} entries.`}
        </p>
      )}
      <div class="audit-foot">
        {left > 0 && (
          <button class="link" onClick={() => send({ type: 'audit', ...(audit.result ? { result: audit.result } : {}), more: true })}>
            Load {Math.min(left, 50)} more…
          </button>
        )}
        <button
          class="link audit-all"
          onClick={() => send({ type: 'openAudit' })}
          title="Every sandboxed agent's entries, filtered by ticket, agent, blocked or allowed"
        >
          Open all agents' audit <i class="codicon codicon-link-external" />
        </button>
      </div>
    </section>
  );
}

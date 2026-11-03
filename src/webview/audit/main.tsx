import { render } from 'preact';
import {
  useEffect,
  useState,
} from 'preact/hooks';
import type {
  AuditFilterView,
  AuditHostMessage,
  AuditWebviewMessage,
} from '../auditProtocol';
// The ticket's rules (its blocks, buttons), then the Audit section's table.
import '../ticket/ticket.css';
import { send as sendTicket } from '../ticket/actions';
import { AuditTable } from '../ticket/audit';
import './audit.css';

/** The page's one VS Code API (the ticket's module acquired it). */
const send = sendTicket as unknown as (message: AuditWebviewMessage) => void;

function Pick({ label, value, options, onPick }: { label: string; value?: string; options: readonly string[]; onPick: (v: string | undefined) => void }) {
  return (
    <label class="audit-pick">
      {label}{' '}
      <select value={value ?? ''} onChange={(e) => onPick((e.target as HTMLSelectElement).value || undefined)}>
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Every sandboxed agent's entries (BL-272), blocked first, filtered by ticket, agent, blocked or allowed. */
function AllAudit() {
  const [audit, setAudit] = useState<AuditHostMessage | undefined>();
  useEffect(() => {
    const on = (e: MessageEvent<AuditHostMessage>) => {
      if (e.data.type === 'audit') setAudit(e.data);
    };
    window.addEventListener('message', on);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', on);
  }, []);
  if (!audit) return <p class="muted">Reading the audit…</p>;
  const filter = (f: Partial<AuditFilterView>) => send({ type: 'filter', filter: { ...audit.filter, ...f } });
  const left = audit.total - audit.entries.length;
  return (
    <div class="audit-all-page">
      <div class="block-head">
        <h1>Sandbox Audit</h1>
        <span class="muted">
          {audit.blocked} blocked · {audit.allowed} allowed
        </span>
      </div>
      <div class="audit-picks">
        <Pick label="Ticket" value={audit.filter.ticket} options={audit.tickets} onPick={(ticket) => filter({ ticket })} />
        <Pick label="Agent" value={audit.filter.agent} options={audit.agents} onPick={(agent) => filter({ agent })} />
        <Pick label="Result" value={audit.filter.result} options={['blocked', 'allowed']} onPick={(r) => filter({ result: r as AuditFilterView['result'] })} />
      </div>
      {audit.entries.length > 0 ? (
        <AuditTable entries={audit.entries} ticketColumn onTicket={(id) => send({ type: 'openTicket', id })} />
      ) : (
        <p class="muted">
          No entries{audit.blocked + audit.allowed ? ' match' : ' yet: what sandboxed agents reach shows here, a minute or so after they do'}.
        </p>
      )}
      {left > 0 && (
        <div class="audit-foot">
          <button class="link" onClick={() => send({ type: 'more' })}>
            Load {Math.min(left, 100)} more…
          </button>
        </div>
      )}
    </div>
  );
}

render(<AllAudit />, document.getElementById('root')!);

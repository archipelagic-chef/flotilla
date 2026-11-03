import {
  useEffect,
  useState,
} from 'preact/hooks';
import type {
  FileAccess,
  PolicyScope,
  PolicySection,
  RuleError,
  SecurityPolicy,
  SecurityView,
} from '../securityProtocol';
import './security.css';

const same = (a: SecurityPolicy, b: SecurityPolicy) => JSON.stringify(a) === JSON.stringify(b);

/** When a section's rules take effect: network rules reload in running sandboxes, folders need a new one. */
function When({ now }: { now: boolean }) {
  return now ? (
    <span class="security-when now" title="OpenShell reloads it in running sandboxes">
      ● applies at once
    </span>
  ) : (
    <span class="security-when later" title="Landlock's folders are set when a sandbox is made">
      ◷ at the agent's next start
    </span>
  );
}

function Errors({ errors, section, index }: { errors: RuleError[]; section: PolicySection; index: number }) {
  return (
    <>
      {errors
        .filter((e) => e.section === section && e.index === index)
        .map((e) => (
          <div class="security-error" role="alert">
            {e.message}
          </div>
        ))}
    </>
  );
}

/**
 * The Security panel (BL-271): which policy is in force and where it saves, then Files, Network and Commands, each rule
 * editable in place. Flotilla's own folders are fixed rows, with their reason.
 */
export function SecurityBody(props: {
  view: SecurityView;
  errors: RuleError[];
  saving: boolean;
  save(policy: SecurityPolicy): void;
  setScope(scope: PolicyScope): void;
  enableSandbox(): void;
}) {
  const { view, errors } = props;
  const [draft, setDraft] = useState<SecurityPolicy>(view.policy);
  useEffect(() => setDraft(view.policy), [view]);
  const dirty = !same(draft, view.policy);
  const edit = <K extends PolicySection>(section: K, index: number, rule: SecurityPolicy[K][number] | undefined) => {
    const list = [...draft[section]] as SecurityPolicy[K][number][];
    if (rule) list[index] = rule;
    else list.splice(index, 1);
    setDraft({ ...draft, [section]: list });
  };
  const add = <K extends PolicySection>(section: K, rule: SecurityPolicy[K][number]) => setDraft({ ...draft, [section]: [...draft[section], rule] });
  const remove = (section: PolicySection, i: number, label: string) => (
    <button class="security-icon codicon codicon-close" title={`Remove ${label}`} aria-label={`Remove ${label}`} onClick={() => edit(section, i, undefined)} />
  );
  return (
    <div class="security">
      {view.sandbox === 'none' && (
        <div class="security-banner" data-testid="security-off">
          <span>
            ⚠ The sandbox is off (<code>flotilla.agents.sandbox: none</code>): agents run on this machine, and this policy applies once it's on.
          </span>
          <button class="security-button primary" onClick={props.enableSandbox}>
            Turn sandbox on
          </button>
        </div>
      )}
      <div class="security-head">
        <div>
          <h1>Security of sandboxed agents</h1>
          <div class="security-scope">
            <span class="dim">Policy in force:</span>
            <div class="security-switch" role="radiogroup" aria-label="Policy in force" data-testid="security-scope">
              <button role="radio" aria-checked={view.scope === 'all'} class={view.scope === 'all' ? 'on' : ''} onClick={() => props.setScope('all')}>
                All repositories
              </button>
              <button
                role="radio"
                aria-checked={view.scope === 'repository'}
                class={view.scope === 'repository' ? 'on' : ''}
                disabled={!view.canScopeRepository}
                onClick={() => props.setScope('repository')}
              >
                This repository
              </button>
            </div>
          </div>
          <div class="security-file dim" title="Outside every worktree and the backlog folder: agents can't reach it">
            {view.saved ? 'Saves to' : 'Flotilla’s strict default; saves to'} <code>{view.file}</code>
          </div>
        </div>
        <div class="security-actions">
          <button
            class="security-button"
            title="Bring back Flotilla's strict default (then Save)"
            disabled={same(draft, view.defaults)}
            onClick={() => setDraft(view.defaults)}
          >
            Reset
          </button>
          <button class="security-button primary" disabled={!dirty || props.saving} onClick={() => props.save(draft)}>
            {props.saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      {view.status && !dirty && <div class="security-status">{view.status}</div>}

      <section data-testid="security-files">
        <h2>
          Files <span class="dim">folders agents may read and write</span> <When now={false} />
        </h2>
        <Errors errors={errors} section="files" index={-1} />
        {view.fixed.map((r) => (
          <div class="security-row fixed" title={`Flotilla always adds this: ${r.reason}`}>
            <span class="codicon codicon-lock" />
            <span class="security-access">{r.access === 'read' ? 'Read only' : 'Read & write'}</span>
            <code class="security-path">{r.path}</code>
            <span class="dim">{r.reason} · fixed</span>
          </div>
        ))}
        {draft.files.map((r, i) => (
          <>
            <div class="security-row">
              <span class="codicon codicon-blank" />
              <select
                class="security-access"
                value={r.access}
                onChange={(e) => edit('files', i, { ...r, access: (e.target as HTMLSelectElement).value as FileAccess })}
              >
                <option value="read">Read only</option>
                <option value="read-write">Read &amp; write</option>
              </select>
              <input
                class="security-path"
                value={r.path}
                aria-label="Folder"
                onInput={(e) => edit('files', i, { ...r, path: (e.target as HTMLInputElement).value })}
              />
              {remove('files', i, r.path)}
            </div>
            <Errors errors={errors} section="files" index={i} />
          </>
        ))}
        <button class="security-add" onClick={() => add('files', { path: '', access: 'read' })}>
          + Add folder
        </button>
      </section>

      <section data-testid="security-network">
        <h2>
          Network <span class="dim">hosts agents may reach</span> <When now />
        </h2>
        <Errors errors={errors} section="network" index={-1} />
        {draft.network.map((r, i) => (
          <>
            <div class="security-row">
              <span class="codicon codicon-globe" />
              <input
                class="security-path"
                value={r.host}
                aria-label="Host"
                onInput={(e) => edit('network', i, { ...r, host: (e.target as HTMLInputElement).value })}
              />
              <input
                class="security-port"
                value={String(r.port)}
                aria-label="Port"
                inputMode="numeric"
                onInput={(e) => edit('network', i, { ...r, port: Number((e.target as HTMLInputElement).value) })}
              />
              {remove('network', i, r.host)}
            </div>
            <Errors errors={errors} section="network" index={i} />
          </>
        ))}
        <button class="security-add" onClick={() => add('network', { host: '', port: 443 })}>
          + Add host
        </button>
      </section>

      <section data-testid="security-commands">
        <h2>
          Commands <span class="dim">programs that may reach those hosts (* and ** match)</span> <When now />
        </h2>
        <Errors errors={errors} section="commands" index={-1} />
        {draft.commands.map((r, i) => (
          <>
            <div class="security-row">
              <span class="codicon codicon-terminal" />
              <input
                class="security-path"
                value={r.path}
                aria-label="Command"
                onInput={(e) => edit('commands', i, { path: (e.target as HTMLInputElement).value })}
              />
              {remove('commands', i, r.path)}
            </div>
            <Errors errors={errors} section="commands" index={i} />
          </>
        ))}
        <button class="security-add" onClick={() => add('commands', { path: '' })}>
          + Add command
        </button>
      </section>
    </div>
  );
}

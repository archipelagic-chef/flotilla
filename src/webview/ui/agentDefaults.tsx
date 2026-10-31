import {
  useEffect,
  useRef,
  useState,
} from 'preact/hooks';
import {
  AGENT_EFFORTS,
  AGENT_MODELS,
  type AgentChoice,
  modelLabel,
} from '../../features/backlog/backlog';
import type { BacklogMessage } from '../backlogActions';
import {
  act,
  useBusy,
} from './backlogBusy';

interface Choice {
  key: string;
  label: string;
  detail?: string;
  icon: string;
  checked?: boolean;
  message: BacklogMessage;
}

/** A dropdown of the title bar: its button shows the choice, its menu the others; working until the host saved one. */
function DefaultMenu({ cls, icon, text, label, choices }: { cls: string; icon: string; text: string; label: string; choices: Choice[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const working = useBusy().has(choices[0].message);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <span class={`agent-default ${cls}`} ref={box}>
      <button
        class="agent-default-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={working}
        disabled={working}
        onClick={() => setOpen(!open)}
      >
        <i class={`codicon codicon-${working ? 'loading codicon-modifier-spin' : icon}`} />
        <span class="agent-default-text">{text}</span>
        <i class="codicon codicon-chevron-down chev-small" />
      </button>
      {open && (
        <span class="menu agent-default-menu" role="menu">
          {choices.map((c) => (
            <button
              key={c.key}
              role={c.checked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={c.checked}
              title={c.detail}
              onClick={() => {
                setOpen(false);
                act(c.message);
              }}
            >
              <i class={`codicon codicon-${c.checked ? 'check' : c.icon}`} />
              <span>{c.label}</span>
              {c.detail && <span class="menu-detail">{c.detail}</span>}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

const capital = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}`;

/**
 * The agents' default model and effort (BL-242), side by side under the backlog's title: for every ticket that hasn't
 * chosen its own. Saved to flotilla.agents.model and .effort.
 */
export function AgentDefaults({ defaults }: { defaults: AgentChoice }) {
  const { model, effort } = defaults;
  const custom = model && !AGENT_MODELS.some((m) => m.model === model.toLowerCase()) ? [model] : [];
  const setModel = (m: string | null): BacklogMessage => ({ type: 'backlog', op: 'defaultModel', model: m });
  const setEffort = (e: (typeof AGENT_EFFORTS)[number] | null): BacklogMessage => ({ type: 'backlog', op: 'defaultEffort', effort: e });
  return (
    <div class="agent-defaults">
      <DefaultMenu
        cls="agent-default-model"
        icon="hubot"
        text={model ? modelLabel(model) : 'Model'}
        label={`Agents' default model: ${model ? modelLabel(model) : "Claude Code's"}. For every ticket that hasn't chosen its own. Change…`}
        choices={[
          { key: '', label: "Claude Code's default", icon: 'circle-small', checked: !model, message: setModel(null) },
          ...AGENT_MODELS.map((m) => ({
            key: m.model,
            label: m.label,
            detail: m.detail,
            icon: 'hubot',
            checked: model?.toLowerCase() === m.model,
            message: setModel(m.model),
          })),
          ...custom.map((c) => ({ key: c, label: c, icon: 'hubot', checked: true, message: setModel(c) })),
          { key: 'other', label: 'Other Model…', icon: 'edit', message: setModel('other') },
        ]}
      />
      <DefaultMenu
        cls="agent-default-effort"
        icon="dashboard"
        text={effort ? capital(effort) : 'Effort'}
        label={`Agents' default effort: ${effort ?? "Claude Code's"}. For every ticket that hasn't chosen its own. Change…`}
        choices={[
          { key: '', label: "Claude Code's default", icon: 'circle-small', checked: !effort, message: setEffort(null) },
          ...AGENT_EFFORTS.map((e) => ({ key: e, label: capital(e), icon: 'dashboard', checked: effort === e, message: setEffort(e) })),
        ]}
      />
    </div>
  );
}

import { useEffect, useState } from 'preact/hooks';
import { AGENT_EFFORTS, type BacklogStatus, priorityFromName } from '../../features/backlog/backlog';
import type { TicketView, TicketWebviewMessage } from '../ticketProtocol';
import { PRIORITY } from '../ui/priority';
import { act, Dropdown, send, useWorking } from './actions';
import './header.css';

export const STATUSES: Array<{ status: BacklogStatus; label: string; icon: string }> = [
  { status: 'todo', label: 'To Do', icon: 'circle-large-outline' },
  { status: 'doing', label: 'In Progress', icon: 'circle-large-filled' },
  { status: 'review', label: 'In Review', icon: 'eye' },
  { status: 'done', label: 'Done', icon: 'pass-filled' },
];

export function Title({ ticket }: { ticket: TicketView }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(ticket.item.title);
  useEffect(() => setTitle(ticket.item.title), [ticket.item.title]);
  const save = () => {
    setEditing(false);
    if (title.trim() && title.trim() !== ticket.item.title) send({ type: 'title', title });
    else setTitle(ticket.item.title);
  };
  if (ticket.remote && !ticket.remote.edit?.canEditTitle) return <h1 class="title readonly">{ticket.item.title}</h1>;
  if (editing) {
    return (
      <input
        class="title-input"
        value={title}
        aria-label="Title"
        ref={(el) => el?.focus()}
        onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          else if (e.key === 'Escape') {
            setTitle(ticket.item.title);
            setEditing(false);
          }
        }}
        onBlur={save}
      />
    );
  }
  return (
    <h1 class="title" title={ticket.remote ? `Click to edit (in ${ticket.remote.label})` : 'Click to edit'} onClick={() => setEditing(true)}>
      {ticket.item.title}
    </h1>
  );
}

export const LANE_ICON: Record<BacklogStatus, string> = {
  todo: 'circle-large-outline',
  doing: 'circle-large-filled',
  review: 'eye',
  done: 'pass-filled',
};

/** An issue's status, with the moves its tracker's workflow offers from it now. */
export function StatusMenu({ ticket }: { ticket: TicketView }) {
  const remote = ticket.remote!;
  const moves = remote.edit?.transitions ?? [];
  const moving = useWorking({ type: 'transition', id: '' });
  return (
    <Dropdown
      class="status-menu"
      busy={moving}
      label={`Status: ${remote.statusName}${moves.length ? '. Change…' : ''}`}
      button={
        <>
          <i class={`codicon codicon-${LANE_ICON[ticket.item.status]}`} />
          <span>{remote.statusName || STATUSES.find((s) => s.status === ticket.item.status)?.label}</span>
        </>
      }
      items={moves.map((t) => ({
        key: t.id,
        // A move is named after its target status in most workflows; when it isn't, both show.
        label: t.name.toLowerCase() === t.to.toLowerCase() ? t.to : `${t.name} → ${t.to}`,
        icon: t.needs ? 'warning' : LANE_ICON[t.status],
        detail: t.needs ? `Needs ${t.needs.join(', ')}: done in the tracker` : undefined,
        onSelect: () => act({ type: 'transition', id: t.id }, 'Moving…'),
      }))}
    />
  );
}

/** An issue's priority, from the priorities its tracker has (P1–P5, Blocker…, whatever the site uses). */
export function RemotePriority({ current, names }: { current?: string; names: string[] }) {
  const level = (name?: string) => priorityFromName(name);
  const icon = (name?: string) => {
    const l = level(name);
    return l ? PRIORITY[l].icon : 'circle-small';
  };
  const cur = level(current);
  const saving = useWorking({ type: 'remotePriority', name: '' });
  return (
    <Dropdown
      class={`priority${cur ? ` p-${cur}` : ' unset'}`}
      busy={saving}
      label={`Priority: ${current ?? 'none'}. Change…`}
      button={
        <>
          <i class={`codicon codicon-${icon(current)}`} />
          <span>{current ?? 'Priority'}</span>
        </>
      }
      items={names.map((n) => ({
        key: n,
        label: n,
        icon: icon(n),
        class: level(n) ? `p-${level(n)}` : undefined,
        checked: n === current,
        onSelect: () => act({ type: 'remotePriority', name: n }, 'Saving…'),
      }))}
    />
  );
}

const MODELS: Array<{ model: string; label: string; detail: string }> = [
  { model: 'fable', label: 'Fable', detail: 'The most capable' },
  { model: 'opus', label: 'Opus', detail: 'Strong all-rounder' },
  { model: 'sonnet', label: 'Sonnet', detail: 'Fast and capable' },
  { model: 'haiku', label: 'Haiku', detail: 'Fastest, for small tasks' },
];

/** A model or effort chosen: saved to the ticket (a running agent takes it on its next turn). */
const pick = (message: Extract<TicketWebviewMessage, { type: 'agentModel' | 'agentEffort' }>) => act(message, 'Saving…');

const modelLabel = (model: string) => MODELS.find((m) => m.model === model.toLowerCase())?.label ?? model;

/**
 * Which model the ticket's agents run and how hard they think: the ticket's choice, or the default (the settings, else
 * Claude Code's).
 */
export function AgentPicker({ ticket }: { ticket: TicketView }) {
  const chosen = ticket.item.agent ?? {};
  const defaults = ticket.agentDefaults;
  // Light (BL-69): its work runs on the light model; reviews stay on the default.
  const light = !chosen.model && chosen.light && ticket.lightModel ? ticket.lightModel : undefined;
  const model = chosen.model ?? light ?? defaults.model;
  const effort = chosen.effort ?? defaults.effort;
  const defaultModel = defaults.model ? `Default (${modelLabel(defaults.model)})` : "Default (Claude Code's)";
  const defaultEffort = defaults.effort ? `Default (${defaults.effort})` : "Default (Claude Code's)";
  const custom = chosen.model && !MODELS.some((m) => m.model === chosen.model!.toLowerCase()) ? [chosen.model] : [];
  const savingModel = useWorking({ type: 'agentModel', model: null });
  const savingEffort = useWorking({ type: 'agentEffort', effort: null });
  return (
    <>
      <Dropdown
        class={`priority agent-choice${chosen.model || light ? '' : ' unset'}`}
        label={`Agents' model: ${model ? modelLabel(model) : 'default'}${light ? ' (Light)' : ''}. Change…`}
        busy={savingModel}
        button={
          <>
            <i class="codicon codicon-hubot" />
            <span>{model ? `${light ? 'Light: ' : ''}${modelLabel(model)}` : 'Model'}</span>
          </>
        }
        items={[
          { key: '', label: defaultModel, icon: 'circle-small', checked: !chosen.model && !light, onSelect: () => pick({ type: 'agentModel', model: null }) },
          ...(ticket.lightModel
            ? [
                {
                  key: 'light',
                  label: `Light (${modelLabel(ticket.lightModel)})`,
                  detail: 'Small, mechanical work. Reviewed by the default model; moves up to it when it turns out hard',
                  icon: 'feather',
                  checked: !!light,
                  onSelect: () => pick({ type: 'agentModel', model: 'light' }),
                },
              ]
            : []),
          ...MODELS.map((m) => ({
            key: m.model,
            label: m.label,
            detail: m.detail,
            icon: 'hubot',
            checked: chosen.model?.toLowerCase() === m.model,
            onSelect: () => pick({ type: 'agentModel', model: m.model }),
          })),
          ...custom.map((c) => ({ key: c, label: c, icon: 'hubot', checked: true, onSelect: () => pick({ type: 'agentModel', model: c }) })),
          { key: 'other', label: 'Other Model…', icon: 'edit', onSelect: () => pick({ type: 'agentModel', model: 'other' }) },
        ]}
      />
      <Dropdown
        class={`priority agent-choice${chosen.effort ? '' : ' unset'}`}
        label={`Agents' effort: ${effort ?? 'default'}. Change…`}
        busy={savingEffort}
        button={
          <>
            <i class="codicon codicon-dashboard" />
            <span>{effort ? `${effort[0].toUpperCase()}${effort.slice(1)} effort` : 'Effort'}</span>
          </>
        }
        items={[
          { key: '', label: defaultEffort, icon: 'circle-small', checked: !chosen.effort, onSelect: () => pick({ type: 'agentEffort', effort: null }) },
          ...AGENT_EFFORTS.map((e) => ({
            key: e,
            label: `${e[0].toUpperCase()}${e.slice(1)}`,
            icon: 'dashboard',
            checked: chosen.effort === e,
            onSelect: () => pick({ type: 'agentEffort', effort: e }),
          })),
        ]}
      />
    </>
  );
}

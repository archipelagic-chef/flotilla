import type { ComponentChildren } from 'preact';
import type { AttentionState } from '../../features/workstreams/attention';
import type { Tab, WorkstreamView } from '../protocol';
import { menuContext, run } from './api';
import { dropTarget } from './files';

const ATTENTION_ICON: Record<AttentionState, string> = {
  'waiting-for-input': 'bell-dot st-waiting',
  error: 'error st-error',
  working: 'sync codicon-modifier-spin st-working',
  done: 'pass st-done',
  active: 'pulse',
  idle: 'circle-outline',
  stale: 'history muted',
  unreachable: 'debug-disconnect muted',
};

interface Props {
  ws: WorkstreamView;
  tab: Tab;
  /** The worktree's color, shared with its rail tile. */
  color: string;
  /** This is the worktree at the top of the list (its tile is highlighted too). */
  active: boolean;
  collapsed: boolean;
  flash: boolean;
  onToggle(): void;
  children: ComponentChildren;
}

/** One workstream: a sticky header and the body of the current tab. */
export function Section({ ws, tab, color, active, collapsed, flash, onToggle, children }: Props) {
  const open = ws.chats.filter((c) => c.open);
  const waiting = open.find((c) => c.state === 'waiting-for-input');
  const target = { key: ws.key };
  return (
    <section
      class={`section${collapsed ? ' collapsed' : ''}${flash ? ' flash' : ''}${active ? ' active' : ''}`}
      data-section={ws.key}
      style={{ '--ws-color': color }}
    >
      <div
        class="sec-head"
        data-vscode-context={menuContext('workstream', { key: ws.key, flotillaWs: ws.context, flotillaTab: tab })}
        {...(tab === 'files' && ws.reachable ? dropTarget(ws.key, '') : {})}
        onClick={onToggle}
        title={ws.tooltip}
      >
        <div class="sec-line">
          <i class={`codicon codicon-chevron-${collapsed ? 'right' : 'down'} chev`} />
          <i class={`codicon codicon-${ATTENTION_ICON[ws.attention]}`} />
          <span class="branch">{ws.branch}</span>
          {open.length > 0 && (
            <span class={`chip${waiting ? ' st-waiting' : ''}`} title={`${open.length} open chat(s)`}>
              <i class={`codicon codicon-${waiting ? 'bell-dot' : 'comment-discussion'}`} />
              {open.length}
            </span>
          )}
          <span class="actions" onClick={(e) => e.stopPropagation()}>
            {ws.reachable && tab === 'files' && (
              <>
                <button class="icon" title="New File…" onClick={() => run('flotilla.newFile', target)}>
                  <i class="codicon codicon-new-file" />
                </button>
                <button class="icon" title="New Folder…" onClick={() => run('flotilla.newFolder', target)}>
                  <i class="codicon codicon-new-folder" />
                </button>
              </>
            )}
            {ws.reachable && tab !== 'files' && (
              <button class="icon" title="New Chat Here" onClick={() => run('flotilla.newChat', target)}>
                <i class="codicon codicon-comment-discussion" />
              </button>
            )}
            {ws.reachable && !ws.isCurrent && (
              <button class="icon" title="Open in New Window" onClick={() => run('flotilla.openInNewWindow', target)}>
                <i class="codicon codicon-empty-window" />
              </button>
            )}
          </span>
        </div>
        {ws.description && <div class="sec-meta">{ws.description}</div>}
        {waiting?.message && tab !== 'chats' && (
          <div class="sec-msg">
            <i class="codicon codicon-bell" />
            <span>“{waiting.message}”</span>
          </div>
        )}
      </div>
      {!collapsed && (ws.reachable ? <div class="sec-body">{children}</div> : <div class="empty">Not reachable from this environment.</div>)}
    </section>
  );
}

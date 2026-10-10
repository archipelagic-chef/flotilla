import type { ComponentChildren } from 'preact';
import type { AttentionState } from '../../features/workstreams/attention';
import type { Tool, WorkstreamView } from '../protocol';
import { menuContext, run } from './api';
import { dropTarget } from './files';

export const ATTENTION_ICON: Record<AttentionState, string> = {
  'waiting-for-input': 'bell-dot st-waiting',
  error: 'error st-error',
  working: 'sync codicon-modifier-spin st-working',
  done: 'pass st-done',
  active: 'pulse',
  idle: 'circle-outline',
  stale: 'history muted',
  unreachable: 'debug-disconnect muted',
};

/** Branch, status icon and open-chat chip: the first line of a worktree header. */
function Title({ ws }: { ws: WorkstreamView }) {
  const open = ws.chats.filter((c) => c.open);
  const waiting = open.find((c) => c.state === 'waiting-for-input');
  return (
    <>
      <i class={`codicon codicon-${ATTENTION_ICON[ws.attention]}`} />
      <span class="branch" data-tip={ws.branch} data-tip-if-cut>
        {ws.branch}
      </span>
      {open.length > 0 && (
        <span class={`chip${waiting ? ' st-waiting' : ''}`} data-tip={`${open.length} open chat(s)`}>
          <i class={`codicon codicon-${waiting ? 'bell-dot' : 'comment-discussion'}`} />
          {open.length}
        </span>
      )}
    </>
  );
}

/** Actions on the right of a worktree header; they depend on the tool. */
function Actions({ ws, tool }: { ws: WorkstreamView; tool: Tool }) {
  const target = { key: ws.key };
  if (!ws.reachable) return null;
  return (
    <span class="actions" onClick={(e) => e.stopPropagation()}>
      {tool === 'files' && (
        <>
          <button class="icon" aria-label="New File…" onClick={() => run('flotilla.newFile', target)}>
            <i class="codicon codicon-new-file" />
          </button>
          <button class="icon" aria-label="New Folder…" onClick={() => run('flotilla.newFolder', target)}>
            <i class="codicon codicon-new-folder" />
          </button>
        </>
      )}
      {tool === 'vc' && ws.sync.kind === 'publish' && (
        <button class="icon" aria-label="Publish Branch" onClick={() => run('flotilla.publish', target)}>
          <i class="codicon codicon-cloud-upload" />
        </button>
      )}
      {tool === 'vc' && ws.sync.kind === 'sync' && (
        <button class="icon" aria-label={`Sync Changes (${ws.sync.text})`} onClick={() => run('flotilla.sync', target)}>
          <i class="codicon codicon-sync" />
        </button>
      )}
      {tool !== 'files' && (
        <button class="icon" aria-label="New Chat" onClick={() => run('flotilla.newChat', target)}>
          <i class="codicon codicon-comment-discussion" />
        </button>
      )}
      <button class="icon" aria-label="Open Terminal Here" onClick={() => run('flotilla.openTerminal', target)}>
        <i class="codicon codicon-terminal" />
      </button>
      {!ws.isCurrent && (
        <button class="icon" aria-label="Open in New Window" onClick={() => run('flotilla.openInNewWindow', target)}>
          <i class="codicon codicon-empty-window" />
        </button>
      )}
    </span>
  );
}

function Meta({ ws, tool }: { ws: WorkstreamView; tool: Tool }) {
  const waiting = ws.chats.find((c) => c.open && c.state === 'waiting-for-input');
  return (
    <>
      {ws.description && <div class="sec-meta">{ws.description}</div>}
      {waiting?.message && tool !== 'chats' && (
        <div class="sec-msg">
          <i class="codicon codicon-bell" />
          <span>“{waiting.message}”</span>
        </div>
      )}
    </>
  );
}

/** The header above a single worktree's content (a worktree tab is active). */
export function WorktreeHeader({ ws, tool }: { ws: WorkstreamView; tool: Tool }) {
  return (
    <div
      class="ws-head"
      data-vscode-context={menuContext('workstream', { key: ws.key, flotillaWs: ws.context, flotillaTab: tool })}
      {...(tool === 'files' && ws.reachable ? dropTarget(ws.key, '') : {})}
    >
      <div class="sec-line">
        <Title ws={ws} />
        <Actions ws={ws} tool={tool} />
      </div>
      <Meta ws={ws} tool={tool} />
    </div>
  );
}

interface Props {
  ws: WorkstreamView;
  tool: Tool;
  /** The worktree's color, shared with its tab. */
  color: string;
  collapsed: boolean;
  onToggle(): void;
  /** Makes this worktree the active tab. */
  onSelect(): void;
  children: ComponentChildren;
}

/** One worktree in the All tab: a sticky header and the body of the current tool. */
export function Section({ ws, tool, color, collapsed, onToggle, onSelect, children }: Props) {
  return (
    <section class={`section${collapsed ? ' collapsed' : ''}`} data-section={ws.key} style={{ '--ws-color': color }}>
      <div
        class="sec-head"
        data-vscode-context={menuContext('workstream', { key: ws.key, flotillaWs: ws.context, flotillaTab: tool })}
        {...(tool === 'files' && ws.reachable ? dropTarget(ws.key, '') : {})}
        onClick={onToggle}
        onDblClick={onSelect}
      >
        <div class="sec-line">
          <Title ws={ws} />
          <span class="actions" onClick={(e) => e.stopPropagation()}>
            <button class="icon" aria-label="Open Its Tab" onClick={onSelect}>
              <i class="codicon codicon-arrow-right" />
            </button>
          </span>
          <Actions ws={ws} tool={tool} />
          {/* No chevron on the left (the trees below have those): a fold button, always shown while folded. */}
          <span class="fold" onClick={(e) => e.stopPropagation()}>
            <button class="icon" aria-label={collapsed ? 'Unfold' : 'Fold'} aria-expanded={!collapsed} onClick={onToggle}>
              <i class={`codicon codicon-${collapsed ? 'unfold' : 'fold'}`} />
            </button>
          </span>
        </div>
        <Meta ws={ws} tool={tool} />
      </div>
      {!collapsed && (ws.reachable ? <div class="sec-body">{children}</div> : <div class="empty">Not reachable from this environment.</div>)}
    </section>
  );
}

import type { AttentionState } from '../../features/workstreams/attention';
import type { WorkstreamView } from '../protocol';
import { menuContext, run } from './api';
import { ATTENTION_ICON } from './section';

/** Most urgent first, like the attention order everywhere else in Flotilla. */
const RANK: Record<AttentionState, number> = {
  'waiting-for-input': 0,
  error: 1,
  working: 2,
  done: 3,
  active: 4,
  idle: 5,
  stale: 6,
  unreachable: 7,
};

interface Props {
  workstreams: readonly WorkstreamView[];
  active: string;
  colors: ReadonlyMap<string, string>;
  onSelect(key: string): void;
}

/** Every worktree at once, sorted by what needs you. Click one to open its tab. */
export function Overview({ workstreams, active, colors, onSelect }: Props) {
  const sorted = [...workstreams].sort((a, b) => RANK[a.attention] - RANK[b.attention]);
  return (
    <div class="overview">
      <div class="tool-title">All worktrees, most urgent first</div>
      {sorted.map((ws) => {
        const open = ws.chats.filter((c) => c.open);
        const waiting = open.find((c) => c.state === 'waiting-for-input');
        const changes = ws.staged.length + ws.unstaged.length;
        const facts = [
          changes ? `${changes} changed` : 'no changes',
          ws.sync.text,
          open.length ? `${open.length} open chat${open.length === 1 ? '' : 's'}` : '',
        ].filter(Boolean);
        return (
          <div
            key={ws.key}
            class={`card${active === ws.key ? ' current' : ''}`}
            role="button"
            tabIndex={0}
            style={{ '--ws-color': colors.get(ws.key) }}
            title={`${ws.tooltip}\n\nOpen its tab`}
            data-vscode-context={menuContext('workstream', { key: ws.key, flotillaWs: ws.context, flotillaTab: 'overview' })}
            onClick={() => onSelect(ws.key)}
            onKeyDown={(e) => e.key === 'Enter' && onSelect(ws.key)}
          >
            <div class="sec-line">
              <i class={`codicon codicon-${ATTENTION_ICON[ws.attention]}`} />
              <span class="branch">{ws.branch}</span>
              <span class="actions" onClick={(e) => e.stopPropagation()}>
                {ws.reachable && (
                  <button class="icon" title="New Chat" onClick={() => run('flotilla.newChat', { key: ws.key })}>
                    <i class="codicon codicon-comment-discussion" />
                  </button>
                )}
              </span>
            </div>
            <div class="sec-meta">{ws.description}</div>
            <div class="sec-meta">{facts.join(' · ')}</div>
            {waiting?.message && (
              <div class="sec-msg">
                <i class="codicon codicon-bell" />
                <span>“{waiting.message}”</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

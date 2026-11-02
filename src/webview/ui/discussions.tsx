import { useState } from 'preact/hooks';
import type { DiscussionRowView } from '../protocol';
import { shortTime } from '../shortTime';
import { send } from './api';
import './discussions.css';

/**
 * The Discussions section (BL-267), under the Notes lane: folded, like Past notes, its rows the discussions talked in,
 * newest first. A click opens one's tab; Rename and Delete show as the row is hovered. New Discussion is in the title bar.
 */
export function DiscussionsLane({ discussions }: { discussions: DiscussionRowView[] }) {
  const [open, setOpen] = useState(false);
  if (!discussions.length) return null;
  return (
    <div class="group lane discussions-lane">
      <div class="row group-head" onClick={() => setOpen(!open)}>
        <span class="name">Discussions</span>
        <i class={`codicon codicon-chevron-${open ? 'down' : 'right'} lane-chev`} aria-label={open ? 'Hide the discussions' : 'Show the discussions'} />
        <span class="badge">{discussions.length}</span>
      </div>
      {open && (
        <div class="lane-body">
          {discussions.map((d) => (
            <div
              key={d.id}
              class="row discussion-row"
              role="button"
              tabIndex={0}
              title={`Open the discussion: ${d.title}`}
              onClick={() => send({ type: 'discussion', op: 'open', id: d.id })}
              onKeyDown={(e) => e.key === 'Enter' && send({ type: 'discussion', op: 'open', id: d.id })}
            >
              <i class="codicon codicon-comment-discussion" />
              <span class="discussion-title">{d.title}</span>
              <span class="discussion-when">{shortTime(d.talked)}</span>
              <span class="discussion-actions">
                <button
                  class="icon"
                  aria-label={`Rename ${d.title}`}
                  title="Rename"
                  onClick={(e) => {
                    e.stopPropagation();
                    send({ type: 'discussion', op: 'rename', id: d.id });
                  }}
                >
                  <i class="codicon codicon-edit" />
                </button>
                <button
                  class="icon"
                  aria-label={`Delete ${d.title}`}
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    send({ type: 'discussion', op: 'delete', id: d.id });
                  }}
                >
                  <i class="codicon codicon-trash" />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

import { useState } from 'preact/hooks';
import type { MergeQueueView } from '../protocol';
import { send } from './api';
import { BusyButton } from './backlogBusy';
import './mergeQueueBar.css';

/** A ticket dragged within the merge queue bar (BL-144): the lanes don't take it. */
const QUEUE_DRAG_TYPE = 'application/x-flotilla-merge-queue';

/**
 * The merge queue (BL-140), above the board: the tickets waiting to land, first to land first, each opening its ticket
 * (one that conflicts with the ones ahead of it is marked), what the queue does now, and Land All (Merge All Ready).
 * Its tickets are dragged to change the order they land in (BL-144), and each one's × takes it out of the queue, even
 * while Land All runs; Land All, Resolving Conflicts has an agent resolve each conflict, approved without asking (BL-226).
 */
export function MergeQueueBar({ queue }: { queue: MergeQueueView }) {
  // Where a dragged ticket would go: before this one, or at the end (null).
  const [dropBefore, setDropBefore] = useState<string | null>();
  const ids = queue.entries.map((e) => e.id);
  const dragOver = (e: DragEvent, before: string | null) => {
    if (!e.dataTransfer?.types.includes(QUEUE_DRAG_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDropBefore(before);
  };
  const drop = (e: DragEvent) => {
    const id = e.dataTransfer?.getData(QUEUE_DRAG_TYPE);
    const before = dropBefore;
    setDropBefore(undefined);
    if (!id || before === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const order = moveBefore(ids, id, before);
    if (order.join() !== ids.join()) send({ type: 'backlog', op: 'queueOrder', ids: order });
  };
  return (
    <div class="merge-queue-bar">
      <i class="codicon codicon-git-merge" />
      <span>
        <strong>Merge queue</strong>
        {queue.working ? ` · ${capitalizeFirst(queue.working)}` : ''}
        {' · '}
        <span class="queue-entries" onDragOver={(e) => dragOver(e, null)} onDragLeave={() => setDropBefore(undefined)} onDrop={drop}>
          {queue.entries.map((e, i) => (
            <span key={e.id} onDragOver={(ev) => dragOver(ev, e.id)}>
              {i > 0 && ', '}
              <a
                href="#"
                draggable
                onDragStart={(ev) => {
                  ev.dataTransfer?.setData(QUEUE_DRAG_TYPE, e.id);
                  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
                }}
                onDragEnd={() => setDropBefore(undefined)}
                class={
                  [e.state === 'conflicts' ? 'conflicts' : '', e.run === 'needs you' ? 'needs-you' : '', dropBefore === e.id ? 'drop-before' : '']
                    .filter(Boolean)
                    .join(' ') || undefined
                }
                title={`${
                  e.run === 'resolving'
                    ? `${e.id}: an agent resolves its conflicts with the tickets ahead of it (Land All, Resolving Conflicts)`
                    : e.run === 'needs you'
                      ? `${e.id} needs you: its ticket says why`
                      : e.state === 'conflicts'
                        ? `${e.id} conflicts with the tickets ahead of it: it waits`
                        : e.state === 'clean'
                          ? `${e.id} merges cleanly onto main and the tickets ahead`
                          : `${e.id}: the merge train is being built`
                } · drag to change the order`}
                onClick={(ev) => {
                  ev.preventDefault();
                  send({ type: 'backlog', op: 'open', id: e.id });
                }}
              >
                {e.id}
                {e.run === 'resolving' ? ' (resolving)' : e.run === 'needs you' ? ' (needs you)' : e.state === 'conflicts' && ' (conflicts)'}
              </a>
              <BusyButton
                class="dequeue"
                message={{ type: 'backlog', op: 'dequeue', id: e.id }}
                title={`Take ${e.id} out of the merge queue`}
                aria-label={`Take ${e.id} out of the merge queue`}
              >
                ×
              </BusyButton>
            </span>
          ))}
          {dropBefore === null && <span class="drop-end" />}
        </span>
      </span>
      <BusyButton
        class="land-all"
        disabled={!!queue.working}
        message={{ type: 'backlog', op: 'landAll' }}
        title="Merge All Ready: lands the queue's tickets in order, each after its checks"
      >
        Land All
      </BusyButton>
      <BusyButton
        class="land-all"
        disabled={!!queue.working}
        message={{ type: 'backlog', op: 'landAll', resolve: true }}
        title="Lands the queue's tickets in order, each after its checks; an agent resolves each one that conflicts, and its resolution is approved without asking you"
      >
        Land All, Resolving Conflicts
      </BusyButton>
    </div>
  );
}

/** The ids with one moved before another (null: to the end). */
function moveBefore(ids: readonly string[], id: string, before: string | null): string[] {
  if (id === before) return [...ids];
  const rest = ids.filter((x) => x !== id);
  const at = before === null ? rest.length : rest.indexOf(before);
  return at < 0 ? [...ids] : [...rest.slice(0, at), id, ...rest.slice(at)];
}

const capitalizeFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

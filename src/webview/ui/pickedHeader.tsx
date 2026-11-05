import type { Shown } from './picked';
import { BusyButton } from './backlogBusy';

interface Props {
  view: Shown;
  /** In the Backlog's list: the card is there, so the bar scrolls to it rather than going back to it. */
  here?: boolean;
  /** Back to the selected item's card (main's row) in the Backlog, or to it in the list. */
  back(): void;
  /** Shows another of the ticket's worktrees. */
  pickWorktree(key: string): void;
}

/**
 * The selected item (BL-290), in a bar above the Backlog, Files, Search and Version Control that stays as they scroll:
 * click it to go back to its card.
 */
export function PickedHeader({ view, here, back, pickWorktree }: Props) {
  const { ticket, ws, worktrees, picked } = view;
  const name = ticket ? `${ticket.id} · ${ticket.title}` : picked.kind === 'main' ? (ws?.branch ?? 'main') : (ws?.label ?? '');
  const icon = ticket ? 'issues' : picked.kind === 'main' ? 'home' : 'git-branch';
  return (
    <div class="picked-head">
      <button
        class="picked-name"
        aria-label={`Selected: ${name} (${here ? 'show it' : 'back to it in the Backlog'})`}
        title={here ? 'Show it in the Backlog' : 'Back to it in the Backlog'}
        onClick={back}
      >
        <i class={`codicon codicon-${icon}`} />
        <span class="nm">{name}</span>
        <span class="back">
          <i class={`codicon codicon-${here ? 'eye' : 'arrow-left'}`} />
          {here ? 'Show' : ticket ? 'Its card' : 'Backlog'}
        </span>
      </button>
      {worktrees.length > 1 && (
        <div class="picked-worktrees" role="radiogroup" aria-label={`${ticket?.id}'s worktrees`}>
          {worktrees.map((w) => (
            <button key={w.key} role="radio" aria-checked={w.key === ws?.key} onClick={() => pickWorktree(w.key)}>
              <i class="codicon codicon-git-branch" />
              {w.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A selected ticket with no worktree yet: nothing to show in Files or Search; Start makes one. */
export function NoWorktree({ id }: { id: string }) {
  return (
    <div class="empty picked-none">
      {id} has no worktree yet.{' '}
      <BusyButton class="link" aria-label={`Start ${id}`} message={{ type: 'backlog', op: 'start', id }} icon="play">
        Start
      </BusyButton>
    </div>
  );
}

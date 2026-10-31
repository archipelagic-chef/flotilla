import type { JSX } from 'preact';
import {
  useEffect,
  useState,
} from 'preact/hooks';
import {
  backlogActionKey,
  type BacklogMessage,
  BusyActions,
} from '../backlogActions';
import { WORKING_MIN_MS } from '../workingMin';
import { send } from './api';

/** The backlog's actions the host hasn't finished (BL-117): set on click, cleared by its backlogDone. */
const busy = new BusyActions();
/** When each action in progress was clicked: it shows working for at least WORKING_MIN_MS. */
const started = new Map<string, number>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

/** Sends a backlog action, shown as working until the host is done with it; a second click while it is does nothing. */
export function act(message: BacklogMessage): void {
  if (!busy.start(message)) return;
  started.set(backlogActionKey(message), Date.now());
  notify();
  send(message);
}

/** The host is done with an action (or it failed). */
export function finished(message: BacklogMessage): void {
  const key = backlogActionKey(message);
  const clicked = started.get(key);
  // A quick action still shows it worked: it stays working a moment (a second click meanwhile does nothing).
  setTimeout(
    () => {
      if (started.get(key) !== clicked) return;
      started.delete(key);
      busy.finish(message);
      notify();
    },
    clicked === undefined ? 0 : Math.max(0, clicked + WORKING_MIN_MS - Date.now()),
  );
}

/** The backlog was posted: actions on items that went (dismissed, deleted) end. */
export function pruneBusy(ids: ReadonlySet<string>): void {
  if (busy.prune(ids)) notify();
}

/** Re-renders as actions start and end. */
export function useBusy(): BusyActions {
  const [, refresh] = useState(0);
  useEffect(() => {
    const listener = () => refresh((n) => n + 1);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
  return busy;
}

/** A button for a backlog action: its icon spins and it takes no click from the click until the host is done. */
export function BusyButton({
  message,
  icon,
  children,
  onClick,
  ...props
}: Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'icon'> & { message: BacklogMessage; icon?: string }) {
  const working = useBusy().has(message);
  return (
    <button
      {...props}
      disabled={props.disabled || working}
      aria-busy={working}
      onClick={(e) => {
        onClick?.(e);
        act(message);
      }}
    >
      {(icon || working) && <i class={`codicon codicon-${working ? 'loading codicon-modifier-spin' : icon}`} />}
      {children}
    </button>
  );
}

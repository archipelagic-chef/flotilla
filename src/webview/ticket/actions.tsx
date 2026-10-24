import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { capitalize } from '../../features/backlog/mainDrift';
import type { TicketWebviewMessage } from '../ticketProtocol';
import { actionKey } from '../ticketActions';
import { WORKING_MIN_MS } from '../workingMin';
import { commentSent } from './comments';
import './actions.css';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();
export const send = (message: TicketWebviewMessage) => vscode.postMessage(message);

/**
 * The actions the host hasn't finished, by actionKey: "working…" shows from the click until the host says it's done
 * (it does so for every action, whether it posted, failed or did nothing).
 */
const working = new Map<string, string>();
/** When each action in progress was clicked: its "working…" shows for at least WORKING_MIN_MS. */
const started = new Map<string, number>();
const workingListeners = new Set<() => void>();
export const doneListeners = new Set<(message: TicketWebviewMessage, failed: boolean) => void>();

const notifyWorking = () => workingListeners.forEach((f) => f());

/** Sends an action, and shows it as working (its label) until the host is done with it. */
export function act(message: TicketWebviewMessage, label = 'Working…') {
  working.set(actionKey(message), label);
  started.set(actionKey(message), Date.now());
  notifyWorking();
  send(message);
}

/** Re-renders the component whenever an action starts or ends. */
export function useWorkingChanges() {
  const [, refresh] = useState(0);
  useEffect(() => {
    const listener = () => refresh((n) => n + 1);
    workingListeners.add(listener);
    return () => void workingListeners.delete(listener);
  }, []);
}

/** The label of an action in progress (undefined when it isn't). */
export const workingLabel = (message: TicketWebviewMessage) => working.get(actionKey(message));

/** The label of an action in progress (undefined when it isn't), re-rendered as it starts and ends. */
export function useWorking(message: TicketWebviewMessage): string | undefined {
  useWorkingChanges();
  return workingLabel(message);
}

/** Called when the host is done with an action: failed if it threw. */
export function finished(message: TicketWebviewMessage, failed: boolean) {
  const key = actionKey(message);
  const clicked = started.get(key);
  // A quick action still shows it worked: its "working…" stays a moment (unless it's clicked again meanwhile).
  setTimeout(
    () => {
      if (started.get(key) !== clicked) return;
      started.delete(key);
      working.delete(key);
      notifyWorking();
    },
    clicked === undefined ? 0 : Math.max(0, clicked + WORKING_MIN_MS - Date.now()),
  );
  if (message.type === 'comment') commentSent(message.text);
  if (message.type === 'run') {
    // The Run button of a run block (set on click, in Rendered): its working state ends.
    document.querySelectorAll<HTMLElement>(`[data-run-key="${CSS.escape(message.key)}"][data-run-index="${message.index}"]`).forEach((run) => {
      run.removeAttribute('data-busy');
      (run as HTMLButtonElement).disabled = false;
    });
  }
  doneListeners.forEach((f) => f(message, failed));
}

/** A button for an action: it says "working…" (after its label) from the click until the host is done with it. */
export function ActionButton({
  message,
  working: label,
  children,
  ...props
}: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { message: TicketWebviewMessage; working?: string }) {
  const busy = useWorking(message);
  return (
    <button {...props} disabled={props.disabled || !!busy} aria-busy={!!busy} onClick={() => act(message, label)}>
      {children}
      {busy && <WorkingTag label={busy} />}
    </button>
  );
}

const UPDATE_SPIN_MS = 1500;

/**
 * Update from Main: from the click until the merge (or the hand-off to the agent) is done, its arrows spin, it says
 * "Updating…" and it takes no second click. It spins for at least UPDATE_SPIN_MS, so that a merge done at once is seen too.
 */
export function UpdateFromButton({ base, ...props }: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { base: string }) {
  const message: TicketWebviewMessage = { type: 'updateFromMain' };
  const working = !!useWorking(message);
  const [spinning, setSpinning] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const click = () => {
    setSpinning(true);
    timer.current = setTimeout(() => setSpinning(false), UPDATE_SPIN_MS);
    act(message, 'Updating…');
  };
  const busy = working || spinning;
  return (
    <button {...props} disabled={busy} aria-busy={busy} onClick={click}>
      <i class={`codicon codicon-sync${busy ? ' codicon-modifier-spin' : ''}`} /> {busy ? 'Updating…' : `Update from ${capitalize(base)}`}
    </button>
  );
}

/** "working…" beside an action that's in progress. */
export function WorkingTag({ label }: { label: string }) {
  return (
    <span class="action-busy" role="status">
      <i class="codicon codicon-loading codicon-modifier-spin" /> {label}
    </span>
  );
}

interface MenuItem {
  key: string;
  label: string;
  icon: string;
  /** Classes on the item (colours its icon). */
  class?: string;
  detail?: string;
  checked?: boolean;
  onSelect(): void;
}

/** A button that opens a menu below it. */
export function Dropdown({ class: cls, button, label, items, busy }: { class: string; button: ComponentChildren; label: string; items: MenuItem[]; busy?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
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
    <span class={`dropdown ${cls}`} ref={box}>
      <button
        class="dropdown-button priority-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!items.length}
        onClick={() => setOpen(!open)}
      >
        {button}
        {busy && <WorkingTag label={busy} />}
        {items.length > 0 && <i class="codicon codicon-chevron-down chev-small" />}
      </button>
      {open && (
        <span class="menu priority-menu" role="menu">
          {items.map((i) => (
            <button
              key={i.key}
              role={i.checked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={i.checked}
              class={i.class}
              title={i.detail}
              onClick={() => {
                setOpen(false);
                i.onSelect();
              }}
            >
              <i class={`codicon codicon-${i.icon}`} />
              <span>{i.label}</span>
              {i.detail && <span class="menu-detail">{i.detail}</span>}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

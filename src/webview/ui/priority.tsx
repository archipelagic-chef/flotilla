import {
  useEffect,
  useRef,
  useState,
} from 'preact/hooks';
import type { BacklogPriority } from '../protocol';

export const PRIORITY: Record<BacklogPriority, { label: string; icon: string }> = {
  urgent: { label: 'Urgent', icon: 'flame' },
  high: { label: 'High', icon: 'arrow-up' },
  medium: { label: 'Medium', icon: 'circle-small-filled' },
  low: { label: 'Low', icon: 'arrow-down' },
};
const ORDER: BacklogPriority[] = ['urgent', 'high', 'medium', 'low'];

/**
 * An item's priority: its icon (or, unset, a faint one that shows on hover), which opens a menu to change it.
 * compact: just the icon (backlog rows); otherwise the icon and its name (ticket header). Without onChange it only
 * shows it (issues from trackers).
 */
export function PriorityPicker({
  value,
  onChange,
  compact,
}: {
  value: BacklogPriority | undefined;
  onChange?(priority: BacklogPriority | null): void;
  compact?: boolean;
}) {
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
  const meta = value && PRIORITY[value];
  const label = meta ? `Priority: ${meta.label}` : 'No priority';
  return (
    <span class={`priority${compact ? ' compact' : ''}${value ? ` p-${value}` : ' unset'}`} ref={box} onClick={(e) => e.stopPropagation()}>
      <button
        class="priority-button"
        aria-label={onChange ? `${label}. Change…` : label}
        aria-haspopup={onChange ? 'menu' : undefined}
        aria-expanded={onChange ? open : undefined}
        disabled={!onChange}
        onClick={() => setOpen(!open)}
      >
        <i class={`codicon codicon-${meta?.icon ?? 'circle-small'}`} />
        {!compact && <span>{meta?.label ?? 'Priority'}</span>}
        {!compact && onChange && <i class="codicon codicon-chevron-down chev-small" />}
      </button>
      {open && onChange && (
        <span class="menu priority-menu" role="menu">
          {ORDER.map((p) => (
            <button
              key={p}
              role="menuitemradio"
              aria-checked={value === p}
              class={`p-${p}`}
              onClick={() => {
                setOpen(false);
                onChange(p);
              }}
            >
              <i class={`codicon codicon-${PRIORITY[p].icon}`} />
              {PRIORITY[p].label}
            </button>
          ))}
          <button
            role="menuitemradio"
            aria-checked={!value}
            onClick={() => {
              setOpen(false);
              onChange(null);
            }}
          >
            <i class="codicon codicon-circle-small" />
            No priority
          </button>
        </span>
      )}
    </span>
  );
}

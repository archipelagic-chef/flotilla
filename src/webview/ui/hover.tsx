import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ciState, ciSummary } from '../../features/ci/summary';
import type { CiView, WorkstreamView } from '../protocol';
import { ATTENTION_ICON } from './section';

/**
 * Hovers that look like VS Code's own, instead of the browser's title tooltips. Mark an element with
 *   data-tip="text"         plain text; \n starts a new line
 *   data-keys="Ctrl+Alt+1"  a shortcut, drawn as keys
 *   data-tip-pos="right"    where it opens: below (default), above or right
 *   data-tip-if-cut         only when the element's text doesn't fit (shows an ellipsis)
 * Icon-only buttons need no data-tip: their aria-label is shown. Richer content comes from the render prop
 * (e.g. the worktree card for data-tip-ws).
 */
type Placement = 'below' | 'above' | 'right';

const SELECTOR = '[data-tip],[data-tip-ws],button[aria-label]';
/** Like workbench.hover.delay; moving on to the next element while a hover shows is instant, like VS Code. */
const DELAY = 500;
const GRACE = 300;
const GAP = 6;
const MARGIN = 4;

interface Shown {
  anchor: HTMLElement;
  content: ComponentChildren;
  placement: Placement;
}

export function Keys({ keys }: { keys: string }) {
  return (
    <span class="keys">
      {keys.split(/\s+/).map((chord, i) => (
        <span key={i} class="chord">
          {chord.split('+').map((k) => (
            <kbd key={k}>{k}</kbd>
          ))}
        </span>
      ))}
    </span>
  );
}

function plain(el: HTMLElement): ComponentChildren | undefined {
  // data-tip-if-cut: only when the element's text is cut off (an ellipsis), e.g. a long worktree name.
  if (el.hasAttribute('data-tip-if-cut') && el.scrollWidth <= el.clientWidth) return undefined;
  const text = el.dataset.tip ?? el.getAttribute('aria-label') ?? '';
  const keys = el.dataset.keys;
  if (!text && !keys) return undefined;
  return (
    <div class="hover-plain">
      {text}
      {keys && <Keys keys={keys} />}
    </div>
  );
}

export function Hover({ render }: { render(el: HTMLElement): ComponentChildren | undefined }) {
  const [shown, setShown] = useState<Shown>();
  const box = useRef<HTMLDivElement>(null);
  const pending = useRef<{ anchor: HTMLElement; timer: number }>();
  const lastHidden = useRef(0);
  const current = useRef<HTMLElement>();
  const renderRef = useRef(render);
  renderRef.current = render;

  useEffect(() => {
    const cancel = () => {
      if (pending.current) clearTimeout(pending.current.timer);
      pending.current = undefined;
    };
    const hide = () => {
      cancel();
      if (current.current) {
        current.current.removeAttribute('aria-describedby');
        current.current = undefined;
        lastHidden.current = Date.now();
        setShown(undefined);
      }
    };
    const show = (anchor: HTMLElement) => {
      cancel();
      if (!anchor.isConnected) return hide();
      const content = renderRef.current(anchor) ?? plain(anchor);
      if (!content) return hide();
      current.current?.removeAttribute('aria-describedby');
      current.current = anchor;
      anchor.setAttribute('aria-describedby', 'flotilla-hover');
      setShown({ anchor, content, placement: (anchor.dataset.tipPos as Placement) || 'below' });
    };
    const schedule = (anchor: HTMLElement) => {
      if (anchor === current.current || anchor === pending.current?.anchor) return;
      cancel();
      const instant = current.current !== undefined || Date.now() - lastHidden.current < GRACE;
      if (instant) return show(anchor);
      pending.current = { anchor, timer: window.setTimeout(() => show(anchor), DELAY) };
    };
    const anchorOf = (target: EventTarget | null) => (target instanceof Element ? (target.closest(SELECTOR) as HTMLElement | null) : null);

    const onOver = (e: MouseEvent) => {
      const anchor = anchorOf(e.target);
      if (anchor) schedule(anchor);
      else hide();
    };
    const onOut = (e: MouseEvent) => {
      if (!anchorOf(e.relatedTarget)) hide();
    };
    const onFocus = (e: FocusEvent) => {
      const anchor = anchorOf(e.target);
      if (anchor?.matches(':focus-visible')) schedule(anchor);
    };
    const onKey = (e: KeyboardEvent) => {
      // Escape closes it; other keys (typing, Tab) leave it to focus handling.
      if (e.key === 'Escape') hide();
    };
    const listeners: [EventTarget, string, EventListener, boolean?][] = [
      [document, 'mouseover', onOver as EventListener],
      [document, 'mouseout', onOut as EventListener],
      [document, 'focusin', onFocus as EventListener],
      [document, 'focusout', hide],
      [document, 'mousedown', hide, true],
      [document, 'wheel', hide, true],
      [document, 'scroll', hide, true],
      [document, 'keydown', onKey as EventListener],
      [document.documentElement, 'mouseleave', hide],
      [window, 'blur', hide],
      [window, 'resize', hide],
    ];
    for (const [t, type, fn, capture] of listeners) t.addEventListener(type, fn, capture);
    // The anchor can go away under the mouse (a tab closes, the list re-renders).
    const gone = new MutationObserver(() => current.current && !current.current.isConnected && hide());
    gone.observe(document.body, { childList: true, subtree: true });
    return () => {
      for (const [t, type, fn, capture] of listeners) t.removeEventListener(type, fn, capture);
      gone.disconnect();
      cancel();
    };
  }, []);

  useLayoutEffect(() => {
    const el = box.current;
    if (!shown || !el) return;
    const a = shown.anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
    let placement = shown.placement;
    if (placement === 'right' && a.right + GAP + w > vw - MARGIN) placement = 'below';
    if (placement === 'below' && a.bottom + GAP + h > vh - MARGIN && a.top - GAP - h >= MARGIN) placement = 'above';
    if (placement === 'above' && a.top - GAP - h < MARGIN) placement = 'below';
    let left: number;
    let top: number;
    let arrow: number;
    if (placement === 'right') {
      left = a.right + GAP;
      top = clamp(a.top + a.height / 2 - h / 2, MARGIN, vh - h - MARGIN);
      arrow = a.top + a.height / 2 - top;
    } else {
      left = clamp(a.left + a.width / 2 - w / 2, MARGIN, vw - w - MARGIN);
      top = placement === 'below' ? a.bottom + GAP : a.top - GAP - h;
      arrow = a.left + a.width / 2 - left;
    }
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.setProperty('--arrow', `${Math.round(clamp(arrow, 8, (placement === 'right' ? h : w) - 8))}px`);
    el.dataset.placement = placement;
  }, [shown]);

  if (!shown) return null;
  return (
    <div ref={box} id="flotilla-hover" class="hover" role="tooltip">
      <span class="hover-arrow" />
      {shown.content}
    </div>
  );
}

const STATE_CLASS: Partial<Record<WorkstreamView['attention'], string>> = {
  'waiting-for-input': 'st-waiting',
  working: 'st-working',
  error: 'st-error',
  done: 'st-done',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The hover of a worktree (tab, header, Overview card): branch, folder, status, changes, chats and how to open it. */
export function WorktreeCard({ ws, ci, color, keys, hint }: { ws: WorkstreamView; ci?: CiView; color: string; keys?: string; hint?: string }) {
  const open = ws.chats.filter((c) => c.open);
  const waiting = open.filter((c) => c.state === 'waiting-for-input').length;
  const changes = [ws.totals.staged ? `${ws.totals.staged} staged` : '', ws.totals.unstaged ? plural(ws.totals.unstaged, 'change') : '']
    .filter(Boolean)
    .join(', ');
  const chats = open.length ? `${plural(open.length, 'open chat')}${waiting ? ` (${waiting} waiting)` : ''}` : '';
  return (
    <div class="hover-ws" style={{ '--ws-color': color }}>
      <div class="hover-body">
        <div class="hover-title">
          <span class="swatch" />
          <strong>{ws.branch}</strong>
          {ws.isMain && <span class="tag">main</span>}
        </div>
        <div class="hover-path">{ws.path}</div>
        <div class="hover-row">
          <i class={`codicon codicon-${ATTENTION_ICON[ws.attention]} ${STATE_CLASS[ws.attention] ?? ''}`} />
          <span>{ws.description}</span>
        </div>
        {ciSummary(ci) && (
          <div class="hover-row">
            <i class={`codicon codicon-github-action${ciState(ci) ? ` ci-state ${ciState(ci)}` : ''}`} />
            <span>{ciSummary(ci)}</span>
          </div>
        )}
        {ws.agentMessage && <div class="hover-quote">{ws.agentMessage}</div>}
        {(changes || chats) && (
          <div class="hover-row">
            {changes && (
              <>
                <i class="codicon codicon-source-control" />
                <span>{changes}</span>
              </>
            )}
            {chats && (
              <>
                <i class={`codicon codicon-${waiting ? 'bell-dot' : 'comment-discussion'}${waiting ? ' st-waiting' : ''}`} />
                <span>{chats}</span>
              </>
            )}
          </div>
        )}
      </div>
      {(keys || hint) && (
        <div class="hover-status">
          {hint && <span>{hint}</span>}
          {keys && <Keys keys={keys} />}
        </div>
      )}
    </div>
  );
}

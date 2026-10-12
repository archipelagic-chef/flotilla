import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { FIRST_VIEW, offsetsOf, ROW_HEIGHT, visibleRange } from './windowing';

/** The nearest ancestor that scrolls vertically: the .content area (every tab scrolls there). */
function scrollerOf(el: HTMLElement): HTMLElement | undefined {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === 'auto' || overflowY === 'scroll') return p;
  }
  return undefined;
}

interface Props<T> {
  items: readonly T[];
  keyOf(item: T): string;
  render(item: T): ComponentChildren;
  /** An item (by key) to scroll into view, once per new value (keyboard navigation's new row); it waits until the item is listed. */
  reveal?: string;
}

/**
 * Draws only the items in view of a long list. The list scrolls with the nearest scrolling ancestor (.content), so it
 * works the same on one worktree's tab and inside the All tab. Rows keep their own height: each drawn row is measured,
 * and rows not drawn yet count as one row high.
 */
export function Virtual<T>({ items, keyOf, render, reveal }: Props<T>) {
  const root = useRef<HTMLDivElement>(null);
  const measured = useRef(new Map<string, number>());
  const [measureTick, setMeasureTick] = useState(0);
  const [view, setView] = useState({ top: 0, height: FIRST_VIEW });

  const offsets = useMemo(() => {
    void measureTick;
    return offsetsOf(items.map((item) => measured.current.get(keyOf(item)) ?? ROW_HEIGHT));
    // keyOf is a fresh closure each render; the items and the measurements decide the offsets.
  }, [items, measureTick]);
  const { start, end } = visibleRange(offsets, view.top, view.height);

  // Where the list starts in its scroller, and what part of the list the scroller shows.
  const track = () => {
    const el = root.current;
    const scroller = el && scrollerOf(el);
    if (!el || !scroller) return;
    const listTop = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const next = { top: scroller.scrollTop - listTop, height: scroller.clientHeight };
    setView((prev) => (prev.top === next.top && prev.height === next.height ? prev : next));
  };

  // Tracked after every render (the list may have moved), and on scroll and resize of the scroller.
  useLayoutEffect(track);
  useEffect(() => {
    const scroller = root.current && scrollerOf(root.current);
    if (!scroller) return;
    scroller.addEventListener('scroll', track, { passive: true });
    const resized = new ResizeObserver(track);
    resized.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', track);
      resized.disconnect();
    };
  }, []);

  // Measure the rows just drawn; a row whose height differs from what was assumed moves everything below it.
  useLayoutEffect(() => {
    let changed = false;
    for (const el of root.current?.querySelectorAll<HTMLElement>(':scope > [data-vkey]') ?? []) {
      const key = el.dataset.vkey!;
      if (measured.current.get(key) !== el.offsetHeight) {
        measured.current.set(key, el.offsetHeight);
        changed = true;
      }
    }
    if (changed) setMeasureTick((t) => t + 1);
  });

  // Scroll the item into view (if it isn't), once per reveal; a reveal whose item isn't in the list yet waits for it.
  const revealed = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const el = root.current;
    const scroller = el && scrollerOf(el);
    const index = reveal === undefined || reveal === revealed.current ? -1 : items.findIndex((item) => keyOf(item) === reveal);
    if (!el || !scroller || index < 0) return;
    revealed.current = reveal;
    const listTop = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const top = listTop + offsets[index];
    const bottom = listTop + offsets[index + 1];
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
    track();
  }, [reveal, items]);

  return (
    <div ref={root} class="virtual">
      <div style={{ height: `${offsets[start]}px` }} />
      {items.slice(start, end).map((item) => {
        const key = keyOf(item);
        return (
          <div key={key} data-vkey={key}>
            {render(item)}
          </div>
        );
      })}
      <div style={{ height: `${offsets[offsets.length - 1] - offsets[end]}px` }} />
    </div>
  );
}

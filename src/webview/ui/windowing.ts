/** Pure arithmetic of a windowed list (see virtual.tsx): where rows are and which ones a view shows. */

/** A row's height until it has been measured: --row-height. */
export const ROW_HEIGHT = 22;

/** Until the list knows where it is, it renders about this much (the first screen), not every row. */
export const FIRST_VIEW = 600;

/** Rows drawn beyond each edge of the view, so a quick scroll doesn't show blank space. */
const OVERSCAN = 8;

/** The last item whose top is at or above y (offsets: where each item starts, plus the end; see offsetsOf). */
function indexAt(offsets: ArrayLike<number>, y: number): number {
  let lo = 0;
  let hi = offsets.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Where each item starts, and the total height at the end: offsets[i] is the top of item i, offsets[count] the bottom. */
export function offsetsOf(heights: readonly number[]): number[] {
  const offsets = [0];
  for (const h of heights) offsets.push(offsets[offsets.length - 1] + h);
  return offsets;
}

/**
 * The items to draw for a view that starts at top (in the list's own coordinates) and is height tall: those the view
 * touches, with OVERSCAN more on each side. Empty for an empty list.
 */
export function visibleRange(offsets: ArrayLike<number>, top: number, height: number, overscan = OVERSCAN): { start: number; end: number } {
  const count = offsets.length - 1;
  if (count <= 0) return { start: 0, end: 0 };
  const start = Math.max(0, indexAt(offsets, top) - overscan);
  const end = Math.min(count, indexAt(offsets, top + height) + 1 + overscan);
  return { start, end };
}

/** What on a card does something of its own when clicked: a click anywhere else on the card opens its ticket. */
const CONTROLS = 'button, a, input, select, textarea, [role="menu"], .priority';

/**
 * BL-207: a card's hover strip (compact `.card-hover`, detailed `.hover-actions`) stops a click only when it comes from
 * one of its controls, so a click on its id, its details or the space between them still reaches the card.
 */
export function stopControlClick(e: { target: EventTarget | null; stopPropagation(): void }): void {
  const target = e.target as { closest?(selector: string): unknown } | null;
  if (target?.closest?.(CONTROLS)) e.stopPropagation();
}

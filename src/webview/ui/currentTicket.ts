import {
  createContext,
  type RefObject,
} from 'preact';
import {
  useContext,
  useLayoutEffect,
} from 'preact/hooks';

/** The ticket whose tab is the active editor (BL-275): its cards are highlighted. */
export const CurrentTicket = createContext<string | undefined>(undefined);

/**
 * Whether the card of this ticket is the current one; a card that becomes current is scrolled into view when it's
 * off screen (nearest: one already showing doesn't move).
 */
export function useCurrent(id: string, el: RefObject<HTMLElement>): boolean {
  const current = useContext(CurrentTicket) === id;
  useLayoutEffect(() => {
    if (current) el.current?.scrollIntoView?.({ block: 'nearest' });
  }, [current]);
  return current;
}

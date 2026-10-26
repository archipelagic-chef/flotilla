import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { stopControlClick } from '../../../src/webview/ui/cardClick';

/** A fake element: `closest` matches when one of its ancestors' tags or classes is in the selector. */
function element(...ancestors: string[]) {
  return {
    closest: (selector: string) => (ancestors.some((a) => selector.split(',').some((s) => s.trim() === a || s.trim() === `.${a}`)) ? {} : null),
  };
}

/** A click on the hover strip, bubbling to the card's onClick, which opens the ticket. */
function click(target: unknown) {
  const sent: unknown[] = [];
  const open = () => sent.push({ type: 'backlog', op: 'open', id: 'BL-1' });
  let stopped = false;
  stopControlClick({ target: target as EventTarget, stopPropagation: () => (stopped = true) });
  if (!stopped) open();
  return sent;
}

describe('a click on a card hover strip (BL-207)', () => {
  it('opens the ticket from its id, parent chip, activity count or the space between them', () => {
    for (const target of [element('span'), element('item-id'), element('parent-chip'), element('i')]) {
      expect(click(target)).toEqual([{ type: 'backlog', op: 'open', id: 'BL-1' }]);
    }
  });

  it('does only its own action from a button, a link, a menu or the priority picker', () => {
    for (const target of [element('button'), element('i', 'button'), element('a'), element('[role="menu"]'), element('priority')]) {
      expect(click(target)).toEqual([]);
    }
  });

  it('opens the ticket when the target is not an element', () => {
    const stop = vi.fn();
    stopControlClick({ target: null, stopPropagation: stop });
    stopControlClick({ target: {} as EventTarget, stopPropagation: stop });
    expect(stop).not.toHaveBeenCalled();
  });
});

import type { VNode } from 'preact';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ViewerStrip } from '../../../src/webview/ticket/viewerStrip';

type Props = { class?: string; 'aria-current'?: string; title?: string; onClick?: () => void; children?: unknown };

/** The strip's thumbnails: its buttons, in order. */
function thumbs(strip: VNode | null): VNode<Props>[] {
  const items = (strip?.props as { children: VNode[] }).children;
  return items.map((li) => (li.props as { children: VNode<Props> }).children);
}

describe("the viewer's strip of thumbnails (BL-279)", () => {
  const list = ['a.png', 'b.mp4', 'c.gif', 'd.png'];
  const strip = (at: number, go = vi.fn()) =>
    ViewerStrip({ list, at, go, preview: (a) => ({ type: 'img', props: { src: a } }) as unknown as VNode, label: (a) => a });

  it('shows one thumbnail per attachment, in the list’s order, with its preview', () => {
    const shown = thumbs(strip(0));
    expect(shown.map((b) => b.props.title)).toEqual(list);
    expect(shown.map((b) => (b.props.children as VNode<{ src: string }>).props.src)).toEqual(list);
  });

  it('marks the current one, and only it', () => {
    const shown = thumbs(strip(2));
    expect(shown.map((b) => b.props['aria-current'])).toEqual([undefined, undefined, 'true', undefined]);
    expect(shown.map((b) => b.props.class?.includes('current'))).toEqual([false, false, true, false]);
  });

  it('goes to the one clicked, however far, and not again to the current one', () => {
    const go = vi.fn();
    const shown = thumbs(strip(0, go));
    shown[3].props.onClick!();
    shown[0].props.onClick!();
    expect(go.mock.calls).toEqual([[3]]);
  });

  it('is not there with a single attachment', () => {
    expect(ViewerStrip({ list: ['a.png'], at: 0, go: vi.fn(), preview: () => null as unknown as VNode, label: String })).toBeNull();
  });
});

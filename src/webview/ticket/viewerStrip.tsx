/**
 * The viewer's strip (BL-279): a thumbnail of each attachment it goes through, in its order, under the large one. The
 * current one is marked and scrolled into view; a click shows that one, however far it is.
 */
import type { JSX } from 'preact';

// The current thumbnail scrolls into view when it becomes the current one (a click, the arrows).
const scrollIn = (el: HTMLElement | null) => el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });

export function ViewerStrip<T>({
  list,
  at,
  go,
  preview,
  label,
}: {
  list: T[];
  at: number;
  go: (n: number) => void;
  preview: (a: T) => JSX.Element;
  label: (a: T) => string;
}) {
  if (list.length < 2) return null;
  return (
    <ol class="viewer-strip" aria-label="Attachments">
      {list.map((a, i) => (
        <li key={i}>
          <button
            class={i === at ? 'attachment-thumb viewer-thumb current' : 'attachment-thumb viewer-thumb'}
            aria-current={i === at ? 'true' : undefined}
            title={label(a)}
            ref={i === at ? scrollIn : undefined}
            onClick={() => i !== at && go(i)}
          >
            {preview(a)}
          </button>
        </li>
      ))}
    </ol>
  );
}

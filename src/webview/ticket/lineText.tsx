import type { DiffLine } from '../ticketProtocol';

/** A diff line's text, in both of Changes' views: its tokens coloured by their kind (BL-208), or plain. */
export function LineText({ line }: { line: DiffLine }) {
  return (
    <span class="line-text">
      {line.tokens
        ? line.tokens.map((t, i) =>
            t.kind ? (
              <span key={i} class={`tok-${t.kind}`}>
                {t.text}
              </span>
            ) : (
              t.text
            ),
          )
        : line.text}
    </span>
  );
}

/**
 * The Attachments section (BL-110), between the description and the activity: the ticket's images, GIFs, videos and
 * Mermaid diagrams (BL-136) as thumbnails, newest first; a click opens one large, in an overlay, with the next and previous.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { entryAgent } from '../../features/backlog/backlog';
import type { AttachmentView, TicketView, TicketWebviewMessage } from '../ticketProtocol';
import { diagramSvg } from './diagrams';

/** The window event "Show in activity" sends: the activity opens the entry (its detail: the entry's key) and goes there. */
export const SHOW_ENTRY = 'flotilla-show-entry';

// The diagram "Show in activity" goes to in its entry (BL-136), if it's a diagram's.
let shown: { key: string; diagram: number } | undefined;

export function showEntry(key: string, diagram?: number): void {
  shown = diagram !== undefined ? { key, diagram } : undefined;
  window.dispatchEvent(new CustomEvent<string>(SHOW_ENTRY, { detail: key }));
}

/** The diagram "Show in activity" for this entry goes to: its place among the entry's diagrams. */
export function shownDiagram(key: string): number | undefined {
  return shown?.key === key ? shown.diagram : undefined;
}

/**
 * The Mermaid diagrams in an entry (or the description), drawn or not yet, in order: the nth is its nth ```mermaid
 * block. Not its replies' (they show inside it).
 */
export function diagramsIn(root: Element): HTMLElement[] {
  const entry = root.matches('[data-entry-key]') ? root : null;
  return [...root.querySelectorAll<HTMLElement>('.rendered [data-diagram], .rendered pre > code.language-mermaid')].filter((el) => {
    const drawn = el.closest('[data-diagram]');
    return (!drawn || drawn === el) && el.closest('[data-entry-key]') === entry;
  });
}

// Each diagram is drawn once, for its thumbnail and the viewer both.
const drawn = new Map<string, Promise<string>>();

/** A diagram drawn from its code; one that can't be drawn says why. */
function Diagram({ code, label }: { code: string; label: string }) {
  const el = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let svg = drawn.get(code);
    if (!svg) {
      svg = diagramSvg(code);
      drawn.set(code, svg);
      svg.catch(() => drawn.delete(code));
    }
    let live = true;
    svg.then(
      (s) => live && el.current && (el.current.innerHTML = s),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [code]);
  return error ? (
    <div class="media-note">This diagram can't be drawn: {error}</div>
  ) : (
    <div class="attachment-diagram" ref={el} role="img" aria-label={label} />
  );
}

/** The diagram, large: a click zooms in (to twice its size, to scroll around in), and out again. */
function LargeDiagram({ code, label }: { code: string; label: string }) {
  const [zoomed, setZoomed] = useState(false);
  return (
    <div class={`viewer-diagram${zoomed ? ' zoomed' : ''}`} onClick={() => setZoomed(!zoomed)} title={zoomed ? 'Click to fit it' : 'Click to zoom in'}>
      <Diagram code={code} label={label} />
    </div>
  );
}

/** Who added it, and when: "Nova-7 · 2026-10-19 20:10", or where it is when no entry did. */
function addedBy(a: AttachmentView): string {
  const who = a.author ? (entryAgent(a.author) ?? a.author) : a.from === 'description' ? 'Description' : 'In the ticket’s folder';
  return a.date ? `${who} · ${a.date}` : who;
}

/** Its caption: the alt text (a diagram's: the line before it); else a diagram's who and when, a file's name. */
const caption = (a: AttachmentView) => a.alt ?? (a.kind === 'diagram' ? addedBy(a) : a.name);

function Thumb({ a, onOpen }: { a: AttachmentView; onOpen: () => void }) {
  return (
    <li class="attachment">
      <button class="attachment-thumb" onClick={onOpen} title={`${caption(a)}\n${addedBy(a)}\nClick to open it large`}>
        {a.kind === 'diagram' ? (
          <Diagram code={a.code ?? ''} label={caption(a)} />
        ) : a.kind === 'video' ? (
          <>
            {/* Its first frame is the poster; it doesn't play here. */}
            <video src={a.src} preload="metadata" muted tabIndex={-1} />
            <i class="codicon codicon-play-circle play-mark" />
          </>
        ) : (
          <img src={a.src} alt={a.alt ?? a.name} loading="lazy" />
        )}
        {a.demo && <span class="demo-tag">demo</span>}
      </button>
      <span class="attachment-name">{a.kind === 'diagram' ? (a.alt ?? a.name) : a.name}</span>
      <span class="attachment-meta muted">{addedBy(a)}</span>
    </li>
  );
}

/** One attachment large, over the ticket: Escape (or the backdrop) closes it, the arrows go to the next and previous. */
function Viewer({ list, at, go, close }: { list: AttachmentView[]; at: number; go: (n: number) => void; close: () => void }) {
  const a = list[at];
  const many = list.length > 1;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft' && many) go((at - 1 + list.length) % list.length);
      else if (e.key === 'ArrowRight' && many) go((at + 1) % list.length);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [at, list.length]);
  return (
    <div class="viewer" role="dialog" aria-modal="true" aria-label={caption(a)} onClick={(e) => e.target === e.currentTarget && close()}>
      <button class="viewer-close icon-button" onClick={close} title="Close (Escape)" aria-label="Close">
        <i class="codicon codicon-close" />
      </button>
      {many && (
        <button class="viewer-nav prev icon-button" onClick={() => go((at - 1 + list.length) % list.length)} title="Previous (←)" aria-label="Previous">
          <i class="codicon codicon-chevron-left" />
        </button>
      )}
      <figure class="viewer-figure">
        {a.kind === 'diagram' ? (
          <LargeDiagram key={a.src} code={a.code ?? ''} label={caption(a)} />
        ) : a.kind === 'video' ? (
          <video key={a.src} src={a.src} controls autoPlay />
        ) : (
          <img key={a.src} src={a.src} alt={a.alt ?? a.name} />
        )}
        <figcaption>
          <span class="viewer-caption">{caption(a)}</span>
          {a.demo && <span class="demo-tag">demo</span>}
          <span class="muted">
            {a.name} · {addedBy(a)}
            {many && ` · ${at + 1} of ${list.length}`}
          </span>
          {a.entryKey && (
            <button
              class="text-button"
              onClick={() => {
                close();
                showEntry(a.entryKey!, a.diagram);
              }}
            >
              <i class="codicon codicon-go-to-file" /> Show in activity
            </button>
          )}
        </figcaption>
      </figure>
      {many && (
        <button class="viewer-nav next icon-button" onClick={() => go((at + 1) % list.length)} title="Next (→)" aria-label="Next">
          <i class="codicon codicon-chevron-right" />
        </button>
      )}
    </div>
  );
}

export function Attachments({ ticket, send }: { ticket: TicketView; send: (m: TicketWebviewMessage) => void }) {
  const list = ticket.attachments ?? [];
  const [folded, setFolded] = useState(!!ticket.attachmentsFolded);
  const [open, setOpen] = useState<number | undefined>(undefined);
  useEffect(() => setFolded(!!ticket.attachmentsFolded), [ticket.item.id]);
  useEffect(() => {
    // A picture or a diagram in the activity opens here too, large.
    const click = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest('.feed .rendered, .description .rendered')) return;
      if (el instanceof HTMLImageElement) {
        const at = list.findIndex((a) => a.src === el.getAttribute('src'));
        if (at >= 0) setOpen(at);
        return;
      }
      // A diagram: which of its entry's (or the description's) it is.
      const diagram = el.closest<HTMLElement>('.diagram[data-diagram]');
      const where = diagram?.closest<HTMLElement>('[data-entry-key], .description');
      if (!diagram || !where) return;
      const n = diagramsIn(where).indexOf(diagram);
      const key = where.dataset.entryKey;
      const at = list.findIndex((a) => a.kind === 'diagram' && a.diagram === n && (key ? a.entryKey === key : a.from === 'description'));
      if (at >= 0) setOpen(at);
    };
    document.addEventListener('click', click);
    return () => document.removeEventListener('click', click);
  }, [list]);
  if (!list.length) return null;
  const toggle = () => {
    setFolded(!folded);
    send({ type: 'foldAttachments', folded: !folded });
  };
  return (
    <section class="block attachments">
      <div class="block-head">
        <button class="section-toggle" aria-expanded={!folded} onClick={toggle} title={folded ? 'Show the attachments' : 'Fold the attachments'}>
          <i class={`codicon codicon-chevron-${folded ? 'right' : 'down'}`} />
          <h2>Attachments</h2>
          <span class="count">{list.length}</span>
        </button>
      </div>
      {!folded && (
        <ul class="attachment-list">
          {list.map((a, i) => (
            <Thumb key={a.src} a={a} onOpen={() => setOpen(i)} />
          ))}
        </ul>
      )}
      {open !== undefined && list[open] && <Viewer list={list} at={open} go={setOpen} close={() => setOpen(undefined)} />}
    </section>
  );
}

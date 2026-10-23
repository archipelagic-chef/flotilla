/**
 * The Attachments section (BL-110), between the description and the activity: the ticket's images, GIFs, videos and
 * Mermaid diagrams (BL-136) as thumbnails, newest first; a click opens one large, in an overlay, with the next and previous.
 */
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { entryAgent } from '../../features/backlog/backlog';
import type { AttachmentView, TicketView, TicketWebviewMessage } from '../ticketProtocol';
import { diagramSvg } from './diagrams';
import { RecordingBar, type Action } from './demo';

/** The window event "Show in activity" sends: the activity opens the entry (its detail: the entry's key) and goes there. */
export const SHOW_ENTRY = 'flotilla-show-entry';

// The diagram "Show in activity" goes to in its entry (BL-136), if it's a diagram's.
let shown: { key: string; diagram: number } | undefined;

export function showEntry(key: string, diagram?: number): void {
  shown = diagram !== undefined ? { key, diagram } : undefined;
  window.dispatchEvent(new CustomEvent<string>(SHOW_ENTRY, { detail: key }));
}

/** What the viewer shows: an attachment, or a folded entry's medium that isn't one (BL-114). */
export type Shown = Omit<AttachmentView, 'src' | 'from' | 'demo'> & {
  src?: string;
  from?: AttachmentView['from'];
  demo?: boolean;
};

/** The window event a folded entry's media strip sends (BL-114): the viewer opens its detail's medium. */
export const OPEN_MEDIA = 'flotilla-open-media';

export function openMedia(list: Shown[], at: number): void {
  window.dispatchEvent(new CustomEvent<{ list: Shown[]; at: number }>(OPEN_MEDIA, { detail: { list, at } }));
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

/** A diagram drawn from its code (a thumbnail's, the viewer's); one that can't be drawn says why. */
export function Diagram({ code, label, class: cls = 'attachment-diagram' }: { code: string; label: string; class?: string }) {
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
    <div class={cls} ref={el} role="img" aria-label={label} />
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
function addedBy(a: Shown): string {
  const who = a.author ? (entryAgent(a.author) ?? a.author) : a.from === 'description' ? 'Description' : 'In the ticket’s folder';
  return a.date ? `${who} · ${a.date}` : who;
}

/** Its caption: the alt text (a diagram's: the line before it); else a diagram's who and when, a file's name. */
const caption = (a: Shown) => a.alt ?? (a.kind === 'diagram' ? addedBy(a) : a.name);

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

/**
 * A video large (BL-134): it plays at once, from the start, muted (demos have no sound; its controls turn sound on), as
 * the webview holds back a video that plays with sound. If it still doesn't play, a big play button says it's a video.
 * It stops when it goes (the next one, or the viewer closed).
 */
function ViewerVideo({ a }: { a: Shown }) {
  const el = useRef<HTMLVideoElement>(null);
  const [held, setHeld] = useState(false);
  const play = () => {
    const v = el.current;
    if (!v) return;
    setHeld(false);
    v.play()?.catch(() => el.current === v && v.paused && setHeld(true));
  };
  useEffect(() => {
    const v = el.current;
    play();
    return () => v?.pause();
  }, []);
  return (
    <div class="viewer-video">
      <video ref={el} src={a.src} controls autoPlay muted playsInline aria-label={caption(a)} onPlay={() => setHeld(false)} />
      {held && (
        <button class="viewer-play" onClick={play} title="Play" aria-label="Play">
          <i class="codicon codicon-play-circle" />
        </button>
      )}
    </div>
  );
}

/** One attachment large, over the ticket: Escape (or the backdrop) closes it, the arrows go to the next and previous. */
function Viewer({ list, at, go, close, demo }: { list: Shown[]; at: number; go: (n: number) => void; close: () => void; demo: (a: AttachmentView) => JSX.Element }) {
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
        {a.demo && a.kind !== 'diagram' && demo(a as AttachmentView)}
        {a.kind === 'diagram' ? (
          <LargeDiagram key={a.code} code={a.code ?? ''} label={caption(a)} />
        ) : a.kind === 'video' ? (
          <ViewerVideo key={a.src} a={a} />
        ) : (
          <img key={a.src} src={a.src} alt={a.alt ?? a.name} />
        )}
        <figcaption>
          <span class="viewer-caption">{caption(a)}</span>
          {a.demo && <span class="demo-tag">demo</span>}
          <span class="muted">
            {a.kind === 'diagram' ? '' : `${a.name} · `}
            {addedBy(a)}
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

// How high a video's controls bar is, at its bottom: a click there is the controls'.
const CONTROLS = 48;

export function Attachments({ ticket, send, Action }: { ticket: TicketView; send: (m: TicketWebviewMessage) => void; Action: Action }) {
  const list = ticket.attachments ?? [];
  const [folded, setFolded] = useState(!!ticket.attachmentsFolded);
  const [open, setOpen] = useState<number | undefined>(undefined);
  // A report's own media, when what's opened isn't an attachment (a diagram): the viewer goes through them.
  const [own, setOwn] = useState<Shown[] | undefined>(undefined);
  useEffect(() => setFolded(!!ticket.attachmentsFolded), [ticket.item.id]);
  useEffect(() => {
    // A picture or a diagram in the activity opens here too, large.
    const click = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest('.feed .rendered, .description .rendered')) return;
      // A video plays where it is, muted (BL-134): the webview's player doesn't start on a click on the picture itself.
      // Its controls (the bar at the bottom) do what they do.
      if (el instanceof HTMLVideoElement) {
        if (el.paused && e.offsetY < el.clientHeight - CONTROLS) {
          e.preventDefault();
          void el.play().catch(() => undefined);
        }
        return;
      }
      if (el instanceof HTMLImageElement) {
        const at = list.findIndex((a) => a.src === el.getAttribute('src'));
        if (at >= 0) {
          setOwn(undefined);
          setOpen(at);
        }
        return;
      }
      // A diagram: which of its entry's (or the description's) it is.
      const diagram = el.closest<HTMLElement>('.diagram[data-diagram]');
      const where = diagram?.closest<HTMLElement>('[data-entry-key], .description');
      if (!diagram || !where) return;
      const n = diagramsIn(where).indexOf(diagram);
      const key = where.dataset.entryKey;
      const at = list.findIndex((a) => a.kind === 'diagram' && a.diagram === n && (key ? a.entryKey === key : a.from === 'description'));
      if (at >= 0) {
        setOwn(undefined);
        setOpen(at);
      }
    };
    // A thumbnail of a folded entry: an attachment (a diagram too, BL-136) opens among the others; else among its entry's media.
    const strip = (e: Event) => {
      const { list: media, at } = (e as CustomEvent<{ list: Shown[]; at: number }>).detail;
      const m = media[at];
      const i =
        m.kind === 'diagram'
          ? list.findIndex((a) => a.kind === 'diagram' && a.entryKey === m.entryKey && a.code?.trim() === m.code?.trim())
          : list.findIndex((a) => a.src === m.src);
      setOwn(i >= 0 ? undefined : media);
      setOpen(i >= 0 ? i : at);
    };
    document.addEventListener('click', click);
    window.addEventListener(OPEN_MEDIA, strip);
    return () => {
      document.removeEventListener('click', click);
      window.removeEventListener(OPEN_MEDIA, strip);
    };
  }, [list]);
  const shown: Shown[] = own ?? list;
  const close = () => {
    setOpen(undefined);
    setOwn(undefined);
  };
  const viewer = open !== undefined && shown[open] && (
    <Viewer list={shown} at={open} go={setOpen} close={close} demo={(a) => <RecordingBar a={a} ticket={ticket} Action={Action} />} />
  );
  if (!list.length) return viewer || null;
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
            <Thumb
              key={a.src}
              a={a}
              onOpen={() => {
                setOwn(undefined);
                setOpen(i);
              }}
            />
          ))}
        </ul>
      )}
      {viewer}
    </section>
  );
}

/**
 * The Attachments section (BL-110), between the description and the activity: the ticket's images, GIFs and videos
 * as thumbnails, newest first; a click opens one large, in an overlay, with the next and previous.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { entryAgent } from '../../features/backlog/backlog';
import type { MediaKind } from '../../features/backlog/media';
import type { AttachmentView, TicketView, TicketWebviewMessage } from '../ticketProtocol';
import { drawDiagrams } from './diagrams';

/** The window event "Show in activity" sends: the activity opens the entry (its detail: the entry's key) and goes there. */
export const SHOW_ENTRY = 'flotilla-show-entry';

export function showEntry(key: string): void {
  window.dispatchEvent(new CustomEvent<string>(SHOW_ENTRY, { detail: key }));
}

/** What the viewer shows: an attachment, or a report's diagram (BL-114), drawn from its Mermaid code. */
export type Shown = Omit<AttachmentView, 'kind' | 'src' | 'from' | 'demo'> & {
  kind: MediaKind | 'diagram';
  src?: string;
  code?: string;
  from?: AttachmentView['from'];
  demo?: boolean;
};

/** The window event a folded report's media strip sends (BL-114): the viewer opens its detail's medium. */
export const OPEN_MEDIA = 'flotilla-open-media';

export function openMedia(list: Shown[], at: number): void {
  window.dispatchEvent(new CustomEvent<{ list: Shown[]; at: number }>(OPEN_MEDIA, { detail: { list, at } }));
}

/** A Mermaid diagram drawn from its code (a strip's thumbnail, or the viewer's), as rendered Markdown would hold it. */
export function Diagram({ code, class: cls }: { code: string; class: string }) {
  const el = useRef<HTMLDivElement>(null);
  const html = `<pre><code class="language-mermaid">${code.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</code></pre>`;
  useEffect(() => {
    if (el.current) void drawDiagrams(el.current);
  }, [code]);
  return <div ref={el} class={cls} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Who added it, and when: "Nova-7 · 2026-10-19 20:10", or where it is when no entry did. */
function addedBy(a: Shown): string {
  const who = a.author ? (entryAgent(a.author) ?? a.author) : a.from === 'description' ? 'Description' : 'In the ticket’s folder';
  return a.date ? `${who} · ${a.date}` : who;
}

function Thumb({ a, onOpen }: { a: AttachmentView; onOpen: () => void }) {
  return (
    <li class="attachment">
      <button class="attachment-thumb" onClick={onOpen} title={`${a.alt ?? a.name}\n${addedBy(a)}\nClick to open it large`}>
        {a.kind === 'video' ? (
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
      <span class="attachment-name">{a.name}</span>
      <span class="attachment-meta muted">{addedBy(a)}</span>
    </li>
  );
}

/** One attachment large, over the ticket: Escape (or the backdrop) closes it, the arrows go to the next and previous. */
function Viewer({ list, at, go, close }: { list: Shown[]; at: number; go: (n: number) => void; close: () => void }) {
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
    <div class="viewer" role="dialog" aria-modal="true" aria-label={a.alt ?? a.name} onClick={(e) => e.target === e.currentTarget && close()}>
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
          <Diagram key={a.code} code={a.code ?? ''} class="viewer-diagram" />
        ) : a.kind === 'video' ? (
          <video key={a.src} src={a.src} controls autoPlay />
        ) : (
          <img key={a.src} src={a.src} alt={a.alt ?? a.name} />
        )}
        <figcaption>
          <span class="viewer-caption">{a.alt ?? a.name}</span>
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
                showEntry(a.entryKey!);
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
  // A report's own media, when what's opened isn't an attachment (a diagram): the viewer goes through them.
  const [own, setOwn] = useState<Shown[] | undefined>(undefined);
  useEffect(() => setFolded(!!ticket.attachmentsFolded), [ticket.item.id]);
  useEffect(() => {
    // A picture in the activity opens here too, large.
    const click = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!(el instanceof HTMLImageElement) || !el.closest('.feed .rendered, .description .rendered')) return;
      const at = list.findIndex((a) => a.src === el.getAttribute('src'));
      if (at >= 0) {
        setOwn(undefined);
        setOpen(at);
      }
    };
    // A thumbnail of a folded report: an attachment opens among the others; a diagram among its report's media.
    const strip = (e: Event) => {
      const { list: media, at } = (e as CustomEvent<{ list: Shown[]; at: number }>).detail;
      const i = media[at].src === undefined ? -1 : list.findIndex((a) => a.src === media[at].src);
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
  const viewer = open !== undefined && shown[open] && <Viewer list={shown} at={open} go={setOpen} close={close} />;
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

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { fileKind, tooLarge } from '../../features/backlog/media';
import { drawDiagrams } from './diagrams';
import { showAnchor } from './attachments';
import { type Format, formatEdit, type Markup, pasteLink, type TextEdit } from './format';
import { demoLength } from '../../features/backlog/demo';
import { act, send } from './actions';
import { matchEntries, matchTickets, pickSuggestion, suggestQuery, type SuggestQuery, type TicketSuggestion } from './suggest';
import type { EntrySuggestion } from '../ticketProtocol';
import './markdownBox.css';

/** Replies to pasted or dropped images, by request id. */
export const imageReplies = new Map<number, (markdown: string) => void>();
let nextImage = 1;
/** Replies to a Markdown box's Preview, by request id. */
export const previewReplies = new Map<number, (html: string) => void>();
let nextPreview = 1;
/** The answers to the comment box's requests for a ticket's entries (BL-130), by request. */
export const entryReplies = new Map<number, (entries: EntrySuggestion[]) => void>();
let nextEntries = 1;


function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Saves the images and videos among files next to the ticket and inserts links to them at the textarea's cursor. One
 * over its kind's size limit isn't sent: the host says why.
 */
async function attachImages(files: FileList | File[], area: HTMLTextAreaElement, setText: (text: string) => void): Promise<boolean> {
  const images = [...files].filter((f) => fileKind(f));
  for (const file of images) {
    const kind = fileKind(file)!;
    if (tooLarge(kind, file.size)) {
      send({ type: 'mediaRefused', name: file.name || 'pasted', kind, size: file.size });
      continue;
    }
    const requestId = nextImage++;
    const markdown = await new Promise<string>((resolve) => {
      imageReplies.set(requestId, resolve);
      void readAsBase64(file).then((data) =>
        send({
          type: 'image',
          requestId,
          name: file.name || 'pasted.png',
          data,
        }),
      );
    });
    if (!markdown) continue;
    const at = area.selectionStart ?? area.value.length;
    const before = area.value.slice(0, at);
    const text = `${before}${before && !before.endsWith('\n') ? '\n' : ''}${markdown}\n${area.value.slice(at)}`;
    setText(text);
  }
  return images.length > 0;
}

/** What the Mention button inserts: the prefix of this ticket's id (BL-, or a tracker's PROJ-). */
export const mentionPrefix = (id: string) => /^(.*?-)\d+$/.exec(id)?.[1] ?? '';

/** The formatting toolbar's buttons (BL-129), with their keys. */
const FORMATS: Array<{ format: Format; icon: string; label: string; key?: string }> = [
  { format: 'bold', icon: 'bold', label: 'Bold', key: 'b' },
  { format: 'italic', icon: 'italic', label: 'Italic', key: 'i' },
  { format: 'code', icon: 'code', label: 'Code' },
  { format: 'codeBlock', icon: 'file-code', label: 'Code block' },
  { format: 'link', icon: 'link', label: 'Link', key: 'k' },
  { format: 'bullets', icon: 'list-unordered', label: 'Bulleted list' },
  { format: 'numbers', icon: 'list-ordered', label: 'Numbered list' },
  { format: 'quote', icon: 'quote', label: 'Quote' },
  { format: 'mention', icon: 'mention', label: 'Mention a ticket or comment' },
];

/**
 * Makes an edit in the textarea as typing would, so Ctrl+Z undoes it; where the browser won't, the value is set.
 * The textarea's input event updates the box's state.
 */
function editArea(el: HTMLTextAreaElement, edit: TextEdit, setValue: (text: string) => void): void {
  const expected = el.value.slice(0, edit.from) + edit.insert + el.value.slice(edit.to);
  el.focus();
  el.setSelectionRange(edit.from, edit.to);
  const typed = edit.insert ? document.execCommand('insertText', false, edit.insert) : edit.from === edit.to || document.execCommand('delete');
  if (!typed || el.value !== expected) {
    el.value = expected;
    setValue(expected);
  }
  el.setSelectionRange(edit.selStart, edit.selEnd);
}

/**
 * A Markdown box that grows with its text and takes pasted or dropped images. With format, it has a toolbar (in that
 * markup) and, for Markdown, Write and Preview tabs: Preview renders the text as the activity shows it.
 */
export function MarkdownBox({
  value,
  setValue,
  placeholder,
  label,
  onSubmit,
  autoFocus,
  minRows = 3,
  images = true,
  format,
  mention = '',
  suggest,
}: {
  value: string;
  setValue(text: string): void;
  placeholder: string;
  label: string;
  onSubmit(): void;
  autoFocus?: boolean;
  minRows?: number;
  /** Pasted and dropped images are saved next to the ticket (not for issues that live in a tracker). */
  images?: boolean;
  /** The toolbar, writing this markup (none without). */
  format?: Markup;
  /** What the Mention button inserts: the ticket ids' prefix. */
  mention?: string;
  /** Tickets (and their comments) to suggest as references while typing (BL-130); self is the ticket's own id. */
  suggest?: { tickets: TicketSuggestion[]; self: string };
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState<string | undefined>(undefined);
  const suggesting = useSuggestions(area, value, setValue, mention, suggest);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value, preview === undefined]);
  useEffect(() => {
    if (autoFocus) area.current?.focus();
  }, [autoFocus]);
  const apply = (f: Format) => {
    const el = area.current;
    if (el) editArea(el, formatEdit(el.value, el.selectionStart, el.selectionEnd, f, format, mention), setValue);
  };
  const showPreview = () => {
    const requestId = nextPreview++;
    setPreview('');
    previewReplies.set(requestId, (html) => setPreview((shown) => (shown === undefined ? undefined : html)));
    send({ type: 'preview', requestId, text: value });
  };
  const write = () => {
    setPreview(undefined);
    setTimeout(() => area.current?.focus());
  };
  const box = (
    <textarea
      ref={area}
      class="md-box"
      hidden={preview !== undefined}
      rows={minRows}
      value={value}
      placeholder={placeholder}
      aria-label={label}
      onInput={(e) => {
        setValue((e.target as HTMLTextAreaElement).value);
        suggesting.update();
      }}
      onClick={suggesting.update}
      onBlur={() => setTimeout(suggesting.close, 150)}
      onKeyDown={(e) => {
        if (suggesting.key(e)) return;
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onSubmit();
          return;
        }
        const key = format && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && FORMATS.find((f) => f.key === e.key.toLowerCase());
        if (key) {
          // Not on to VS Code, where Ctrl+B toggles the sidebar and Ctrl+K starts a chord.
          e.preventDefault();
          e.stopPropagation();
          apply(key.format);
        }
      }}
      onPaste={(e) => {
        const files = e.clipboardData?.files;
        if (images && files?.length && [...files].some((f) => fileKind(f))) {
          e.preventDefault();
          void attachImages(files, area.current!, setValue);
          return;
        }
        const el = area.current!;
        const link = format && pasteLink(el.value, el.selectionStart, el.selectionEnd, e.clipboardData?.getData('text/plain') ?? '', format);
        if (link) {
          e.preventDefault();
          editArea(el, link, setValue);
        }
      }}
      onDragOver={(e) => e.dataTransfer?.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        const files = e.dataTransfer?.files;
        if (images && files?.length) {
          e.preventDefault();
          void attachImages(files, area.current!, setValue);
        }
      }}
    />
  );
  const list = suggesting.list && <Suggestions {...suggesting.list} pick={suggesting.pick} />;
  if (!format)
    return (
      <div class="md-suggest-anchor">
        {box}
        {list}
      </div>
    );
  const key = (k?: string) => (k ? ` (${navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl+'}${k.toUpperCase()})` : '');
  return (
    <div class="md-editor">
      <div class="md-toolbar">
        {format === 'markdown' && (
          <span class="md-tabs" role="tablist">
            <button role="tab" class="md-tab" aria-selected={preview === undefined} onClick={write}>
              Write
            </button>
            <button role="tab" class="md-tab" aria-selected={preview !== undefined} onClick={showPreview}>
              Preview
            </button>
          </span>
        )}
        {preview === undefined && (
          <span class="md-formats" role="toolbar" aria-label="Formatting">
            {FORMATS.map((f) => (
              <button
                key={f.format}
                class="icon-button"
                title={f.label + key(f.key)}
                aria-label={f.label}
                // The textarea keeps its focus and selection.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => apply(f.format)}
              >
                <i class={`codicon codicon-${f.icon}`} />
              </button>
            ))}
          </span>
        )}
      </div>
      <div class="md-suggest-anchor">
        {box}
        {list}
      </div>
      {preview !== undefined && (
        <div class="md-preview" style={{ minHeight: `${minRows * 1.5 + 1}em` }}>
          {preview || !value.trim() ? <Rendered html={preview} empty="Nothing to preview." /> : <div class="rendered empty-text">Rendering…</div>}
        </div>
      )}
    </div>
  );
}

/** Rendered Markdown from the host (VS Code's renderer; scripts are blocked by the page's policy). */
export function Rendered({ html, empty }: { html: string; empty: string }) {
  const el = useRef<HTMLDivElement>(null);
  // Mermaid blocks become diagrams, again whenever the html is new.
  useEffect(() => {
    if (el.current) void drawDiagrams(el.current);
  }, [html]);
  // A demo's video says how long it plays once it knows (a GIF's length comes with the html, BL-111).
  useEffect(() => {
    el.current?.querySelectorAll<HTMLVideoElement>('.demo-inline video').forEach((v) => {
      const show = () => {
        const label = v.closest('.demo-inline')?.querySelector('.demo-length');
        if (label && Number.isFinite(v.duration)) label.textContent = `Recorded demo · ${demoLength(v.duration)}`;
      };
      if (v.readyState >= 1) show();
      else v.addEventListener('loadedmetadata', show, { once: true });
    });
  }, [html]);
  if (!html) return <div class="rendered empty-text">{empty}</div>;
  // Links open here (files at their lines, in the ticket's worktree) or in the browser: not inside the view.
  const onClick = (e: MouseEvent) => {
    // The Run button of a run block in an agent's report (the host puts it in the html).
    const run = (e.target as HTMLElement).closest<HTMLElement>('[data-run-key]');
    if (run) {
      // The button is in the host's html: its working state is set here, and cleared when the host is done.
      run.dataset.busy = 'Running…';
      (run as HTMLButtonElement).disabled = true;
      act({ type: 'run', key: run.dataset.runKey!, index: Number(run.dataset.runIndex), ...(run.dataset.runTry ? { try: true } : {}) }, 'Running…');
      return;
    }
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href');
    if (!href) return;
    // A link to an entry of this ticket (a reply's parent, BL-126; a comment's reference, BL-130).
    if (href.startsWith('#')) {
      if (href.length > 1) {
        e.preventDefault();
        showAnchor(decodeURIComponent(href.slice(1)));
      }
      return;
    }
    e.preventDefault();
    send({ type: 'openHref', href });
  };
  return <div ref={el} class="rendered" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

type SuggestItem = { reference: string; label: string; detail: string };

/**
 * The suggestions while typing (BL-130): what the text before the caret asks for (suggest.ts), the items, the one
 * picked with the arrows, and the keys that move and pick (Enter or Tab) or close (Escape).
 */
function useSuggestions(area: { current: HTMLTextAreaElement | null }, value: string, setValue: (text: string) => void, prefix: string, suggest?: { tickets: TicketSuggestion[]; self: string }) {
  const [query, setQuery] = useState<SuggestQuery | undefined>(undefined);
  const [active, setActive] = useState(0);
  const [entries, setEntries] = useState<{ id: string; entries?: EntrySuggestion[] }>();
  const closed = useRef<number | undefined>(undefined);
  const update = () => {
    const el = area.current;
    if (!el || !suggest) return;
    const q = el.selectionStart === el.selectionEnd ? suggestQuery(el.value, el.selectionStart, prefix) : undefined;
    // Escape closes it until what it's for changes.
    setQuery(q && q.start !== closed.current ? q : undefined);
    if (!q || q.start !== closed.current) closed.current = undefined;
    setActive(0);
  };
  useEffect(update, [value]);
  const entryId = query?.kind === 'entry' ? query.id : undefined;
  useEffect(() => {
    if (!entryId || entries?.id === entryId) return;
    const requestId = nextEntries++;
    setEntries({ id: entryId });
    entryReplies.set(requestId, (found) => setEntries((shown) => (shown?.id === entryId ? { id: entryId, entries: found } : shown)));
    send({ type: 'entries', requestId, id: entryId });
  }, [entryId]);
  const items: SuggestItem[] = !query
    ? []
    : query.kind === 'ticket'
      ? matchTickets(suggest?.tickets ?? [], query.query, suggest?.self).map((t) => ({ reference: t.id, label: t.id, detail: t.title }))
      : matchEntries(entries?.id === query.id ? (entries.entries ?? []) : [], query.query).map((e) => ({
          reference: `${query.id}#${e.anchor}`,
          label: `${e.author.replace(/^Agent /, '') || 'Note'}, ${e.date}`,
          detail: e.text,
        }));
  const pick = (item: SuggestItem) => {
    const el = area.current;
    if (!el || !query) return;
    editArea(el, pickSuggestion(el.value, el.selectionStart, query.start, item.reference), setValue);
    setQuery(undefined);
  };
  const close = () => {
    if (query) closed.current = query.start;
    setQuery(undefined);
  };
  const key = (e: KeyboardEvent): boolean => {
    if (!items.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
    else if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) || e.key === 'Tab') pick(items[Math.min(active, items.length - 1)]);
    else if (e.key === 'Escape') close();
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  };
  const loading = query?.kind === 'entry' && entries?.id === query.id && !entries.entries;
  const list = query && (items.length || loading) ? { items, active: Math.min(active, items.length - 1), loading, entry: query.kind === 'entry' } : undefined;
  return { update, close, key, pick, list };
}

/** The list of suggestions under the box: a click picks one (the box keeps its focus). */
function Suggestions({ items, active, loading, entry, pick }: { items: SuggestItem[]; active: number; loading: boolean; entry: boolean; pick(item: SuggestItem): void }) {
  return (
    <ul class="md-suggest" role="listbox" aria-label={entry ? 'Comments' : 'Tickets'}>
      {loading && <li class="md-suggest-empty">Reading its comments…</li>}
      {items.map((item, i) => (
        <li
          key={item.reference}
          role="option"
          aria-selected={i === active}
          class={i === active ? 'active' : undefined}
          onMouseDown={(e) => {
            e.preventDefault();
            pick(item);
          }}
          title={item.reference}
        >
          <span class="md-suggest-label">{item.label}</span>
          <span class="md-suggest-detail">{item.detail}</span>
        </li>
      ))}
    </ul>
  );
}

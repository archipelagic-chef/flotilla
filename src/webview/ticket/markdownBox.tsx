import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { fileKind, tooLarge } from '../../features/backlog/media';
import { drawDiagrams } from './diagrams';
import { type Format, formatEdit, type Markup, pasteLink, type TextEdit } from './format';
import { demoLength } from '../../features/backlog/demo';
import { act, send } from './actions';
import './markdownBox.css';

/** Replies to pasted or dropped images, by request id. */
export const imageReplies = new Map<number, (markdown: string) => void>();
let nextImage = 1;
/** Replies to a Markdown box's Preview, by request id. */
export const previewReplies = new Map<number, (html: string) => void>();
let nextPreview = 1;

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
  onCancel,
  autoFocus,
  minRows = 3,
  images = true,
  format,
  mention = '',
}: {
  value: string;
  setValue(text: string): void;
  placeholder: string;
  label: string;
  onSubmit(): void;
  /** Escape: the box is closed without its text (an edit, BL-128). */
  onCancel?(): void;
  autoFocus?: boolean;
  minRows?: number;
  /** Pasted and dropped images are saved next to the ticket (not for issues that live in a tracker). */
  images?: boolean;
  /** The toolbar, writing this markup (none without). */
  format?: Markup;
  /** What the Mention button inserts: the ticket ids' prefix. */
  mention?: string;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState<string | undefined>(undefined);
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
      onInput={(e) => setValue((e.target as HTMLTextAreaElement).value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onSubmit();
          return;
        }
        if (e.key === 'Escape' && onCancel) {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
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
  if (!format) return box;
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
      {box}
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
    if (!href || href.startsWith('#')) return;
    e.preventDefault();
    send({ type: 'openHref', href });
  };
  return <div ref={el} class="rendered" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

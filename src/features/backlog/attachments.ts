/**
 * A ticket's attachments (BL-110): every image, GIF and video it shows, wherever it's referenced (its description or
 * an activity entry), and the files in its folder (`<backlog>/<id>/`) nothing references. Each once, newest first.
 * Pure: the host lists the folder and resolves each source as it does the ticket's inline media.
 */
import { mediaType, type MediaKind } from './media';
import { parseRunBlocks } from './runBlocks';

export interface Attachment {
  /** As referenced (or the folder's file, from the backlog's folder: "BL-3/shot.png"). */
  src: string;
  name: string;
  kind: MediaKind;
  /** The reference's alt text: its caption. */
  alt?: string;
  /** Who added it (the entry's author); undefined in the description, or for a file nothing references. */
  author?: string;
  /** When: its entry's date, or the file's ("YYYY-MM-DD HH:MM"). */
  date?: string;
  /** The entry that added it (its place in the activity); undefined for the description, or a file nothing references. */
  entry?: number;
  /** Where it comes from. */
  from: 'description' | 'activity' | 'folder';
  /** A recorded demo (BL-78): demo.gif or demo.mp4, or shown by an entry with a `run demo` block. */
  demo: boolean;
}

/** A file in the ticket's folder: its path from the backlog's folder ("BL-3/shot.png") and when it was written. */
export interface FolderFile {
  path: string;
  date: string;
}

// Code isn't read: an image written in a code block is an example, not something the ticket shows.
const FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[ \t]*$|(?![\s\S]))/gm;
const INLINE_CODE = /(`+)[^`\n]+?\1/g;
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const HTML_MEDIA = /<(img|video)\b([^>]*)>/gi;
const attr = (attributes: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attributes)?.slice(1).find((v) => v !== undefined);

/** The media a Markdown text shows, in order: its source, alt text and kind. */
export function mediaRefs(markdown: string): Array<{ src: string; alt?: string; kind: MediaKind }> {
  const text = markdown.replace(FENCE, '').replace(INLINE_CODE, '');
  const found: Array<{ at: number; src: string; alt?: string; kind: MediaKind }> = [];
  for (const m of text.matchAll(MARKDOWN_IMAGE)) {
    const src = m[2].replace(/^<|>$/g, '');
    found.push({ at: m.index, src, ...(m[1].trim() ? { alt: m[1].trim() } : {}), kind: mediaType(src)?.kind ?? 'image' });
  }
  for (const m of text.matchAll(HTML_MEDIA)) {
    const src = attr(m[2], 'src');
    if (!src) continue;
    const alt = attr(m[2], 'alt') ?? attr(m[2], 'title');
    found.push({ at: m.index, src, ...(alt?.trim() ? { alt: alt.trim() } : {}), kind: m[1].toLowerCase() === 'video' ? 'video' : (mediaType(src)?.kind ?? 'image') });
  }
  return found
    .filter((f) => !/^data:/i.test(f.src))
    .sort((a, b) => a.at - b.at)
    .map(({ at: _at, ...f }) => f);
}

/** What makes two references one file: a local path from the backlog's folder, normalized; a URL as it is. */
export function attachmentKey(src: string): string {
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src)) return src;
  let s = src.replace(/[?#].*$/, '');
  try {
    s = decodeURIComponent(s);
  } catch {
    // As written.
  }
  const parts: string[] = [];
  for (const p of s.replace(/\\/g, '/').split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else parts.push(p);
  }
  return (s.startsWith('/') ? '/' : '') + parts.join('/');
}

const baseName = (src: string) => attachmentKey(src).replace(/\/+$/, '').split('/').pop() || src;
const isDemoFile = (src: string) => /^demo(?:[-_.][^/]*)?\.(?:gif|mp4|webm)$/i.test(baseName(src));

/** A ticket's attachments: referenced ones (first reference: who added it), then its folder's other files; newest first. */
export function gatherAttachments(
  description: string,
  entries: ReadonlyArray<{ date: string; author: string; body: string }>,
  folder: readonly FolderFile[] = [],
): Attachment[] {
  const seen = new Set<string>();
  const found: Attachment[] = [];
  const add = (a: Attachment) => {
    const key = attachmentKey(a.src);
    if (seen.has(key)) return;
    seen.add(key);
    found.push(a);
  };
  for (const r of mediaRefs(description)) add({ ...r, name: baseName(r.src), from: 'description', demo: isDemoFile(r.src) });
  entries.forEach((e, entry) => {
    const playsDemo = parseRunBlocks(e.body).some((b) => b.kind === 'demo');
    for (const r of mediaRefs(e.body)) {
      const demo = isDemoFile(r.src) || (playsDemo && (r.kind === 'video' || /\.gif$/i.test(attachmentKey(r.src))));
      add({ ...r, name: baseName(r.src), author: e.author, date: e.date, entry, from: 'activity', demo });
    }
  });
  for (const f of folder) {
    const type = mediaType(f.path);
    if (type) add({ src: f.path, name: baseName(f.path), kind: type.kind, date: f.date, from: 'folder', demo: isDemoFile(f.path) });
  }
  // Newest first; the description's (no date) last, in their order. The sort is stable: an entry's keep theirs.
  const rank = (a: Attachment) => a.date ?? '';
  return found.map((a, i) => ({ a, i })).sort((x, y) => rank(y.a).localeCompare(rank(x.a)) || x.i - y.i).map((x) => x.a);
}

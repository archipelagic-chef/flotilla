/**
 * The media a ticket shows (BL-79): images (GIFs among them) inline, videos in a player. Each kind has a size limit;
 * a larger file isn't shown or saved, and a note says why. Used by the host and the ticket's webview: no node:path.
 */

export type MediaKind = 'image' | 'video';

const MB = 1024 * 1024;

/** The largest file of each kind a ticket shows or saves. */
export const MEDIA_LIMITS: Record<MediaKind, number> = { image: 2 * MB, video: 10 * MB };

const TYPES: Record<string, { kind: MediaKind; type: string }> = {
  png: { kind: 'image', type: 'image/png' },
  jpg: { kind: 'image', type: 'image/jpeg' },
  jpeg: { kind: 'image', type: 'image/jpeg' },
  gif: { kind: 'image', type: 'image/gif' },
  webp: { kind: 'image', type: 'image/webp' },
  svg: { kind: 'image', type: 'image/svg+xml' },
  bmp: { kind: 'image', type: 'image/bmp' },
  avif: { kind: 'image', type: 'image/avif' },
  mp4: { kind: 'video', type: 'video/mp4' },
  webm: { kind: 'video', type: 'video/webm' },
};

/** A file's kind and MIME type, by its extension (a URL's query and fragment aside); undefined if it isn't media. */
export function mediaType(name: string): { kind: MediaKind; type: string } | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name.replace(/[?#].*$/, ''))?.[1].toLowerCase();
  return ext ? TYPES[ext] : undefined;
}

/** The kind of a pasted or dropped file, by its MIME type (or its name when the type is missing). */
export function fileKind(file: { type: string; name: string }): MediaKind | undefined {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type === 'video/mp4' || file.type === 'video/webm') return 'video';
  return file.type ? undefined : mediaType(file.name)?.kind;
}

export function tooLarge(kind: MediaKind, bytes: number): boolean {
  return bytes > MEDIA_LIMITS[kind];
}

// Rounded up, so a file just over a limit doesn't read as the limit.
const size = (bytes: number) => (bytes >= MB ? `${String(Math.ceil((bytes / MB) * 10) / 10)} MB` : `${Math.ceil(bytes / 1024)} KB`);

/** Why a file isn't shown or saved: it's over its kind's limit. */
export function tooLargeNote(name: string, kind: MediaKind, bytes: number): string {
  const what = kind === 'video' ? 'videos' : 'images and GIFs';
  return `${name} is ${size(bytes)}: ${what} can be at most ${size(MEDIA_LIMITS[kind])}. Make it smaller to show it.`;
}

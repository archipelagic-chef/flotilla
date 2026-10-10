import type { IconMap } from '../protocol';

/** The user's file icon theme, sent by the extension; until then (or without one) generic icons. */
let map: IconMap | undefined;
let sheet: CSSStyleSheet | undefined;

const cssId = (id: string) => `fi-${id.replace(/[^A-Za-z0-9_-]/g, (c) => `_${c.charCodeAt(0).toString(16)}`)}`;

export function setIconTheme(theme: { css: string; map: IconMap } | undefined): void {
  map = theme?.map;
  sheet ??= new CSSStyleSheet();
  sheet.replaceSync(theme?.css ?? '');
  if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

/** Class names for a file's icon: by file name, then the longest matching extension ("a.test.ts": "test.ts", then "ts"), then the default. */
export function fileIcon(name: string): string {
  if (!map) return 'codicon codicon-file';
  const lower = name.toLowerCase();
  let id = map.fileNames[lower];
  for (let dot = lower.indexOf('.'); !id && dot >= 0; dot = lower.indexOf('.', dot + 1)) id = map.fileExtensions[lower.slice(dot + 1)];
  id ??= map.file;
  return id ? `fi ${cssId(id)}` : 'fi';
}

/** Class names for a folder's icon; themes without folder icons (like Seti) get none, as in the Explorer. */
export function folderIcon(name: string, open: boolean): string {
  if (!map) return 'fi';
  const lower = name.toLowerCase();
  const id = open ? (map.folderNamesExpanded[lower] ?? map.folderExpanded ?? map.folderNames[lower] ?? map.folder) : (map.folderNames[lower] ?? map.folder);
  return id ? `fi ${cssId(id)}` : 'fi none';
}

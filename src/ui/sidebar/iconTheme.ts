import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

import type { IconMap } from '../../webview/protocol';

export type { IconMap };

export interface LoadedIconTheme {
  /** @font-face rules and one `.fi-<id>::before` rule per icon. */
  css: string;
  map: IconMap;
  /** Folders the webview must be allowed to load fonts and images from. */
  roots: vscode.Uri[];
}

interface FontDef {
  id: string;
  src: Array<{ path: string; format: string }>;
  weight?: string;
  style?: string;
  size?: string;
}
interface IconDef {
  iconPath?: string;
  fontCharacter?: string;
  fontColor?: string;
  fontId?: string;
  fontSize?: string;
}
interface Associations {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  languageIds?: Record<string, string>;
}
interface ThemeJson extends Associations {
  fonts?: FontDef[];
  iconDefinitions?: Record<string, IconDef>;
  light?: Associations;
}

/** Icon theme files are JSON with comments and trailing commas. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

export const cssId = (id: string) => `fi-${id.replace(/[^A-Za-z0-9_-]/g, (c) => `_${c.charCodeAt(0).toString(16)}`)}`;

/** Lower-cases keys, like VS Code's matching of file names and extensions. */
const lower = (r: Record<string, string> | undefined) => Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

/**
 * Builds the lookup table. Language ids are resolved to extensions and file names (from the languages extensions
 * contribute), below the theme's own extension and name entries, as in VS Code.
 */
export function buildIconMap(theme: ThemeJson, light: boolean, languages: { extensions: Record<string, string>; filenames: Record<string, string> }): IconMap {
  const pick = <K extends keyof Associations>(k: K): Associations[K] => (light && theme.light?.[k] !== undefined ? theme.light[k] : theme[k]);
  const merge = (k: 'fileExtensions' | 'fileNames' | 'folderNames' | 'folderNamesExpanded') => ({ ...lower(theme[k]), ...(light ? lower(theme.light?.[k]) : {}) });
  const languageIds = { ...(theme.languageIds ?? {}), ...(light ? (theme.light?.languageIds ?? {}) : {}) };
  const fileExtensions: Record<string, string> = {};
  const fileNames: Record<string, string> = {};
  for (const [ext, lang] of Object.entries(languages.extensions)) if (languageIds[lang]) fileExtensions[ext] = languageIds[lang];
  for (const [name, lang] of Object.entries(languages.filenames)) if (languageIds[lang]) fileNames[name] = languageIds[lang];
  return {
    file: pick('file'),
    folder: pick('folder'),
    folderExpanded: pick('folderExpanded'),
    fileExtensions: { ...fileExtensions, ...merge('fileExtensions') },
    fileNames: { ...fileNames, ...merge('fileNames') },
    folderNames: merge('folderNames'),
    folderNamesExpanded: merge('folderNamesExpanded'),
  };
}

/** File extensions and names of every language contributed by installed extensions. */
function contributedLanguages(): { extensions: Record<string, string>; filenames: Record<string, string> } {
  const extensions: Record<string, string> = {};
  const filenames: Record<string, string> = {};
  for (const ext of vscode.extensions.all) {
    const langs = (ext.packageJSON as { contributes?: { languages?: Array<{ id: string; extensions?: string[]; filenames?: string[] }> } }).contributes?.languages ?? [];
    for (const lang of langs) {
      for (const e of lang.extensions ?? []) extensions[e.replace(/^\./, '').toLowerCase()] ??= lang.id;
      for (const n of lang.filenames ?? []) filenames[n.toLowerCase()] ??= lang.id;
    }
  }
  return { extensions, filenames };
}

/** Loads the file icon theme the user picked (`workbench.iconTheme`); undefined when there is none. */
export async function loadIconTheme(webview: vscode.Webview): Promise<LoadedIconTheme | undefined> {
  const id = vscode.workspace.getConfiguration('workbench').get<string | null>('iconTheme');
  if (!id) return undefined;
  for (const ext of vscode.extensions.all) {
    const themes = (ext.packageJSON as { contributes?: { iconThemes?: Array<{ id: string; path: string }> } }).contributes?.iconThemes ?? [];
    const contribution = themes.find((t) => t.id === id);
    if (!contribution) continue;
    const file = path.join(ext.extensionPath, contribution.path);
    const theme = parseJsonc(await fs.readFile(file, 'utf8')) as ThemeJson;
    const base = vscode.Uri.file(path.dirname(file));
    const asset = (rel: string) => webview.asWebviewUri(vscode.Uri.joinPath(base, rel)).toString();
    const fonts = (theme.fonts ?? []).map(
      (f) =>
        `@font-face { font-family: "fi-font-${f.id}"; src: ${f.src.map((s) => `url("${asset(s.path)}") format("${s.format}")`).join(', ')}; font-weight: ${f.weight ?? 'normal'}; font-style: ${f.style ?? 'normal'}; }`,
    );
    const defaultFont = theme.fonts?.[0];
    const icons = Object.entries(theme.iconDefinitions ?? {}).map(([iconId, def]) => {
      if (def.iconPath) return `.${cssId(iconId)}::before { content: ""; background: url("${asset(def.iconPath)}") center / contain no-repeat; }`;
      const font = def.fontId ?? defaultFont?.id;
      return `.${cssId(iconId)}::before { content: "${def.fontCharacter ?? ''}"; font-family: "fi-font-${font}"; ${def.fontColor ? `color: ${def.fontColor};` : ''} ${def.fontSize ?? defaultFont?.size ? `font-size: ${def.fontSize ?? defaultFont?.size};` : ''} }`;
    });
    const light = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight;
    return { css: [...fonts, ...icons].join('\n'), map: buildIconMap(theme, light, contributedLanguages()), roots: [base] };
  }
  return undefined;
}

/** The folder of the active file icon theme, which the webview must be allowed to load fonts and images from. */
export function iconThemeRoot(): vscode.Uri | undefined {
  const id = vscode.workspace.getConfiguration('workbench').get<string | null>('iconTheme');
  for (const ext of id ? vscode.extensions.all : []) {
    const themes = (ext.packageJSON as { contributes?: { iconThemes?: Array<{ id: string; path: string }> } }).contributes?.iconThemes ?? [];
    const contribution = themes.find((t) => t.id === id);
    if (contribution) return vscode.Uri.file(path.dirname(path.join(ext.extensionPath, contribution.path)));
  }
  return undefined;
}

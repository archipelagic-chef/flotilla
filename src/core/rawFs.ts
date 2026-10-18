import * as nodeFs from 'node:fs';

/**
 * Node's fs without Electron's .asar handling, where there is one (the extension host): Electron's fs takes an .asar
 * file for a folder, so walking or deleting a folder that has one (a VS Code download under .vscode-test) opens the
 * archive and keeps it open, and the file can't be deleted. Plain node's fs elsewhere (tests, scripts).
 */
export function rawFs(): typeof nodeFs {
  try {
    return require('original-fs') as typeof nodeFs;
  } catch {
    return nodeFs;
  }
}

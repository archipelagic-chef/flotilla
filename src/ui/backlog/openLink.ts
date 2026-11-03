import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { toWorkspaceUri } from '../../core/uris';
import { parseReferenceLink } from '../../features/backlog/references';
import { parseFileLink } from '../../features/backlog/ticket';

/**
 * A link of a discussion's answer (BL-267): a ticket (or an entry of one), a web page, or a file, found
 * in the first of roots that has it.
 */
export async function openLink(reference: vscode.Uri, href: string, roots: readonly string[]): Promise<void> {
  const ref = parseReferenceLink(href, '');
  if (ref?.id) {
    await vscode.commands.executeCommand('flotilla.openBacklogItem', ref.id);
    return;
  }
  if (/^(https?|mailto):/i.test(href)) {
    await vscode.env.openExternal(vscode.Uri.parse(href));
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return;
  const link = parseFileLink(/^file:/i.test(href) ? vscode.Uri.parse(href).fsPath + (href.includes('#') ? href.slice(href.indexOf('#')) : '') : href);
  const found = (path.isAbsolute(link.path) ? [link.path] : roots.map((r) => path.join(r, link.path))).find((f) => fs.existsSync(f));
  if (!found) {
    void vscode.window.showWarningMessage(`${link.path} isn't there (anymore).`);
    return;
  }
  const uri = toWorkspaceUri(reference, found);
  if (fs.statSync(found).isDirectory()) {
    await vscode.commands.executeCommand('revealInExplorer', uri);
    return;
  }
  const selection = link.start ? new vscode.Range(link.start - 1, 0, (link.end ?? link.start) - 1, link.end ? Number.MAX_SAFE_INTEGER : 0) : undefined;
  await vscode.commands.executeCommand('vscode.open', uri, { preview: true, ...(selection ? { selection } : {}) });
}

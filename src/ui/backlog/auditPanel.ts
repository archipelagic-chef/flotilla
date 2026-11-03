import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { auditPage } from '../../features/sandbox/audit';
import type {
  AuditFilterView,
  AuditHostMessage,
  AuditWebviewMessage,
} from '../../webview/auditProtocol';
import type { Commands } from '../commandSet';
import type { SandboxAudit } from './sandboxAudit';

/** How many entries the tab shows at first, and more with each Load More. */
const PAGE = 100;

let open: { panel: vscode.WebviewPanel; show: (filter: AuditFilterView) => void } | undefined;

/**
 * Every sandboxed agent's audit entries in a tab of its own (BL-272), blocked first, filtered by ticket, agent, blocked
 * or allowed. Opening it again shows it, with the filter given.
 */
export function openAuditPanel(deps: { extensionUri: vscode.Uri; audit: SandboxAudit }, filter: AuditFilterView = {}): void {
  if (open) {
    open.panel.reveal();
    open.show(filter);
    return;
  }
  const dist = vscode.Uri.joinPath(deps.extensionUri, 'dist');
  const panel = vscode.window.createWebviewPanel('flotilla.audit', 'Sandbox Audit', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [dist],
  });
  panel.iconPath = vscode.Uri.joinPath(deps.extensionUri, 'media', 'flotilla.svg');
  panel.webview.html = html(panel.webview, dist);
  let shown = { filter, limit: PAGE };
  const post = () => {
    const all = deps.audit.entries();
    const page = auditPage(all, shown.filter, shown.limit);
    const message: AuditHostMessage = {
      type: 'audit',
      ...page,
      entries: page.entries.map(({ sandbox: _, ...e }) => e),
      filter: shown.filter,
      tickets: [...new Set(all.flatMap((e) => e.ticket ?? []))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      agents: [...new Set(all.flatMap((e) => e.agent ?? []))].sort(),
    };
    void panel.webview.postMessage(message);
  };
  open = {
    panel,
    show: (f) => {
      shown = { filter: f, limit: PAGE };
      post();
    },
  };
  const changed = deps.audit.onDidChange(post);
  panel.webview.onDidReceiveMessage(async (m: AuditWebviewMessage) => {
    if (m.type === 'ready') post();
    else if (m.type === 'filter') open?.show(m.filter);
    else if (m.type === 'more') {
      shown = { ...shown, limit: shown.limit + PAGE };
      post();
    } else if (m.type === 'openTicket') await vscode.commands.executeCommand('flotilla.openBacklogItem', m.id, { focus: 'audit' });
  });
  panel.onDidDispose(() => {
    changed.dispose();
    open = undefined;
  });
  // The latest lines, now: the tab is opened to see them.
  void deps.audit.copyAll();
}

/** The audit's command (BL-272): from a ticket's Audit section or the palette, filtered to a ticket when given one. */
export function auditCommands(deps: { extensionUri: vscode.Uri; audit: SandboxAudit }): Commands {
  return {
    'flotilla.openSandboxAudit': (o?: unknown) => {
      const ticket = (o as { ticket?: unknown } | undefined)?.ticket;
      openAuditPanel(deps, typeof ticket === 'string' ? { ticket } : {});
    },
  };
}

function html(webview: vscode.Webview, dist: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(dist, ...p)).toString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('codicons', 'codicon.css')}">
<link rel="stylesheet" href="${uri('audit.css')}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${uri('audit.js')}"></script>
</body>
</html>`;
}

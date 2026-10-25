import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import { eventsDir } from '../../features/metrics/events';
import { criteriaCount } from '../../features/metrics/productivity';
import { MetricsStore } from '../../features/metrics/store';
import type {
  MetricsHostMessage,
  MetricsPeriod,
  MetricsView,
  MetricsWebviewMessage,
} from '../../webview/metricsProtocol';

/** Events come in bursts (a merge records several): the views are counted again this long after the last. */
const SETTLE_MS = 2000;

/** The most agents running at once, as the view's line: flotilla.agents.maxRunning, or its older name when that's set. */
function agentLimit(): number {
  const settings = vscode.workspace.getConfiguration('flotilla');
  const older = settings.inspect<number>('autopilot.maxAgents');
  return Math.max(1, older?.workspaceFolderValue ?? older?.workspaceValue ?? older?.globalValue ?? settings.get<number>('agents.maxRunning', 2));
}

/**
 * The Metrics view (BL-158), counted in the extension host from the event log: for the sidebar's Metrics tool and for
 * its editor tab. The log's directory is watched, so a view that's open is counted again as events come in.
 */
export class Metrics implements vscode.Disposable {
  private readonly store: MetricsStore;
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when events were recorded (settled): the views that are open count again. */
  readonly onDidChange = this.changed.event;
  private watcher: fs.FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private panel: { panel: vscode.WebviewPanel; period: MetricsPeriod } | undefined;
  /** The acceptance criteria of the tickets done, by id (BL-189): a done ticket's description is read once. */
  private readonly criteria = new Map<string, number>();

  /** Called as a view is counted (BL-202): the chats' spend is read again soon, so a running chat's latest turns show. */
  onView?: () => void;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly commonDir: string,
    private readonly backlog?: LocalBacklog,
    /** Opens a chat in the worktree it ran in (BL-202). */
    private readonly chatOpener?: (session: string, cwd: string | undefined) => void,
  ) {
    this.store = new MetricsStore(commonDir);
  }

  async view(period: MetricsPeriod): Promise<MetricsView> {
    this.watch();
    this.onView?.();
    await this.readCriteria().catch(() => undefined);
    return this.store.view(period, Date.now(), { limit: agentLimit(), criteria: this.criteria });
  }

  /** Counts the criteria of the done tickets not counted yet: for those done before the move recorded them. */
  private async readCriteria(): Promise<void> {
    if (!this.backlog) return;
    for (const item of (await this.backlog.read()).items) {
      if (item.status !== 'done' || this.criteria.has(item.id)) continue;
      this.criteria.set(item.id, criteriaCount((await this.backlog.readTicket(item)).description));
    }
  }

  /** The message to answer a Metrics webview's request with: the view, or why it couldn't be counted. */
  async message(period: MetricsPeriod): Promise<MetricsHostMessage> {
    try {
      return { type: 'metricsView', view: await this.view(period) };
    } catch (error) {
      return { type: 'metricsError', message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Opens a chat of the Spend over time chart. */
  openChat(session: string, cwd: string | undefined): void {
    this.chatOpener?.(session, cwd);
  }

  /** Watches the log's directory, once something shows the view (made when it's missing, so it can be watched). */
  private watch(): void {
    if (this.watcher) return;
    const dir = eventsDir(this.commonDir);
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.watcher = fs.watch(dir, () => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.changed.fire(), SETTLE_MS);
      });
      this.watcher.on('error', () => this.watcher?.close());
    } catch {
      // Not watched: the view counts again when it's shown or its period changes.
    }
  }

  /** Opens the view in an editor tab (or shows the one that's open), on a period. */
  openEditor(period: MetricsPeriod): void {
    if (this.panel) {
      this.panel.panel.reveal();
      if (this.panel.period !== period) {
        this.panel.period = period;
        void this.post(period);
      }
      return;
    }
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel('flotilla.metrics', 'Metrics', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [dist],
    });
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'flotilla.svg');
    this.panel = { panel, period };
    panel.webview.html = html(panel.webview, dist, period);
    const sub = this.onDidChange(() => {
      if (this.panel) void this.post(this.panel.period);
    });
    panel.onDidDispose(() => {
      sub.dispose();
      this.panel = undefined;
    });
    panel.webview.onDidReceiveMessage((m: MetricsWebviewMessage) => {
      if (m.type === 'metrics' && this.panel) {
        this.panel.period = m.period;
        void this.post(m.period);
      } else if (m.type === 'metricsOpen') void vscode.commands.executeCommand('flotilla.openBacklogItem', m.ticket);
      else if (m.type === 'metricsOpenChat') this.openChat(m.session, m.cwd);
    });
  }

  private async post(period: MetricsPeriod): Promise<void> {
    const message = await this.message(period);
    void this.panel?.panel.webview.postMessage(message);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.watcher?.close();
    this.changed.dispose();
    this.panel?.panel.dispose();
  }
}

function html(webview: vscode.Webview, dist: vscode.Uri, period: MetricsPeriod): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(dist, ...p)).toString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('codicons', 'codicon.css')}">
<link rel="stylesheet" href="${uri('metrics.css')}">
</head>
<body data-period="${period}">
<div id="root"></div>
<script nonce="${nonce}" src="${uri('metrics.js')}"></script>
</body>
</html>`;
}

import * as path from 'node:path';
import * as vscode from 'vscode';
import { samePath } from '../core/paths';
import { WORKING } from '../core/diff/refs';
import type { ChangeKind, FileChange } from '../core/git/porcelain';
import type { Repository } from '../core/repository';
import { compareWithBase, type CompareMode } from '../features/diffs/compare';
import type { AttentionState } from '../features/workstreams/attention';
import type { Workstream } from '../features/workstreams/workstream';
import { ATTENTION_LABEL, COMPARE_MODE_LABEL, describeWorkstream, formatAge, workstreamContext, workstreamLabel } from './format';

export interface CompareState {
  base: string;
  mode: CompareMode;
}

export type Node =
  | { type: 'workstream'; ws: Workstream }
  | { type: 'message'; ws: Workstream; text: string }
  | { type: 'changes'; ws: Workstream }
  | { type: 'compare'; ws: Workstream; compare: CompareState }
  | { type: 'file'; ws: Workstream; change: FileChange; leftRef: string; rightRef: string; label: string }
  | { type: 'info'; text: string };

const ATTENTION_ICON: Record<AttentionState, [string, string | undefined]> = {
  'waiting-for-input': ['bell-dot', 'charts.yellow'],
  error: ['error', 'charts.red'],
  working: ['sync~spin', 'charts.blue'],
  done: ['pass', 'charts.green'],
  active: ['pulse', undefined],
  idle: ['circle-outline', undefined],
  stale: ['history', 'disabledForeground'],
  unreachable: ['debug-disconnect', 'disabledForeground'],
};

const CHANGE_ICON: Record<ChangeKind, string> = {
  modified: 'diff-modified',
  added: 'diff-added',
  deleted: 'diff-removed',
  renamed: 'diff-renamed',
  untracked: 'diff-added',
  conflicted: 'warning',
};

function themeIcon([id, color]: [string, string | undefined]): vscode.ThemeIcon {
  return new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);
}

function tooltip(ws: Workstream, now: Date): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const line = (text: string) => {
    md.appendText(text);
    md.appendMarkdown('\n\n');
  };
  line(workstreamLabel(ws));
  line(ws.worktree.path ?? `${ws.worktree.recordedPath} (not reachable from this environment)`);
  line(`Status: ${ATTENTION_LABEL[ws.attention]}`);
  if (ws.agent) line(`Agent: ${ws.agent.state}${ws.agent.message ? ` — ${ws.agent.message}` : ''} (${formatAge(ws.agent.updatedAt, now)} ago)`);
  const p = ws.progress;
  if (p?.base) line(`vs ${p.base}: ↑${p.ahead} ↓${p.behind}, +${p.added} −${p.deleted}`);
  if (p?.lastSubject) line(`Last commit: ${p.lastSubject}`);
  if (ws.windowOpen && ws.heartbeat) line(`Window open in ${ws.heartbeat.env} (${ws.heartbeat.os})`);
  return md;
}

export class WorkstreamsView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly compares = new Map<string, CompareState>();
  private readonly subscription: { dispose(): void };
  private treeView: vscode.TreeView<Node> | undefined;

  constructor(private readonly repository: Repository<Workstream>) {
    this.subscription = repository.onDidChange(() => this.emitter.fire(undefined));
  }

  setCompare(key: string, state: CompareState | undefined): void {
    if (state) this.compares.set(key, state);
    else this.compares.delete(key);
    this.emitter.fire(undefined);
  }

  /** Gives the provider its view so it can reveal items. */
  attach(treeView: vscode.TreeView<Node>): void {
    this.treeView = treeView;
  }

  /** Selects a workstream in the view without moving focus. Best effort: the view may be hidden. */
  async reveal(key: string): Promise<void> {
    const ws = this.repository.current.find((w) => samePath(w.key, key));
    if (!ws || !this.treeView) return;
    try {
      await this.treeView.reveal({ type: 'workstream', ws }, { select: true, focus: false });
    } catch {
      // view not visible yet
    }
  }

  getParent(node: Node): Node | undefined {
    return node.type === 'workstream' || node.type === 'info' ? undefined : { type: 'workstream', ws: node.ws };
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.type) {
      case 'workstream': {
        const ws = node.ws;
        const now = new Date();
        const item = new vscode.TreeItem(
          workstreamLabel(ws),
          ws.worktree.path ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        item.id = ws.key;
        item.description = describeWorkstream(ws, now);
        item.iconPath = themeIcon(ATTENTION_ICON[ws.attention]);
        item.tooltip = tooltip(ws, now);
        item.contextValue = workstreamContext(ws);
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(`“${node.text}”`);
        item.id = `${node.ws.key}#message`;
        item.iconPath = new vscode.ThemeIcon('comment');
        item.tooltip = node.text;
        return item;
      }
      case 'changes': {
        const count = node.ws.changes.length;
        const item = new vscode.TreeItem(`Changes (${count})`, count ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = `${node.ws.key}#changes`;
        item.iconPath = new vscode.ThemeIcon('diff');
        item.contextValue = 'changes';
        return item;
      }
      case 'compare': {
        const item = new vscode.TreeItem(`Compare: ${workstreamLabel(node.ws)} ↔ ${node.compare.base}`, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `${node.ws.key}#compare#${node.compare.base}#${node.compare.mode}`;
        item.description = COMPARE_MODE_LABEL[node.compare.mode];
        item.iconPath = new vscode.ThemeIcon('git-compare');
        item.contextValue = 'compare';
        return item;
      }
      case 'file': {
        const change = node.change;
        const item = new vscode.TreeItem(path.posix.basename(change.path));
        item.id = `${node.ws.key}#file#${node.leftRef}#${node.rightRef}#${change.path}`;
        const dir = path.posix.dirname(change.path);
        item.description = [dir === '.' ? '' : dir, change.origPath ? `← ${change.origPath}` : ''].filter(Boolean).join('  ');
        item.iconPath = new vscode.ThemeIcon(CHANGE_ICON[change.kind]);
        item.tooltip = `${change.kind}: ${change.path}`;
        item.contextValue = 'file';
        item.command = { command: 'flotilla.openFileDiff', title: 'Open Diff', arguments: [node] };
        return item;
      }
      case 'info': {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) return this.repository.current.map((ws) => ({ type: 'workstream', ws }));
    switch (node.type) {
      case 'workstream': {
        const ws = node.ws;
        if (!ws.worktree.path) return [];
        const children: Node[] = [];
        if (ws.agent?.message) children.push({ type: 'message', ws, text: ws.agent.message });
        children.push({ type: 'changes', ws });
        const compare = this.compares.get(ws.key);
        if (compare) children.push({ type: 'compare', ws, compare });
        return children;
      }
      case 'changes': {
        const label = `${workstreamLabel(node.ws)}: HEAD ↔ working`;
        return node.ws.changes.map((change) => ({ type: 'file', ws: node.ws, change, leftRef: 'HEAD', rightRef: WORKING, label }));
      }
      case 'compare': {
        const dir = node.ws.worktree.path;
        if (!dir) return [];
        try {
          const result = await compareWithBase(dir, node.compare.base, node.compare.mode);
          if (result.files.length === 0) return [{ type: 'info', text: 'No differences' }];
          const label = `${node.compare.base} ↔ ${workstreamLabel(node.ws)}`;
          return result.files.map((change) => ({ type: 'file', ws: node.ws, change, leftRef: result.leftRef, rightRef: result.rightRef, label }));
        } catch (error) {
          return [{ type: 'info', text: `Compare failed: ${error instanceof Error ? error.message : String(error)}` }];
        }
      }
      default:
        return [];
    }
  }
}

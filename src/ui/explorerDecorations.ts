import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ChangeKind } from '../core/git/porcelain';
import { pathKey } from '../core/paths';
import type { Repository } from '../core/repository';
import type { AttentionState } from '../features/workstreams/attention';
import type { Workstream } from '../features/workstreams/workstream';
import {
  ATTENTION_LABEL,
  describeSync,
  workstreamLabel,
} from './format';

/** Badges are at most two characters. */
const ATTENTION_BADGE: Partial<Record<AttentionState, [string, string | undefined]>> = {
  'waiting-for-input': ['?', 'charts.yellow'],
  error: ['!', 'charts.red'],
  working: ['…', 'charts.blue'],
  done: ['✓', 'charts.green'],
  active: ['●', undefined],
};

const CHANGE_BADGE: Record<ChangeKind, [string, string]> = {
  modified: ['M', 'gitDecoration.modifiedResourceForeground'],
  added: ['A', 'gitDecoration.addedResourceForeground'],
  deleted: ['D', 'gitDecoration.deletedResourceForeground'],
  renamed: ['R', 'gitDecoration.renamedResourceForeground'],
  untracked: ['U', 'gitDecoration.untrackedResourceForeground'],
  conflicted: ['!', 'gitDecoration.conflictingResourceForeground'],
};

/**
 * Decorates worktree folders with their workstream's state, and the changed files inside them with git-style badges.
 * Git ignores `.worktrees/` in the main worktree, so VS Code's own git decorations show nothing there.
 */
export class ExplorerDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private decorations = new Map<string, vscode.FileDecoration>();
  private readonly subscription: { dispose(): void };

  constructor(
    private readonly repository: Repository<Workstream>,
    private readonly reference: vscode.Uri,
    /** Worktrees that are workspace folders get file decorations from VS Code's own git. */
    private readonly inWorkspace: (ws: Workstream) => boolean,
  ) {
    this.subscription = repository.onDidChange(() => this.update());
    this.update();
  }

  update(): void {
    const next = new Map<string, vscode.FileDecoration>();
    for (const ws of this.repository.current) {
      const root = ws.worktree.path;
      if (!root || ws.isCurrent || ws.worktree.isMain) continue;
      next.set(pathKey(root), folderDecoration(ws));
      if (this.inWorkspace(ws)) continue;
      for (const change of ws.changes) {
        const [badge, color] = CHANGE_BADGE[change.kind];
        const file = path.join(root, change.path);
        next.set(pathKey(file), new vscode.FileDecoration(badge, `${change.kind} in ${workstreamLabel(ws)}`, new vscode.ThemeColor(color)));
        // Tint the folders in between ourselves: `propagate` would replace the worktree folder's own badge with a dot.
        for (let dir = path.dirname(file); dir.length > root.length; dir = path.dirname(dir)) {
          const key = pathKey(dir);
          if (next.has(key)) break;
          next.set(key, new vscode.FileDecoration(undefined, `Contains changes in ${workstreamLabel(ws)}`, new vscode.ThemeColor(color)));
        }
      }
    }
    this.decorations = next;
    this.emitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== this.reference.scheme || uri.authority !== this.reference.authority) return undefined;
    return this.decorations.get(pathKey(uri.fsPath));
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

function folderDecoration(ws: Workstream): vscode.FileDecoration {
  const count = ws.changes.length;
  const [badge, color] = ATTENTION_BADGE[ws.attention] ?? [count ? (count > 9 ? '9+' : String(count)) : undefined, undefined];
  const tooltip = [`⎇ ${workstreamLabel(ws)}`, ATTENTION_LABEL[ws.attention], describeSync(ws), count ? `${count} changed` : ''].filter(Boolean).join(' · ');
  // Without a tint of our own, git's "ignored" grey (from the main worktree's `.worktrees/` exclude) would apply.
  const tint = color ?? (count ? 'gitDecoration.modifiedResourceForeground' : 'foreground');
  return new vscode.FileDecoration(badge, tooltip, new vscode.ThemeColor(tint));
}

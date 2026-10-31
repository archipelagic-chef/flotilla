import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isInside } from '../core/paths';
import {
  claudeHome,
  transcriptPath,
} from '../features/chats/chats';
import { transcriptMarkdown } from '../features/chats/transcriptMarkdown';
import { runAgentInTerminal } from './backlog/agentRunner';

/** Read-only views of chats' transcripts, for chats Claude Code's panel can't open (agents' chats, BL-121). */
const SCHEME = 'flotilla-transcript';

/** The view's document: the transcript's file is in its query, its title in its path (the editor's tab shows it). */
function viewUri(file: string, title: string): vscode.Uri {
  const name =
    title
      .replace(/[\\/:*?"<>|#%\n\r]+/g, ' ')
      .trim()
      .slice(0, 80) || 'Chat';
  return vscode.Uri.from({ scheme: SCHEME, path: `/${name}.md`, query: file });
}

/** New lines of a growing transcript (a running agent's) are shown at most this often. */
const FOLLOW_MS = 1000;

/** Watches a file for changes (made or written): VS Code's watcher, which also works outside the workspace. */
export type Watch = (file: string, changed: () => void) => vscode.Disposable;

const watchFile: Watch = (file, changed) => {
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)));
  return vscode.Disposable.from(watcher, watcher.onDidCreate(changed), watcher.onDidChange(changed));
};

/**
 * The views' documents. Each follows its transcript while it's open: as the agent writes to it, the view is rendered
 * again (at most once a second), so a running agent can be watched.
 */
export class TranscriptViews implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly followed = new Map<string, { watcher: vscode.Disposable; timer?: ReturnType<typeof setTimeout> }>();

  constructor(private readonly watch: Watch = watchFile) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const file = uri.query;
    // Only Claude Code's transcripts are shown (the query is a path anyone could write into a link).
    if (!file.endsWith('.jsonl') || !isInside(path.join(claudeHome(), 'projects'), file)) return '';
    this.follow(uri);
    const title = path.basename(uri.path, '.md');
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      // An agent that has just started may not have written it yet: it shows once it has.
      raw = '';
    }
    return transcriptMarkdown(raw, title);
  }

  private follow(uri: vscode.Uri): void {
    const key = uri.toString();
    if (this.followed.has(key)) return;
    const entry: { watcher: vscode.Disposable; timer?: ReturnType<typeof setTimeout> } = {
      watcher: this.watch(uri.query, () => {
        entry.timer ??= setTimeout(() => {
          entry.timer = undefined;
          this.changed.fire(uri);
        }, FOLLOW_MS);
      }),
    };
    this.followed.set(key, entry);
  }

  /** Stops following a view whose document was closed. */
  unfollow(uri: vscode.Uri): void {
    const entry = this.followed.get(uri.toString());
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.watcher.dispose();
    this.followed.delete(uri.toString());
  }

  dispose(): void {
    for (const key of [...this.followed.keys()]) this.unfollow(vscode.Uri.parse(key));
    this.changed.dispose();
  }
}

export function registerTranscriptView(): vscode.Disposable {
  const views = new TranscriptViews();
  return vscode.Disposable.from(
    views,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, views),
    vscode.workspace.onDidCloseTextDocument((doc) => doc.uri.scheme === SCHEME && views.unfollow(doc.uri)),
  );
}

/**
 * Shows a chat's transcript read-only, rendered, following it while the agent runs, and offers to continue it in a
 * terminal in the folder it ran in (`claude --resume`): nothing is copied or relinked.
 */
export async function showTranscript(chat: { id: string; title: string }, cwd: string, running = false): Promise<void> {
  const file = transcriptPath(cwd, chat.id, claudeHome());
  await vscode.commands.executeCommand('markdown.showPreview', viewUri(file, chat.title));
  if (running) {
    void vscode.window.showInformationMessage(`'${chat.title}' is running: its chat is shown read-only, and follows it as it works.`);
    return;
  }
  const choice = await vscode.window.showInformationMessage(`'${chat.title}' is shown read-only.`, 'Continue in Terminal');
  // --name sets the chat's title: it's given the one it has, so resuming it doesn't rename it.
  if (choice) runAgentInTerminal({ cwd, prompt: '', resume: chat.id, name: chat.title });
}

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isInside } from '../core/paths';
import { claudeHome, transcriptPath } from '../features/chats/chats';
import { transcriptMarkdown } from '../features/chats/transcriptMarkdown';
import { runAgentInTerminal } from './backlog/agentRunner';

/** Read-only views of chats' transcripts, for chats Claude Code's panel can't open (agents' chats, BL-121). */
const SCHEME = 'flotilla-transcript';

/** The view's document: the transcript's file is in its query, its title in its path (the editor's tab shows it). */
function viewUri(file: string, title: string): vscode.Uri {
  const name = title.replace(/[\\/:*?"<>|#%\n\r]+/g, ' ').trim().slice(0, 80) || 'Chat';
  return vscode.Uri.from({ scheme: SCHEME, path: `/${name}.md`, query: file });
}

export function registerTranscriptView(): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
    async provideTextDocumentContent(uri) {
      const file = uri.query;
      // Only Claude Code's transcripts are shown (the query is a path anyone could write into a link).
      if (!file.endsWith('.jsonl') || !isInside(path.join(claudeHome(), 'projects'), file)) return '';
      const title = path.basename(uri.path, '.md');
      try {
        return transcriptMarkdown(await fs.readFile(file, 'utf8'), title);
      } catch {
        return `# ${title}\n\nIts transcript (${file}) can't be read.\n`;
      }
    },
  });
}

/**
 * Shows a chat's transcript read-only, rendered, and offers to continue it in a terminal in the folder it ran in
 * (`claude --resume`): nothing is copied or relinked.
 */
export async function showTranscript(chat: { id: string; title: string; agent?: string }, cwd: string): Promise<void> {
  const file = transcriptPath(cwd, chat.id, claudeHome());
  await vscode.commands.executeCommand('markdown.showPreview', viewUri(file, chat.title));
  const choice = await vscode.window.showInformationMessage(`'${chat.title}' is an agent's chat: it's shown read-only.`, 'Continue in Terminal');
  if (choice) runAgentInTerminal({ cwd, prompt: '', resume: chat.id, name: chat.agent ?? chat.title });
}

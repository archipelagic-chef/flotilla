/**
 * Messages between the extension host and the sidebar webview. Type-only: imported by both sides,
 * so it must not import vscode, node or DOM APIs.
 */
import type { ChangeKind } from '../core/git/porcelain';
import type { ChatState, LinkKind } from '../features/chats/chats';
import type { AttentionState } from '../features/workstreams/attention';

export type Tab = 'files' | 'vc' | 'chats';
export type ChangeGroup = 'staged' | 'unstaged';

export interface FileChangeView {
  path: string;
  origPath?: string;
  kind: ChangeKind;
}

export interface ChatView {
  id: string;
  title: string;
  state: ChatState;
  message?: string;
  open: boolean;
  linkedBy: LinkKind;
  /** Branch (or folder) the chat runs in, when it is linked here from elsewhere. */
  via?: string;
  /** "2m", "3h", "yesterday"-style age. */
  age: string;
}

export interface WorkstreamView {
  key: string;
  branch: string;
  initials: string;
  reachable: boolean;
  isMain: boolean;
  isCurrent: boolean;
  inWorkspace: boolean;
  attention: AttentionState;
  /** One line: status, progress, sync, window. */
  description: string;
  /** Tooltip for the rail tile and header. */
  tooltip: string;
  staged: FileChangeView[];
  unstaged: FileChangeView[];
  sync: { kind: 'publish' | 'sync' | 'none'; text: string };
  chats: ChatView[];
  hasHooks: boolean;
  /** `;`-separated tokens for context-menu when-clauses, as in `webviewWorkstream =~ /;linked;/`. */
  context: string;
}

export interface DirEntry {
  name: string;
  dir: boolean;
}

export type HostMessage =
  | { type: 'state'; workstreams: WorkstreamView[] }
  | { type: 'dir'; key: string; path: string; entries: DirEntry[] }
  /** Directories that changed on disk; the webview re-lists the ones it shows. */
  | { type: 'dirsChanged'; key: string; paths: string[] }
  /** Scroll to a workstream; with path, expand to and highlight that file in the Files tab. */
  | { type: 'reveal'; key: string; path?: string; tab?: Tab }
  | { type: 'tab'; tab: Tab }
  /** Show an inline name box: a new file or folder in dir, or a rename of path. */
  | { type: 'edit'; key: string; kind: 'file' | 'folder'; dir: string }
  | { type: 'edit'; key: string; kind: 'rename'; path: string }
  /** The result of a create/rename from the inline box; on error the box stays open with the message. */
  | { type: 'editResult'; ok: boolean; error?: string }
  /** A commit from the message box succeeded; the webview clears that box. */
  | { type: 'committed'; key: string };

/** What a command acts on. Context-menu commands receive this too (merged with VS Code's webview fields). */
export interface Target {
  key: string;
  path?: string;
  group?: ChangeGroup;
  chatId?: string;
  /** Files of a multi-selection, in the same group. */
  paths?: string[];
  /** In the Files tab: path is a folder. */
  isDir?: boolean;
}

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'listDir'; key: string; path: string }
  | { type: 'openFile'; key: string; path: string; preview: boolean }
  | { type: 'commit'; key: string; message: string }
  | { type: 'create'; key: string; kind: 'file' | 'folder'; dir: string; name: string }
  | { type: 'rename'; key: string; path: string; name: string }
  /** Drag and drop: move a file or folder into dir (same or another worktree). */
  | { type: 'move'; from: { key: string; path: string }; to: { key: string; dir: string } }
  /** Runs a `flotilla.*` command with the target as its argument. */
  | { type: 'command'; command: string; target?: Target };

/**
 * Messages between the extension host and the sidebar webview. Type-only: imported by both sides,
 * so it must not import vscode, node or DOM APIs.
 */
import type { ChangeKind } from '../core/git/porcelain';
import type { ChatState, LinkKind } from '../features/chats/chats';
import type { FileMatches, SearchOptions } from '../features/search/gitGrep';
import type { AttentionState } from '../features/workstreams/attention';

/** The tools in the strip on the left. */
export type Tool = 'overview' | 'files' | 'search' | 'vc' | 'chats';

/** The worktree tab that shows every worktree. */
export const ALL = 'all';

export interface SearchGroup {
  key: string;
  files: FileMatches[];
}
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
  /** Short tab label: the ticket id in the branch, or its last part. */
  label: string;
  initials: string;
  reachable: boolean;
  isMain: boolean;
  isCurrent: boolean;
  inWorkspace: boolean;
  attention: AttentionState;
  /** One line: status, progress, sync, window. */
  description: string;
  /** Plain-text summary (branch, path, status) for screen readers and tests. */
  tooltip: string;
  /** The worktree's folder (or where it was, when unreachable). */
  path: string;
  /** What the agent last said (a question when it waits for input). */
  agentMessage?: string;
  staged: FileChangeView[];
  unstaged: FileChangeView[];
  sync: { kind: 'publish' | 'sync' | 'none'; text: string; ahead: number; behind: number };
  chats: ChatView[];
  hasHooks: boolean;
  /** `;`-separated tokens for context-menu when-clauses, as in `webviewWorkstream =~ /;linked;/`. */
  context: string;
}

/** How the webview finds a file's or folder's icon in the user's file icon theme. */
export interface IconMap {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
}

export interface DirEntry {
  name: string;
  dir: boolean;
  /** Ignored by git (.gitignore, info/exclude, core.excludesFile); shown greyed out, like in the Explorer. */
  ignored?: boolean;
}

export type HostMessage =
  | { type: 'state'; workstreams: WorkstreamView[] }
  | { type: 'dir'; key: string; path: string; entries: DirEntry[] }
  /** Directories that changed on disk; the webview re-lists the ones it shows. */
  | { type: 'dirsChanged'; key: string; paths: string[] }
  /** Scroll to a workstream; with path, expand to and highlight that file in the Files tab. */
  | { type: 'reveal'; key: string; path?: string; tool?: Tool }
  /** The active worktree changed outside the webview (shortcut, status bar). */
  | { type: 'active'; key: string }
  /** Worktrees whose tab is closed (still in the Overview). */
  | { type: 'tabs'; closed: string[] }
  | { type: 'searchResults'; id: number; groups: SearchGroup[]; truncated: boolean; limit: number; error?: string }
  /** The file icon theme (undefined: none, use generic icons). */
  | { type: 'iconTheme'; theme: { css: string; map: IconMap } | undefined }
  /** A replace finished; the webview searches again. */
  | { type: 'replaced'; count: number }
  | { type: 'tool'; tool: Tool }
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
  | { type: 'openFile'; key: string; path: string; preview: boolean; line?: number; range?: [number, number] }
  /** The user picked a worktree tab (key or ALL). */
  | { type: 'active'; key: string }
  /** limit: matches per worktree (more after "Show more"); the setting flotilla.search.maxResults by default. */
  | { type: 'search'; id: number; scope: string; query: string; options: SearchOptions; limit?: number }
  /** Replace every match in the scope, or only in one file (key + path). */
  | { type: 'replace'; scope: string; query: string; options: SearchOptions; replacement: string; key?: string; path?: string }
  /** VS Code views Flotilla doesn't replace, from the bottom of the tool strip. */
  | { type: 'openView'; view: 'extensions' | 'debug' }
  | { type: 'commit'; key: string; message: string; amend?: boolean; then?: 'push' | 'sync' }
  | { type: 'create'; key: string; kind: 'file' | 'folder'; dir: string; name: string }
  | { type: 'rename'; key: string; path: string; name: string }
  /** Drag and drop: move a file or folder into dir (same or another worktree). */
  | { type: 'move'; from: { key: string; paths: string[] }; to: { key: string; dir: string } }
  /** Runs a `flotilla.*` command with the target as its argument. */
  | { type: 'command'; command: string; target?: Target };

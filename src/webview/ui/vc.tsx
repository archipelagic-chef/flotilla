import { Fragment } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ChangeGroup, CommitView, CompareMode, FileChangeView, WorkstreamView } from '../protocol';
import { menuContext, run, send } from './api';
import type { Update } from './app';
import { CHANGE_LETTER } from './files';
import { fileIcon } from './icons';

interface Props {
  ws: WorkstreamView;
  draft: string;
  update: Update;
}

/** A worktree's history as far as it's been read. */
export interface Log {
  /** The commit it was read from; a new HEAD means it's read again. */
  head?: string;
  commits: CommitView[];
  more: boolean;
  loading?: boolean;
  error?: string;
}

type CommitAction = { amend?: boolean; then?: 'push' | 'sync' };

const COMMIT_MENU: Array<{ label: string; action: CommitAction }> = [
  { label: 'Commit', action: {} },
  { label: 'Commit & Push', action: { then: 'push' } },
  { label: 'Commit & Sync', action: { then: 'sync' } },
  { label: 'Commit (Amend)', action: { amend: true } },
];

/** Like VS Code's Source Control: a message box at the top, and one primary button below it. */
function CommitBox({ ws, draft, update }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const changes = ws.staged.length + ws.unstaged.length;
  const setDraft = (value: string) => update((p) => ({ ...p, drafts: { ...p.drafts, [ws.key]: value } }));
  const commit = (action: CommitAction = {}) => {
    setMenuOpen(false);
    send({ type: 'commit', key: ws.key, message: draft, ...action });
  };
  const target = { key: ws.key };

  // The box grows with the message, up to ten lines, like VS Code's.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    // scrollHeight leaves out the border (the box is border-box sized).
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + border, 10 * 18 + 8)}px`;
  }, [draft]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuOpen]);

  let primary;
  if (changes > 0) {
    const what = ws.staged.length ? `${ws.staged.length} staged change(s)` : `all ${ws.unstaged.length} change(s)`;
    primary = (
      <div class="split-button">
        <button class="button" data-tip={`Commit ${what} on ${ws.branch}`} onClick={() => commit()}>
          <i class="codicon codicon-check" />
          Commit
        </button>
        <button
          class="button more"
          aria-label="More Commit Actions…"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((o) => !o);
          }}
        >
          <i class="codicon codicon-chevron-down" />
        </button>
        {menuOpen && (
          <div class="menu" role="menu">
            {COMMIT_MENU.map((item) => (
              <button key={item.label} role="menuitem" onClick={() => commit(item.action)}>
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  } else if (ws.sync.kind === 'publish') {
    primary = (
      <button class="button wide" onClick={() => run('flotilla.publish', target)}>
        <i class="codicon codicon-cloud-upload" />
        Publish Branch
      </button>
    );
  } else if (ws.sync.kind === 'sync' && (ws.sync.ahead || ws.sync.behind)) {
    primary = (
      <button class="button wide" data-tip={`Pull ${ws.sync.behind} and push ${ws.sync.ahead} commit(s)`} onClick={() => run('flotilla.sync', target)}>
        <i class="codicon codicon-sync" />
        Sync Changes {ws.sync.behind > 0 && `${ws.sync.behind}↓`} {ws.sync.ahead > 0 && `${ws.sync.ahead}↑`}
      </button>
    );
  } else {
    primary = (
      <button class="button wide" disabled data-tip="There are no changes to commit">
        <i class="codicon codicon-check" />
        Commit
      </button>
    );
  }

  return (
    <div class="commit">
      <textarea
        ref={box}
        id={`msg-${ws.key}`}
        rows={1}
        value={draft}
        placeholder={`Message (Ctrl+Enter to commit on "${ws.branch}")`}
        aria-label={`Commit message for ${ws.branch}`}
        onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && changes > 0) {
            e.preventDefault();
            commit();
          }
        }}
      />
      {primary}
    </div>
  );
}

/** Version Control › Changes: the commit box and the staged and unstaged changes. */
export function VcBody({ ws, draft, update }: Props) {
  const total = ws.staged.length + ws.unstaged.length;
  return (
    <div class="vc">
      <CommitBox ws={ws} draft={draft} update={update} />
      <Group ws={ws} group="staged" title="Staged Changes" items={ws.staged} />
      <Group ws={ws} group="unstaged" title="Changes" items={ws.unstaged} />
      {total === 0 && (
        <div class="empty">
          {ws.sync.kind === 'sync' && !ws.sync.ahead && !ws.sync.behind ? 'Up to date with the remote. ' : ''}
          <button class="link" onClick={() => update((p) => ({ ...p, vcView: 'compare' }))}>
            Compare with…
          </button>
        </div>
      )}
    </div>
  );
}

/** A group is always shown, also when empty, so the staged and unstaged lanes stay in place. */
function Group({ ws, group, title, items }: { ws: WorkstreamView; group: ChangeGroup; title: string; items: FileChangeView[] }) {
  const target = { key: ws.key, group };
  return (
    <div class="group">
      <div
        class="row group-head"
        data-vscode-context={items.length ? menuContext('changeGroup', { key: ws.key, group, flotillaWs: ws.context }) : undefined}
      >
        <span class="name">{title}</span>
        <span class="hover-actions" hidden={!items.length}>
          <button class="icon" aria-label="Open Changes" onClick={() => run('flotilla.openChanges', target)}>
            <i class="codicon codicon-diff-multiple" />
          </button>
          {group === 'staged' ? (
            <button class="icon" aria-label="Unstage All Changes" onClick={() => run('flotilla.unstageAll', target)}>
              <i class="codicon codicon-remove" />
            </button>
          ) : (
            <>
              <button class="icon" aria-label="Discard All Changes" onClick={() => run('flotilla.discardAll', target)}>
                <i class="codicon codicon-discard" />
              </button>
              <button class="icon" aria-label="Stage All Changes" onClick={() => run('flotilla.stageAll', target)}>
                <i class="codicon codicon-add" />
              </button>
            </>
          )}
        </span>
        <span class="badge">{items.length}</span>
      </div>
      {items.map((c) => (
        <ChangeRow key={`${group}:${c.path}`} ws={ws} group={group} change={c} />
      ))}
      {!items.length && <div class="row group-empty">{group === 'staged' ? 'No staged changes' : 'No changes'}</div>}
    </div>
  );
}

function ChangeRow({ ws, group, change }: { ws: WorkstreamView; group: ChangeGroup; change: FileChangeView }) {
  const parts = change.path.replace(/\/$/, '').split('/');
  const name = parts.pop()!;
  const target = { key: ws.key, path: change.path, group };
  const discardable = group === 'unstaged' && change.kind !== 'conflicted';
  return (
    <div
      class="row change"
      role="button"
      tabIndex={0}
      data-tip={`${change.path}${change.origPath ? ` ← ${change.origPath}` : ''} · ${change.kind}`}
      data-vscode-context={menuContext('change', { key: ws.key, path: change.path, group, discardable, flotillaWs: ws.context })}
      onClick={() => run('flotilla.openFileDiff', target)}
      onKeyDown={(e) => e.key === 'Enter' && run('flotilla.openFileDiff', target)}
    >
      <i class="codicon codicon-file" />
      <span class={`name k-${change.kind}`}>{name}</span>
      <span class="dir">{parts.join('/')}</span>
      <span class="hover-actions" onClick={(e) => e.stopPropagation()}>
        {change.kind !== 'deleted' && (
          <button class="icon" aria-label="Open File" onClick={() => run('flotilla.openFile', target)}>
            <i class="codicon codicon-go-to-file" />
          </button>
        )}
        {discardable && (
          <button class="icon" aria-label="Discard Changes" onClick={() => run('flotilla.discard', target)}>
            <i class="codicon codicon-discard" />
          </button>
        )}
        {group === 'staged' ? (
          <button class="icon" aria-label="Unstage Changes" onClick={() => run('flotilla.unstage', target)}>
            <i class="codicon codicon-remove" />
          </button>
        ) : (
          <button class="icon" aria-label="Stage Changes" onClick={() => run('flotilla.stage', target)}>
            <i class="codicon codicon-add" />
          </button>
        )}
      </span>
      <span class={`letter k-${change.kind}`}>{CHANGE_LETTER[change.kind]}</span>
    </div>
  );
}

/** "3 min ago", "2 days ago", like VS Code's timeline. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  const steps: [number, string][] = [
    [60, 'sec'],
    [60, 'min'],
    [24, 'hr'],
    [7, 'day'],
    [4.35, 'wk'],
    [12, 'mo'],
    [Infinity, 'yr'],
  ];
  let v = s;
  for (const [size, unit] of steps) {
    if (v < size) {
      const n = Math.floor(v);
      return unit === 'sec' ? 'now' : `${n} ${unit}${n === 1 || unit === 'min' || unit === 'sec' ? '' : 's'} ago`;
    }
    v /= size;
  }
  return '';
}

/**
 * Version Control › History: the worktree's commits, newest first. They're read when shown and again when HEAD or
 * the upstream moves; "Load more" reads older ones.
 */
/** The files a commit changed, once read. */
export interface CommitFiles {
  files: FileChangeView[];
  loading?: boolean;
  error?: string;
}

interface HistoryProps {
  ws: WorkstreamView;
  log: Log | undefined;
  requestLog(key: string, skip: number): void;
  files(hash: string): CommitFiles | undefined;
  requestFiles(key: string, hash: string): void;
}

export function HistoryBody({ ws, log, requestLog, files, requestFiles }: HistoryProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (hash: string) => {
    const open = !expanded.has(hash);
    if (open) requestFiles(ws.key, hash);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(hash);
      else next.delete(hash);
      return next;
    });
  };
  const stamp = `${ws.sync.head}|${ws.sync.ahead}|${ws.sync.behind}`;
  useEffect(() => {
    requestLog(ws.key, 0);
  }, [stamp, ws.key, requestLog]);
  const commits = log?.commits ?? [];
  const outgoing = commits.filter((c) => c.outgoing).length;
  return (
    <div class="group history">
      <div class="row group-head">
        <span class="name">Commits</span>
        <span class="hover-actions">
          <button class="icon" aria-label="Refresh" onClick={() => requestLog(ws.key, 0)}>
            <i class="codicon codicon-refresh" />
          </button>
        </span>
        {outgoing > 0 && (
          <span class="badge outgoing" data-tip={`${outgoing} commit${outgoing === 1 ? '' : 's'} not pushed yet`}>
            {outgoing}↑
          </span>
        )}
      </div>
      {log?.error && <div class="row group-empty error">{log.error}</div>}
      {!log?.error && !commits.length && <div class="row group-empty">{log?.loading || !log ? 'Loading…' : 'No commits yet'}</div>}
      {commits.map((c) => (
        <Fragment key={c.hash}>
          <CommitRow ws={ws} commit={c} open={expanded.has(c.hash)} onToggle={() => toggle(c.hash)} />
          {expanded.has(c.hash) && <CommitDetails ws={ws} commit={c} files={files(c.hash)} />}
        </Fragment>
      ))}
      {log?.more && (
        <div class="row group-empty">
          <button class="link" disabled={log.loading} onClick={() => requestLog(ws.key, commits.length)}>
            {log.loading ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}

/** A commit: click to expand it into its message and changed files. */
function CommitRow({ ws, commit, open, onToggle }: { ws: WorkstreamView; commit: CommitView; open: boolean; onToggle(): void }) {
  const icon = commit.parents.length > 1 ? 'git-merge' : 'git-commit';
  return (
    <div
      class={`row log-row${commit.outgoing ? ' outgoing' : ''}`}
      role="treeitem"
      aria-expanded={open}
      tabIndex={0}
      data-tip-commit={open ? undefined : commit.hash}
      data-tip-key={ws.key}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || (e.key === 'ArrowRight' && !open) || (e.key === 'ArrowLeft' && open)) {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <i class={`codicon codicon-chevron-${open ? 'down' : 'right'} chev`} />
      <i class={`codicon codicon-${icon}`} />
      <span class="name">{commit.subject}</span>
      {/* The worktree's own branch goes without saying here; the hover lists every ref. */}
      {commit.refs
        .filter((r) => r !== ws.branch)
        .slice(0, 2)
        .map((r) => (
          <span key={r} class={`ref${r.startsWith('tag: ') ? ' tag-ref' : r.includes('/') ? ' remote' : ''}`}>
            {r.replace(/^tag: /, '')}
          </span>
        ))}
      <span class="desc">{commit.author}</span>
      <span class="hover-actions" onClick={(e) => e.stopPropagation()}>
        <button class="icon" aria-label="Open All Changes" onClick={() => send({ type: 'openCommit', key: ws.key, hash: commit.hash })}>
          <i class="codicon codicon-diff-multiple" />
        </button>
        <button class="icon" aria-label="Copy Commit Hash" onClick={() => send({ type: 'copy', text: commit.hash })}>
          <i class="codicon codicon-copy" />
        </button>
      </span>
    </div>
  );
}

/** Under an expanded commit: the rest of its message, who and when, and the files it changed. */
function CommitDetails({ ws, commit, files }: { ws: WorkstreamView; commit: CommitView; files: CommitFiles | undefined }) {
  const date = new Date(commit.date);
  return (
    <div class="commit-details" role="group" aria-label={commit.subject}>
      {commit.body && <div class="commit-body">{commit.body}</div>}
      <div class="commit-meta">
        <span>{commit.author}</span>
        <span data-tip={date.toLocaleString()}>{ago(commit.date)}</span>
        <button class="link" data-tip="Copy Commit Hash" onClick={() => send({ type: 'copy', text: commit.hash })}>
          {commit.short}
        </button>
        {commit.outgoing && <span class="outgoing-note">not pushed yet</span>}
      </div>
      {files?.error && <div class="row group-empty error">{files.error}</div>}
      {!files?.error && !files?.files.length && <div class="row group-empty">{!files || files.loading ? 'Loading…' : 'No file changes'}</div>}
      {files?.files.map((f) => (
        <CommitFileRow key={f.path} ws={ws} commit={commit} change={f} />
      ))}
    </div>
  );
}

function CommitFileRow({ ws, commit, change }: { ws: WorkstreamView; commit: CommitView; change: FileChangeView }) {
  const parts = change.path.split('/');
  const name = parts.pop()!;
  const open = () => send({ type: 'openCommit', key: ws.key, hash: commit.hash, path: change.path });
  return (
    <div
      class="row change commit-file"
      role="button"
      tabIndex={0}
      data-tip={`${change.path}${change.origPath ? ` ← ${change.origPath}` : ''} · ${change.kind}`}
      onClick={open}
      onKeyDown={(e) => e.key === 'Enter' && open()}
    >
      <i class={fileIcon(name)} />
      <span class={`name k-${change.kind}`}>{name}</span>
      <span class="dir">{parts.join('/')}</span>
      <span class="hover-actions" onClick={(e) => e.stopPropagation()}>
        {change.kind !== 'deleted' && (
          <button class="icon" aria-label="Open File" onClick={() => run('flotilla.openFile', { key: ws.key, path: change.path })}>
            <i class="codicon codicon-go-to-file" />
          </button>
        )}
      </span>
      <span class={`letter k-${change.kind}`}>{CHANGE_LETTER[change.kind]}</span>
    </div>
  );
}

/** The hover of a commit: its whole message, author, date, hash and refs. */
export function CommitCard({ commit }: { commit: CommitView }) {
  const date = new Date(commit.date);
  return (
    <div class="hover-commit">
      <div class="hover-body">
        <div class="hover-row">
          <i class="codicon codicon-account" />
          <strong>{commit.author}</strong>
          <span class="muted">
            {ago(commit.date)} ({date.toLocaleString()})
          </span>
        </div>
        <div class="hover-title">
          <strong>{commit.subject}</strong>
        </div>
        {commit.body && <div class="hover-message">{commit.body}</div>}
        {commit.refs.length > 0 && (
          <div class="hover-row">
            {commit.refs.map((r) => (
              <span key={r} class={`ref${r.startsWith('tag: ') ? ' tag-ref' : r.includes('/') ? ' remote' : ''}`}>
                {r.replace(/^tag: /, '')}
              </span>
            ))}
          </div>
        )}
      </div>
      <div class="hover-status">
        <span>
          <i class="codicon codicon-git-commit" /> {commit.short}
          {commit.outgoing ? ' · not pushed yet' : ''}
        </span>
        <span>Click to see its changes</span>
      </div>
    </div>
  );
}

/** Branches and tags of a worktree's repository, to compare with. */
export interface Refs {
  defaultBase?: string;
  refs: string[];
}

/** The last comparison of a worktree. */
export interface Comparison {
  base: string;
  mode: CompareMode;
  files: FileChangeView[];
  loading?: boolean;
  error?: string;
}

const COMPARE_MODES: Array<{ mode: CompareMode; label: string; tip: (base: string) => string }> = [
  { mode: 'mergeBase', label: 'Branch', tip: (b) => `What this branch changed since it split from ${b} (merge-base…HEAD)` },
  { mode: 'uncommitted', label: '+ Uncommitted', tip: (b) => `What this branch changed since it split from ${b}, with uncommitted changes` },
  { mode: 'twoDot', label: 'Two-dot', tip: (b) => `Every difference between ${b} and HEAD (${b}..HEAD), also what ${b} changed since` },
];

interface CompareProps {
  ws: WorkstreamView;
  /** What the user chose; base defaults to the default branch. */
  choice: { base?: string; mode: CompareMode } | undefined;
  refs: Refs | undefined;
  comparison: Comparison | undefined;
  choose(key: string, choice: { base?: string; mode: CompareMode }): void;
  requestRefs(key: string): void;
  compare(key: string, base: string, mode: CompareMode): void;
}

/** Version Control › Compare: the files that differ between the worktree and a branch, tag or commit. */
export function CompareBody({ ws, choice, refs, comparison, choose, requestRefs, compare }: CompareProps) {
  const mode = choice?.mode ?? 'mergeBase';
  const fallback = refs?.defaultBase && refs.defaultBase !== ws.branch ? refs.defaultBase : undefined;
  const base = choice?.base ?? fallback ?? '';
  const [typed, setTyped] = useState(base);
  useEffect(() => setTyped(base), [base]);
  useEffect(() => {
    if (!refs) requestRefs(ws.key);
  }, [ws.key, refs, requestRefs]);
  // Again when HEAD moves, and for uncommitted changes when they change.
  const stamp = `${ws.sync.head}|${mode === 'uncommitted' ? [...ws.staged, ...ws.unstaged].map((c) => c.path).join('\n') : ''}`;
  useEffect(() => {
    if (base) compare(ws.key, base, mode);
  }, [ws.key, base, mode, stamp, compare]);

  const listId = `refs-${ws.key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const apply = () => {
    const next = typed.trim();
    if (next && next !== base) choose(ws.key, { base: next, mode });
  };
  const current = comparison && comparison.base === base && comparison.mode === mode ? comparison : undefined;
  const files = current?.files ?? [];
  return (
    <div class="compare">
      <div class="compare-bar">
        <div class="compare-input">
          <i class="codicon codicon-git-compare" />
          <input
            value={typed}
            list={listId}
            placeholder="Branch, tag or commit"
            aria-label={`Compare ${ws.branch} with`}
            onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
            onChange={apply}
            onKeyDown={(e) => {
              if (e.key === 'Enter') apply();
              else if (e.key === 'Escape') setTyped(base);
            }}
          />
          <datalist id={listId}>
            {(refs?.refs ?? [])
              .filter((r) => r !== ws.branch)
              .map((r) => (
                <option key={r} value={r} />
              ))}
          </datalist>
        </div>
        <div class="segmented" role="radiogroup" aria-label="What to compare">
          {COMPARE_MODES.map((m) => (
            <button
              key={m.mode}
              role="radio"
              aria-checked={mode === m.mode}
              data-tip={m.tip(base || 'the base')}
              onClick={() => choose(ws.key, { base: choice?.base, mode: m.mode })}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div class="group">
        <div class="row group-head">
          <span class="name">{base ? `${base} ↔ ${ws.branch}` : 'Files'}</span>
          <span class="hover-actions" hidden={!files.length}>
            <button class="icon" aria-label="Open All Changes" onClick={() => send({ type: 'openCompare', key: ws.key, base, mode })}>
              <i class="codicon codicon-diff-multiple" />
            </button>
            <button class="icon" aria-label="Refresh" onClick={() => compare(ws.key, base, mode)}>
              <i class="codicon codicon-refresh" />
            </button>
          </span>
          {current && !current.error && <span class="badge">{files.length}</span>}
        </div>
        {!base && <div class="row group-empty">Pick a branch, tag or commit to compare with</div>}
        {base && current?.error && <div class="row group-empty error">{current.error}</div>}
        {base && !current?.error && !files.length && (
          <div class="row group-empty">{!current || current.loading ? 'Comparing…' : `No differences with ${base}`}</div>
        )}
        {files.map((f) => (
          <CompareRow key={f.path} ws={ws} change={f} open={() => send({ type: 'openCompare', key: ws.key, base, mode, path: f.path })} />
        ))}
      </div>
    </div>
  );
}

function CompareRow({ ws, change, open }: { ws: WorkstreamView; change: FileChangeView; open(): void }) {
  const parts = change.path.split('/');
  const name = parts.pop()!;
  return (
    <div
      class="row change"
      role="button"
      tabIndex={0}
      data-tip={`${change.path}${change.origPath ? ` ← ${change.origPath}` : ''} · ${change.kind}`}
      onClick={open}
      onKeyDown={(e) => e.key === 'Enter' && open()}
    >
      <i class="codicon codicon-file" />
      <span class={`name k-${change.kind}`}>{name}</span>
      <span class="dir">{parts.join('/')}</span>
      <span class="hover-actions" onClick={(e) => e.stopPropagation()}>
        {change.kind !== 'deleted' && (
          <button class="icon" aria-label="Open File" onClick={() => run('flotilla.openFile', { key: ws.key, path: change.path })}>
            <i class="codicon codicon-go-to-file" />
          </button>
        )}
      </span>
      <span class={`letter k-${change.kind}`}>{CHANGE_LETTER[change.kind]}</span>
    </div>
  );
}

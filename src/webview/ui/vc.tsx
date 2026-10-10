import { Fragment } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ChangeGroup, CommitView, FileChangeView, RefCompareMode, RefComparison, Tool, VcView, WorkstreamView } from '../protocol';
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
          <button class="link" onClick={() => update((p) => withComparison(p, { head: ws.branch }))}>
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


/** Branches and tags to compare. */
export interface Refs {
  defaultBase?: string;
  refs: string[];
}

/** The answer to a comparison's latest request. */
export interface Comparison {
  /** The request it answers; older answers are dropped. */
  id: number;
  files: FileChangeView[];
  loading?: boolean;
  error?: string;
}

/** One comparison in Version Control › Compare (several, like GitLens). Unset refs follow the defaults. */
export interface CompareChoice {
  id: number;
  base?: string;
  head?: string;
  mode: RefCompareMode;
  /** When head is checked out in a worktree: compare that worktree's files, uncommitted changes included. */
  uncommitted: boolean;
  /** Shows only its header. */
  collapsed?: boolean;
}

/** Adds a comparison to the UI state and shows it: Compare's + and "Compare with…" in Changes. */
export function withComparison<P extends { comparisons: CompareChoice[]; nextComparison: number; tool: Tool; vcView: VcView }>(
  p: P,
  init: Partial<Omit<CompareChoice, 'id'>>,
): P {
  const choice: CompareChoice = { mode: 'mergeBase', uncommitted: true, ...init, id: p.nextComparison };
  // Earlier ones fold away, so the new one is in view.
  const folded = p.comparisons.map((c) => ({ ...c, collapsed: true }));
  return { ...p, tool: 'vc', vcView: 'compare', comparisons: [choice, ...folded], nextComparison: p.nextComparison + 1 };
}

const REF_COMPARE_MODES: Array<{ mode: RefCompareMode; label: string; tip: (base: string, head: string) => string }> = [
  { mode: 'mergeBase', label: 'Since split', tip: (b, h) => `What ${h} changed since it split from ${b} (${b}...${h})` },
  { mode: 'twoDot', label: 'All differences', tip: (b, h) => `Every difference between ${b} and ${h} (${b}..${h})` },
];

/** A ref box with suggestions; it applies on Enter or when it loses focus, and Escape undoes the typing. */
function RefInput({ label, value, refs, worktreeBranches, onApply }: { label: string; value: string; refs: string[]; worktreeBranches: ReadonlySet<string>; onApply(ref: string): void }) {
  const [typed, setTyped] = useState(value);
  useEffect(() => setTyped(value), [value]);
  const listId = `refs-${label.toLowerCase()}`;
  const apply = () => {
    const next = typed.trim();
    if (next && next !== value) onApply(next);
  };
  return (
    <label class="compare-input">
      <span class="compare-label">{label}</span>
      <input
        value={typed}
        list={listId}
        placeholder="Branch, tag or commit"
        onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
        onChange={apply}
        onKeyDown={(e) => {
          if (e.key === 'Enter') apply();
          else if (e.key === 'Escape') setTyped(value);
        }}
      />
      <datalist id={listId}>
        {refs.map((r) => (
          <option key={r} value={r} label={worktreeBranches.has(r) ? 'worktree' : undefined} />
        ))}
      </datalist>
    </label>
  );
}

interface CompareViewProps {
  workstreams: WorkstreamView[];
  comparisons: CompareChoice[];
  refs: Refs | undefined;
  results: ReadonlyMap<number, Comparison>;
  choose(id: number, change: Partial<CompareChoice>): void;
  close(id: number): void;
  add(): void;
  requestRefs(): void;
  compare(id: number, request: RefComparison): void;
}

/**
 * Version Control › Compare: comparisons of any two branches, tags or commits, whichever tab is active. Add them
 * with + under Version Control in the tool strip; closing the last one hides this view again.
 */
export function CompareView({ workstreams, comparisons, refs, results, choose, close, add, requestRefs, compare }: CompareViewProps) {
  useEffect(() => {
    if (!refs) requestRefs();
  }, [refs, requestRefs]);
  return (
    <div class="compare">
      <div class="tool-title backlog-title">
        <span>Comparisons</span>
        <button class="icon" aria-label="New Comparison" onClick={add}>
          <i class="codicon codicon-add" />
        </button>
      </div>
      {comparisons.map((c) => (
        <ComparisonCard
          key={c.id}
          workstreams={workstreams}
          choice={c}
          refs={refs}
          result={results.get(c.id)}
          choose={(change) => choose(c.id, change)}
          close={() => close(c.id)}
          compare={(request) => compare(c.id, request)}
        />
      ))}
    </div>
  );
}

interface CardProps {
  workstreams: WorkstreamView[];
  choice: CompareChoice;
  refs: Refs | undefined;
  result: Comparison | undefined;
  choose(change: Partial<CompareChoice>): void;
  close(): void;
  compare(request: RefComparison): void;
}

function ComparisonCard({ workstreams, choice, refs, result, choose, close, compare }: CardProps) {
  const base = choice.base ?? refs?.defaultBase ?? '';
  const head = choice.head ?? '';
  const worktree = workstreams.find((w) => w.reachable && w.branch === head);
  const withUncommitted = choice.uncommitted && worktree !== undefined;
  const request: RefComparison = { base, head, mode: choice.mode, worktree: withUncommitted ? worktree!.key : undefined };
  // Again when the refs move, and for a worktree's files when they change.
  const stamp = [
    ...workstreams.map((w) => `${w.branch}@${w.sync.head}`),
    withUncommitted ? [...worktree!.staged, ...worktree!.unstaged].map((c) => `${c.kind}:${c.path}`).join(',') : '',
  ].join('|');
  useEffect(() => {
    if (base && head) compare(request);
  }, [base, head, choice.mode, request.worktree, stamp]);

  const worktreeBranches = new Set(workstreams.map((w) => w.branch));
  const allRefs = [...new Set([...(refs?.refs ?? []), ...worktreeBranches])];
  const files = result?.files ?? [];
  const open = (path?: string) => send({ type: 'openCompare', ...request, path });
  const title = base && head ? `${base} ↔ ${head}${withUncommitted ? ' (working tree)' : ''}` : 'New comparison';
  return (
    <div class={`group comparison${choice.collapsed ? ' collapsed' : ''}`}>
      <div class="row group-head comparison-head" onClick={() => choose({ collapsed: !choice.collapsed })}>
        <i class={`codicon codicon-chevron-${choice.collapsed ? 'right' : 'down'} lane-chev-left`} />
        <i class="codicon codicon-git-compare" />
        <span class="name" data-tip={title}>
          {title}
        </span>
        <span class="hover-actions" onClick={(e) => e.stopPropagation()}>
          <button class="icon" aria-label="Open All Changes" disabled={!files.length} onClick={() => open()}>
            <i class="codicon codicon-diff-multiple" />
          </button>
          <button class="icon" aria-label="Swap" disabled={!base || !head} onClick={() => choose({ base: head, head: base })}>
            <i class="codicon codicon-arrow-swap" />
          </button>
          <button class="icon" aria-label="Refresh" disabled={!base || !head} onClick={() => compare(request)}>
            <i class="codicon codicon-refresh" />
          </button>
        </span>
        {result && !result.loading && !result.error && <span class="badge">{files.length}</span>}
        <button
          class="icon close"
          aria-label="Close Comparison"
          onClick={(e) => {
            e.stopPropagation();
            close();
          }}
        >
          <i class="codicon codicon-close" />
        </button>
      </div>
      {!choice.collapsed && (
        <>
          <div class="compare-bar">
            <RefInput label="Base" value={base} refs={allRefs} worktreeBranches={worktreeBranches} onApply={(r) => choose({ base: r })} />
            <RefInput label="With" value={head} refs={allRefs} worktreeBranches={worktreeBranches} onApply={(r) => choose({ head: r })} />
            <div class="segmented" role="radiogroup" aria-label="What to compare">
              {REF_COMPARE_MODES.map((m) => (
                <button
                  key={m.mode}
                  role="radio"
                  aria-checked={choice.mode === m.mode}
                  data-tip={m.tip(base || 'the base', head || 'the other side')}
                  onClick={() => choose({ mode: m.mode })}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {worktree && (
              <label class="check" data-tip={`Compare the files in ${worktree.label}'s worktree, not only its commits`}>
                <input type="checkbox" checked={choice.uncommitted} onChange={(e) => choose({ uncommitted: (e.target as HTMLInputElement).checked })} />
                Include uncommitted changes
              </label>
            )}
          </div>
          {(!base || !head) && <div class="row group-empty">Pick two branches, tags or commits to compare</div>}
          {base && head && result?.error && <div class="row group-empty error">{result.error}</div>}
          {base && head && !result?.error && !files.length && (
            <div class="row group-empty">{!result || result.loading ? 'Comparing…' : 'No differences'}</div>
          )}
          {files.map((f) => (
            <CompareRow key={f.path} worktree={worktree?.key} change={f} open={() => open(f.path)} />
          ))}
        </>
      )}
    </div>
  );
}

function CompareRow({ worktree, change, open }: { worktree: string | undefined; change: FileChangeView; open(): void }) {
  const parts = change.path.split('/');
  const name = parts.pop()!;
  return (
    <div
      class="row change"
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => e.key === 'Enter' && open()}
    >
      <i class={fileIcon(name)} />
      <span class={`name k-${change.kind}`}>{name}</span>
      <span class="dir">{parts.join('/')}</span>
      {worktree && change.kind !== 'deleted' && (
        <span class="hover-actions" onClick={(e) => e.stopPropagation()}>
          <button class="icon" aria-label="Open File" onClick={() => run('flotilla.openFile', { key: worktree, path: change.path })}>
            <i class="codicon codicon-go-to-file" />
          </button>
        </span>
      )}
      <span class={`letter k-${change.kind}`}>{CHANGE_LETTER[change.kind]}</span>
    </div>
  );
}

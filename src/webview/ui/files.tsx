import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import type { ChangeKind } from '../../core/git/porcelain';
import type { Target, WorkstreamView } from '../protocol';
import { menuContext, run, send } from './api';
import { dirKey, type FilesApi, type Update } from './app';
import { fileIcon, folderIcon } from './icons';

export const CHANGE_LETTER: Record<ChangeKind, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: '!',
};

/** An inline name box: a new file or folder in dir, or a rename of path. */
export type Editing =
  | { key: string; kind: 'file' | 'folder'; dir: string; error?: string }
  | { key: string; kind: 'rename'; path: string; error?: string };

const DRAG_TYPE = 'application/x-flotilla-files';

/** Path → change kind; unstaged wins over staged (it is what's on disk). Untracked folders come as "dir/". */
function changeMap(ws: WorkstreamView): Map<string, ChangeKind> {
  const map = new Map<string, ChangeKind>();
  for (const c of [...ws.staged, ...ws.unstaged]) map.set(c.path.replace(/\/$/, ''), c.kind);
  return map;
}

function folderKind(changes: Map<string, ChangeKind>, dir: string): ChangeKind | undefined {
  const own = changes.get(dir);
  if (own) return own;
  const prefix = `${dir}/`;
  for (const [p, kind] of changes) if (p.startsWith(prefix)) return kind === 'untracked' || kind === 'added' ? 'modified' : kind;
  return undefined;
}

const parentOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

/** Drop target handlers: accept Flotilla files dragged from any worktree and move them into dir. */
export function dropTarget(key: string, dir: string) {
  return {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      (e.currentTarget as HTMLElement).classList.add('drop-target');
    },
    onDragLeave: (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove('drop-target'),
    onDrop: (e: DragEvent) => {
      (e.currentTarget as HTMLElement).classList.remove('drop-target');
      const raw = e.dataTransfer?.getData(DRAG_TYPE);
      if (!raw) return;
      e.preventDefault();
      e.stopPropagation();
      send({ type: 'move', from: JSON.parse(raw) as { key: string; paths: string[] }, to: { key, dir } });
    },
  };
}

/** Every visible tree row, in order (across sections on the All tab). */
function visibleRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.content [role="treeitem"][data-path]')];
}

function focusRow(row: HTMLElement | undefined): void {
  row?.focus();
  row?.scrollIntoView({ block: 'nearest' });
}

interface Props {
  ws: WorkstreamView;
  files: FilesApi;
  expanded: string[];
  update: Update;
}

export function FilesBody({ ws, files, expanded, update }: Props) {
  const changes = changeMap(ws);
  const open = new Set(expanded);
  const toggle = (dir: string) =>
    update((p) => {
      const list = p.expanded[ws.key] ?? [];
      const next = list.includes(dir) ? list.filter((d) => d !== dir && !d.startsWith(`${dir}/`)) : [...list, dir];
      return { ...p, expanded: { ...p.expanded, [ws.key]: next } };
    });

  /** The files a command acts on: the whole selection when the row is part of it, else the row. */
  const targetFor = (path: string, isDir: boolean): Target => {
    const sel = files.selection;
    const paths = sel?.key === ws.key && sel.paths.includes(path) && sel.paths.length > 1 ? sel.paths : [path];
    return { key: ws.key, path, isDir, paths };
  };

  // Explorer keys: arrows move (Shift extends the selection), Right/Left open, close or go to the parent, Enter opens.
  const onKeyDown = (e: KeyboardEvent) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"][data-path]');
    if (!row || row.dataset.key !== ws.key) return;
    const path = row.dataset.path!;
    const isDir = row.dataset.dir === '1';
    const rows = visibleRows();
    const i = rows.indexOf(row);
    const mod = e.ctrlKey || e.metaKey;
    const move = (to: HTMLElement | undefined) => {
      if (!to) return;
      focusRow(to);
      files.select(to.dataset.key!, to.dataset.path!, e.shiftKey && to.dataset.key === files.selection?.key ? 'range' : 'single');
    };
    switch (e.key) {
      case 'ArrowDown':
        move(rows[i + 1]);
        break;
      case 'ArrowUp':
        move(rows[i - 1]);
        break;
      case 'Home':
        move(rows[0]);
        break;
      case 'End':
        move(rows[rows.length - 1]);
        break;
      case 'ArrowRight':
        if (isDir && !open.has(path)) toggle(path);
        else if (isDir) move(rows[i + 1]);
        break;
      case 'ArrowLeft':
        if (isDir && open.has(path)) toggle(path);
        else move(rows.find((r) => r.dataset.key === ws.key && r.dataset.path === parentOf(path)));
        break;
      case 'Enter':
        if (isDir) toggle(path);
        else send({ type: 'openFile', key: ws.key, path, preview: false });
        break;
      case 'F2':
        run('flotilla.renameFile', { key: ws.key, path, isDir });
        break;
      case 'Delete':
        run('flotilla.deleteFile', targetFor(path, isDir));
        break;
      case 'Backspace':
        if (!e.metaKey) return;
        run('flotilla.deleteFile', targetFor(path, isDir));
        break;
      default:
        if (mod && e.key === 'c') run('flotilla.copyFile', targetFor(path, isDir));
        else if (mod && e.key === 'x') run('flotilla.cutFile', targetFor(path, isDir));
        else if (mod && e.key === 'v') run('flotilla.pasteFile', { key: ws.key, path, isDir });
        else return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      class="tree"
      role="tree"
      aria-multiselectable="true"
      aria-label={`Files in ${ws.branch}`}
      // Tab into the tree lands on its first row when nothing in it is selected yet.
      tabIndex={files.selection?.key === ws.key ? -1 : 0}
      onFocus={(e) => {
        if (e.target === e.currentTarget) focusRow((e.currentTarget as HTMLElement).querySelector<HTMLElement>('[role="treeitem"]') ?? undefined);
      }}
      onKeyDown={onKeyDown}
      // The empty space below the rows acts on the worktree's top folder (rows have their own menus).
      data-vscode-context={menuContext('filesRoot', { key: ws.key, path: '', isDir: true, flotillaWs: ws.context })}
      {...dropTarget(ws.key, '')}
    >
      <Dir ws={ws} path="" depth={0} files={files} open={open} changes={changes} toggle={toggle} targetFor={targetFor} />
    </div>
  );
}

interface DirProps {
  ws: WorkstreamView;
  path: string;
  depth: number;
  files: FilesApi;
  open: ReadonlySet<string>;
  changes: Map<string, ChangeKind>;
  toggle(dir: string): void;
  targetFor(path: string, isDir: boolean): Target;
  /** Inside a git-ignored folder: everything here is ignored too. */
  inIgnored?: boolean;
}

function NameBox({ initial, icon, depth, error, onSubmit, onCancel }: { initial: string; icon: string; depth: number; error?: string; onSubmit(name: string): void; onCancel(): void }) {
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    // Like the Explorer: select the name without its extension.
    const dot = initial.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, []);
  const submit = () => {
    const value = input.current?.value.trim() ?? '';
    if (!value || value === initial) return onCancel();
    onSubmit(value);
  };
  return (
    <div class="row edit" style={{ paddingLeft: `${8 + depth * 8}px` }}>
      <i class={icon} />
      <div class="name-box">
        <input
          ref={input}
          defaultValue={initial}
          aria-label="Name"
          aria-invalid={error ? true : undefined}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') submit();
            else if (e.key === 'Escape') {
              done.current = true;
              onCancel();
            }
          }}
          onBlur={() => !done.current && submit()}
        />
        {error && <div class="name-error">{error.replace(/\*\*/g, '')}</div>}
      </div>
    </div>
  );
}

function Dir({ ws, path, depth, files, open, changes, toggle, targetFor, inIgnored }: DirProps) {
  const entries = files.dirs.get(dirKey(ws.key, path));
  useEffect(() => {
    if (!entries) files.requestDir(ws.key, path);
  }, [entries, ws.key, path]);
  const editing = files.editing?.key === ws.key ? files.editing : undefined;
  const creating = editing && editing.kind !== 'rename' && editing.dir === path ? editing : undefined;
  if (!entries) return <div class="row muted" style={{ paddingLeft: `${8 + depth * 8 + 16}px` }}>Loading…</div>;
  return (
    <>
      {creating && (
        <NameBox
          initial=""
          icon={creating.kind === 'folder' ? folderIcon('', false) : fileIcon('')}
          depth={depth + (creating.kind === 'folder' ? 0 : 2)}
          error={creating.error}
          onSubmit={(name) => send({ type: 'create', key: ws.key, kind: creating.kind, dir: path, name })}
          onCancel={files.stopEditing}
        />
      )}
      {!entries.length && depth === 0 && !creating && <div class="empty">This worktree has no files.</div>}
      {entries.map((entry) => {
        const rel = path ? `${path}/${entry.name}` : entry.name;
        const indent = 8 + depth * 8;
        const selected = files.isSelected(ws.key, rel);
        if (editing?.kind === 'rename' && editing.path === rel) {
          return (
            <NameBox
              key={rel}
              initial={entry.name}
              icon={entry.dir ? folderIcon(entry.name, false) : fileIcon(entry.name)}
              depth={depth + (entry.dir ? 0 : 2)}
              error={editing.error}
              onSubmit={(name) => send({ type: 'rename', key: ws.key, path: rel, name })}
              onCancel={files.stopEditing}
            />
          );
        }
        const target = targetFor(rel, entry.dir);
        const common = {
          'data-path': rel,
          'data-key': ws.key,
          'data-dir': entry.dir ? '1' : '0',
          'aria-selected': selected,
          tabIndex: selected ? 0 : -1,
          'data-vscode-context': menuContext(entry.dir ? 'folder' : 'file', { ...target, flotillaWs: ws.context }),
          draggable: true,
          onDragStart: (e: DragEvent) => {
            e.dataTransfer?.setData(DRAG_TYPE, JSON.stringify({ key: ws.key, paths: target.paths }));
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
          },
        };
        /** Ctrl/Cmd-click adds or removes a row, Shift-click selects a range; a plain click selects and opens. */
        const click = (e: MouseEvent, plain: () => void) => {
          if (e.ctrlKey || e.metaKey) files.select(ws.key, rel, 'toggle');
          else if (e.shiftKey) files.select(ws.key, rel, 'range');
          else {
            files.select(ws.key, rel, 'single');
            plain();
          }
        };
        if (entry.dir) {
          const isOpen = open.has(rel);
          const kind = folderKind(changes, rel);
          return (
            <div key={rel} role="none" {...dropTarget(ws.key, rel)}>
              <button class={`row${selected ? ' selected' : ''}${inIgnored || entry.ignored ? ' ignored' : ''}`} role="treeitem" aria-expanded={isOpen} style={{ paddingLeft: `${indent}px` }} {...common} onClick={(e) => click(e, () => toggle(rel))}>
                <i class={`codicon codicon-chevron-${isOpen ? 'down' : 'right'} chev`} />
                <i class={folderIcon(entry.name, isOpen)} />
                <span class={`name${kind ? ` k-${kind}` : ''}`}>{entry.name}</span>
                {kind && <span class={`letter k-${kind}`}>•</span>}
              </button>
              {isOpen && (
                <Dir
                  ws={ws}
                  path={rel}
                  depth={depth + 1}
                  files={files}
                  open={open}
                  changes={changes}
                  toggle={toggle}
                  targetFor={targetFor}
                  inIgnored={inIgnored || entry.ignored}
                />
              )}
            </div>
          );
        }
        const kind = changes.get(rel);
        return (
          <button
            key={rel}
            class={`row file${selected ? ' selected' : ''}${inIgnored || entry.ignored ? ' ignored' : ''}`}
            role="treeitem"
            style={{ paddingLeft: `${indent + 16}px` }}
            title={rel}
            {...common}
            onClick={(e) => click(e, () => send({ type: 'openFile', key: ws.key, path: rel, preview: true }))}
            onDblClick={() => send({ type: 'openFile', key: ws.key, path: rel, preview: false })}
          >
            <i class={fileIcon(entry.name)} />
            <span class={`name${kind ? ` k-${kind}` : ''}`}>{entry.name}</span>
            {kind && <span class={`letter k-${kind}`}>{CHANGE_LETTER[kind]}</span>}
          </button>
        );
      })}
    </>
  );
}

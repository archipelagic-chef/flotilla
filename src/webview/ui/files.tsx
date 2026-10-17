import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import type { ChangeKind } from '../../core/git/porcelain';
import type { Target, WorkstreamView } from '../protocol';
import { menuContext, run, send } from './api';
import { dirKey, type FilesApi, type Update } from './app';
import { fileIcon, folderIcon } from './icons';
import { Virtual } from './virtual';
import { treeRows, type TreeRow } from './treeRows';

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
const NO_MARKS: Record<string, ChangeKind> = {};

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
  // The host's marks cover every change, not only the first ones the view has (flotilla.changes.limit).
  const changes = files.marks.get(ws.key) ?? NO_MARKS;
  const open = new Set(expanded);
  const tree = useRef<HTMLDivElement>(null);
  const editing = files.editing?.key === ws.key ? files.editing : undefined;
  // Only the rows in view are drawn; the rows themselves come from the listings read so far.
  const rows = treeRows({
    entries: (path) => files.dirs.get(dirKey(ws.key, path)),
    open,
    create: editing && editing.kind !== 'rename' ? { dir: editing.dir, kind: editing.kind, error: editing.error } : undefined,
    rename: editing?.kind === 'rename' ? { path: editing.path, error: editing.error } : undefined,
  });
  const paths = rows.flatMap((r) => (r.kind === 'entry' ? [r.path] : []));
  const entryDirs = new Map(rows.flatMap((r) => (r.kind === 'entry' ? [[r.path, r.entry.dir] as const] : [])));
  useLayoutEffect(() => {
    files.publishRows(ws.key, paths);
  });
  // Folders that are open (or the top one) whose entries aren't read yet.
  useEffect(() => {
    for (const r of rows) if (r.kind === 'loading') files.requestDir(ws.key, r.path);
  });
  const anchor = files.selection?.key === ws.key ? files.selection.anchor : undefined;
  // Keyboard focus follows the selection while it's in the tree. A row scrolled out of view is unmounted (losing focus),
  // so the tree remembers that it had focus, and focuses the selected row once that row is drawn.
  const hasFocus = useRef(false);
  const focusRowAt = (path: string | undefined) => {
    if (path !== undefined) tree.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.focus();
  };
  useEffect(() => {
    if (!anchor || !hasFocus.current) return;
    requestAnimationFrame(() => {
      if (hasFocus.current) focusRowAt(anchor);
    });
  }, [anchor]);

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
    // Keys act on the selection (where the focus is, unless a fast key press came before it got there).
    const path = anchor ?? row.dataset.path!;
    const isDir = entryDirs.get(path) ?? row.dataset.dir === '1';
    const i = paths.indexOf(path);
    const mod = e.ctrlKey || e.metaKey;
    const move = (to: string | undefined) => {
      if (to === undefined) return;
      files.select(ws.key, to, e.shiftKey && files.selection?.key === ws.key ? 'range' : 'single');
      // A row already drawn takes the focus at once; one that has to scroll in takes it when it's drawn.
      if (hasFocus.current) focusRowAt(to);
    };
    switch (e.key) {
      case 'ArrowDown':
        move(paths[i + 1]);
        break;
      case 'ArrowUp':
        move(paths[i - 1]);
        break;
      case 'Home':
        move(paths[0]);
        break;
      case 'End':
        move(paths[paths.length - 1]);
        break;
      case 'ArrowRight':
        if (isDir && !open.has(path)) toggle(path);
        else if (isDir) move(paths[i + 1]);
        break;
      case 'ArrowLeft':
        if (isDir && open.has(path)) toggle(path);
        else move(paths.find((p) => p === parentOf(path)));
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

  const row = (r: TreeRow) => {
    switch (r.kind) {
      case 'loading':
        return <div class="row muted" style={{ paddingLeft: `${8 + r.depth * 8 + 16}px` }}>Loading…</div>;
      case 'empty':
        return <div class="empty">This worktree has no files.</div>;
      case 'create':
        return (
          <NameBox
            initial=""
            icon={r.createKind === 'folder' ? folderIcon('', false) : fileIcon('')}
            depth={r.depth + (r.createKind === 'folder' ? 0 : 2)}
            error={r.error}
            onSubmit={(name) => send({ type: 'create', key: ws.key, kind: r.createKind, dir: r.dir, name })}
            onCancel={files.stopEditing}
          />
        );
      case 'rename':
        return (
          <NameBox
            initial={r.entry.name}
            icon={r.entry.dir ? folderIcon(r.entry.name, false) : fileIcon(r.entry.name)}
            depth={r.depth + (r.entry.dir ? 0 : 2)}
            error={r.error}
            onSubmit={(name) => send({ type: 'rename', key: ws.key, path: r.path, name })}
            onCancel={files.stopEditing}
          />
        );
      case 'entry':
        return <EntryRow ws={ws} row={r} files={files} changes={changes} open={open} toggle={toggle} targetFor={targetFor} />;
    }
  };

  return (
    <div
      ref={tree}
      class="tree"
      role="tree"
      aria-multiselectable="true"
      aria-label={`Files in ${ws.branch}`}
      // Tab into the tree lands on its selected row (or the first one drawn) when nothing in it is selected yet.
      tabIndex={files.selection?.key === ws.key ? -1 : 0}
      onFocus={(e) => {
        if (e.target === e.currentTarget) focusRow((e.currentTarget as HTMLElement).querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"], [role="treeitem"]') ?? undefined);
      }}
      onFocusIn={() => {
        hasFocus.current = true;
      }}
      onFocusOut={(e) => {
        // Leaving for something outside the tree (not a row being unmounted, which has no new focus target).
        if (e.relatedTarget && !tree.current?.contains(e.relatedTarget as Node)) hasFocus.current = false;
      }}
      onKeyDown={onKeyDown}
      // The empty space below the rows acts on the worktree's top folder (rows have their own menus).
      data-vscode-context={menuContext('filesRoot', { key: ws.key, path: '', isDir: true, flotillaWs: ws.context })}
      {...dropTarget(ws.key, '')}
    >
      <Virtual items={rows} keyOf={(r) => r.key} render={row} reveal={anchor === undefined ? undefined : `entry:${anchor}`} />
    </div>
  );
}

/** A file or folder row of the tree. A folder is a drop target itself; a file drops into the folder it's in. */
function EntryRow({
  ws,
  row,
  files,
  changes,
  open,
  toggle,
  targetFor,
}: {
  ws: WorkstreamView;
  row: Extract<TreeRow, { kind: 'entry' }>;
  files: FilesApi;
  changes: Record<string, ChangeKind>;
  open: ReadonlySet<string>;
  toggle(dir: string): void;
  targetFor(path: string, isDir: boolean): Target;
}) {
  const { path: rel, entry, depth, ignored } = row;
  const indent = 8 + depth * 8;
  const selected = files.isSelected(ws.key, rel);
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
    const kind = changes[rel];
    return (
      <div role="none" {...dropTarget(ws.key, rel)}>
        <button class={`row${selected ? ' selected' : ''}${ignored ? ' ignored' : ''}`} role="treeitem" aria-expanded={isOpen} style={{ paddingLeft: `${indent}px` }} {...common} onClick={(e) => click(e, () => toggle(rel))}>
          <i class={`codicon codicon-chevron-${isOpen ? 'down' : 'right'} chev`} />
          <i class={folderIcon(entry.name, isOpen)} />
          <span class={`name${kind ? ` k-${kind}` : ''}`}>{entry.name}</span>
          {kind && <span class={`letter k-${kind}`}>•</span>}
        </button>
      </div>
    );
  }
  const kind = changes[rel];
  return (
    <div role="none" {...dropTarget(ws.key, parentOf(rel))}>
      <button
        class={`row file${selected ? ' selected' : ''}${ignored ? ' ignored' : ''}`}
        role="treeitem"
        style={{ paddingLeft: `${indent + 16}px` }}
        {...common}
        onClick={(e) => click(e, () => send({ type: 'openFile', key: ws.key, path: rel, preview: true }))}
        onDblClick={() => send({ type: 'openFile', key: ws.key, path: rel, preview: false })}
      >
        <i class={fileIcon(entry.name)} />
        <span class={`name${kind ? ` k-${kind}` : ''}`}>{entry.name}</span>
        {kind && <span class={`letter k-${kind}`}>{CHANGE_LETTER[kind]}</span>}
      </button>
    </div>
  );
}

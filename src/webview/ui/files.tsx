import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import type { ChangeKind } from '../../core/git/porcelain';
import type { WorkstreamView } from '../protocol';
import { menuContext, run, send } from './api';
import { dirKey, type FilesApi, type Update } from './app';

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

const DRAG_TYPE = 'application/x-flotilla-file';

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
      send({ type: 'move', from: JSON.parse(raw) as { key: string; path: string }, to: { key, dir } });
    },
  };
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
  return (
    <div class="tree" role="tree" aria-label={`Files in ${ws.branch}`} {...dropTarget(ws.key, '')}>
      <Dir ws={ws} path="" depth={0} files={files} open={open} changes={changes} toggle={toggle} />
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
      <i class={`codicon codicon-${icon}`} />
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

function Dir({ ws, path, depth, files, open, changes, toggle }: DirProps) {
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
          icon={creating.kind === 'folder' ? 'folder' : 'file'}
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
        const target = { key: ws.key, path: rel, isDir: entry.dir };
        const selected = files.selected?.key === ws.key && files.selected.path === rel;
        if (editing?.kind === 'rename' && editing.path === rel) {
          return (
            <NameBox
              key={rel}
              initial={entry.name}
              icon={entry.dir ? 'folder' : 'file'}
              depth={depth + (entry.dir ? 0 : 2)}
              error={editing.error}
              onSubmit={(name) => send({ type: 'rename', key: ws.key, path: rel, name })}
              onCancel={files.stopEditing}
            />
          );
        }
        const common = {
          'data-path': rel,
          'data-vscode-context': menuContext(entry.dir ? 'folder' : 'file', { ...target, flotillaWs: ws.context }),
          draggable: true,
          onDragStart: (e: DragEvent) => {
            e.dataTransfer?.setData(DRAG_TYPE, JSON.stringify({ key: ws.key, path: rel }));
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
          },
          onKeyDown: (e: KeyboardEvent) => {
            const mod = e.ctrlKey || e.metaKey;
            if (e.key === 'F2') run('flotilla.renameFile', target);
            else if (e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) run('flotilla.deleteFile', target);
            else if (mod && e.key === 'c') run('flotilla.copyFile', target);
            else if (mod && e.key === 'x') run('flotilla.cutFile', target);
            else if (mod && e.key === 'v') run('flotilla.pasteFile', target);
            else return;
            e.preventDefault();
          },
        };
        if (entry.dir) {
          const isOpen = open.has(rel);
          const kind = folderKind(changes, rel);
          return (
            <div key={rel} role="none" {...dropTarget(ws.key, rel)}>
              <button
                class={`row${selected ? ' selected' : ''}`}
                role="treeitem"
                aria-expanded={isOpen}
                style={{ paddingLeft: `${indent}px` }}
                {...common}
                onClick={() => {
                  files.select(ws.key, rel);
                  toggle(rel);
                }}
              >
                <i class={`codicon codicon-chevron-${isOpen ? 'down' : 'right'} chev`} />
                <span class={`name${kind ? ` k-${kind}` : ''}`}>{entry.name}</span>
                {kind && <span class={`letter k-${kind}`}>•</span>}
              </button>
              {isOpen && (
                <Dir ws={ws} path={rel} depth={depth + 1} files={files} open={open} changes={changes} toggle={toggle} />
              )}
            </div>
          );
        }
        const kind = changes.get(rel);
        return (
          <button
            key={rel}
            class={`row file${selected ? ' selected' : ''}`}
            role="treeitem"
            style={{ paddingLeft: `${indent + 16}px` }}
            title={rel}
            {...common}
            onClick={() => {
              files.select(ws.key, rel);
              send({ type: 'openFile', key: ws.key, path: rel, preview: true });
            }}
            onDblClick={() => send({ type: 'openFile', key: ws.key, path: rel, preview: false })}
          >
            <i class="codicon codicon-file" />
            <span class={`name${kind ? ` k-${kind}` : ''}`}>{entry.name}</span>
            {kind && <span class={`letter k-${kind}`}>{CHANGE_LETTER[kind]}</span>}
          </button>
        );
      })}
    </>
  );
}

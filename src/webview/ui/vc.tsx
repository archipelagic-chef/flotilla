import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ChangeGroup, FileChangeView, WorkstreamView } from '../protocol';
import { menuContext, run, send } from './api';
import type { Update } from './app';
import { CHANGE_LETTER } from './files';

interface Props {
  ws: WorkstreamView;
  draft: string;
  update: Update;
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

export function VcBody({ ws, draft, update }: Props) {
  const total = ws.staged.length + ws.unstaged.length;
  const target = { key: ws.key };
  return (
    <div class="vc">
      <CommitBox ws={ws} draft={draft} update={update} />
      <Group ws={ws} group="staged" title="Staged Changes" items={ws.staged} />
      <Group ws={ws} group="unstaged" title="Changes" items={ws.unstaged} />
      {total === 0 && (
        <div class="empty">
          {ws.sync.kind === 'sync' && !ws.sync.ahead && !ws.sync.behind ? 'Up to date with the remote. ' : ''}
          <button class="link" onClick={() => run('flotilla.compareWith', target)}>
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

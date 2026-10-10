import type { ChangeGroup, FileChangeView, WorkstreamView } from '../protocol';
import { menuContext, run, send } from './api';
import type { Update } from './app';
import { CHANGE_LETTER } from './files';

interface Props {
  ws: WorkstreamView;
  draft: string;
  update: Update;
}

export function VcBody({ ws, draft, update }: Props) {
  const total = ws.staged.length + ws.unstaged.length;
  const setDraft = (value: string) => update((p) => ({ ...p, drafts: { ...p.drafts, [ws.key]: value } }));
  const commit = () => send({ type: 'commit', key: ws.key, message: draft });
  const label = ws.staged.length ? `Commit ${ws.staged.length} Staged` : ws.unstaged.length ? `Commit All ${ws.unstaged.length}` : 'Commit';
  const target = { key: ws.key };
  return (
    <div class="vc">
      {total > 0 && (
        <div class="commit">
          <textarea
            id={`msg-${ws.key}`}
            rows={2}
            value={draft}
            placeholder={`Message (Ctrl+Enter to commit on ${ws.branch})`}
            aria-label={`Commit message for ${ws.branch}`}
            onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                commit();
              }
            }}
          />
          <button class="button" disabled={!draft.trim()} onClick={commit} title={draft.trim() ? undefined : 'Enter a commit message first'}>
            <i class="codicon codicon-check" />
            {label}
          </button>
        </div>
      )}
      <SyncLine ws={ws} clean={total === 0} />
      <Group ws={ws} group="staged" title="Staged Changes" items={ws.staged} />
      <Group ws={ws} group="unstaged" title="Changes" items={ws.unstaged} />
      {total === 0 && ws.sync.kind === 'none' && (
        <div class="empty">
          No changes.{' '}
          <button class="link" onClick={() => run('flotilla.compareWith', target)}>
            Compare with…
          </button>
        </div>
      )}
    </div>
  );
}

function SyncLine({ ws, clean }: { ws: WorkstreamView; clean: boolean }) {
  if (ws.sync.kind === 'none') return null;
  const target = { key: ws.key };
  return (
    <div class="sync-line">
      <i class={`codicon codicon-${ws.sync.kind === 'publish' ? 'cloud-upload' : clean ? 'check' : 'sync'}`} />
      <span>{clean ? `No changes · ${ws.sync.text}` : ws.sync.text}</span>
      {ws.sync.kind === 'publish' ? (
        <button class="button small" onClick={() => run('flotilla.publish', target)}>
          Publish Branch
        </button>
      ) : (
        <button class="button small secondary" onClick={() => run('flotilla.sync', target)} title="Pull, then push">
          <i class="codicon codicon-sync" />
          Sync
        </button>
      )}
    </div>
  );
}

function Group({ ws, group, title, items }: { ws: WorkstreamView; group: ChangeGroup; title: string; items: FileChangeView[] }) {
  if (!items.length) return null;
  const target = { key: ws.key, group };
  return (
    <div class="group">
      <div class="row group-head" data-vscode-context={menuContext('changeGroup', { key: ws.key, group, flotillaWs: ws.context })}>
        <span class="name">{title}</span>
        <span class="hover-actions">
          <button class="icon" title="Open Changes" onClick={() => run('flotilla.openChanges', target)}>
            <i class="codicon codicon-diff-multiple" />
          </button>
          {group === 'staged' ? (
            <button class="icon" title="Unstage All Changes" onClick={() => run('flotilla.unstageAll', target)}>
              <i class="codicon codicon-remove" />
            </button>
          ) : (
            <>
              <button class="icon" title="Discard All Changes" onClick={() => run('flotilla.discardAll', target)}>
                <i class="codicon codicon-discard" />
              </button>
              <button class="icon" title="Stage All Changes" onClick={() => run('flotilla.stageAll', target)}>
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
      title={`${change.path}${change.origPath ? ` ← ${change.origPath}` : ''} · ${change.kind}`}
      data-vscode-context={menuContext('change', { key: ws.key, path: change.path, group, discardable, flotillaWs: ws.context })}
      onClick={() => run('flotilla.openFileDiff', target)}
      onKeyDown={(e) => e.key === 'Enter' && run('flotilla.openFileDiff', target)}
    >
      <i class="codicon codicon-file" />
      <span class={`name k-${change.kind}`}>{name}</span>
      <span class="dir">{parts.join('/')}</span>
      <span class="hover-actions" onClick={(e) => e.stopPropagation()}>
        {change.kind !== 'deleted' && (
          <button class="icon" title="Open File" onClick={() => run('flotilla.openFile', target)}>
            <i class="codicon codicon-go-to-file" />
          </button>
        )}
        {discardable && (
          <button class="icon" title="Discard Changes" onClick={() => run('flotilla.discard', target)}>
            <i class="codicon codicon-discard" />
          </button>
        )}
        {group === 'staged' ? (
          <button class="icon" title="Unstage Changes" onClick={() => run('flotilla.unstage', target)}>
            <i class="codicon codicon-remove" />
          </button>
        ) : (
          <button class="icon" title="Stage Changes" onClick={() => run('flotilla.stage', target)}>
            <i class="codicon codicon-add" />
          </button>
        )}
      </span>
      <span class={`letter k-${change.kind}`}>{CHANGE_LETTER[change.kind]}</span>
    </div>
  );
}

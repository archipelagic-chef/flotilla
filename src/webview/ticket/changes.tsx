import {
  useEffect,
  useRef,
} from 'preact/hooks';
import type {
  TicketHostMessage,
  TicketView,
} from '../ticketProtocol';
import {
  ActionButton,
  send,
} from './actions';
import './changes.css';
import {
  biggestFiles,
  changeLetter,
} from './changeFiles';

function Counts({ added, deleted, binary }: { added: number; deleted: number; binary?: boolean }) {
  if (binary) return <span class="change-counts muted">binary</span>;
  return (
    <span class="change-counts">
      <span class="added">+{added}</span> {deleted > 0 && <span class="deleted">−{deleted}</span>}
    </span>
  );
}

const STAGE: Record<string, string> = {
  work: 'Compared with main where its branches split off',
  merged: 'Its merge into main',
  commits: 'Its commits on main, combined',
};

/**
 * What the ticket's work changes (BL-276): how big it is, its biggest files (each opening its diff in VS Code's diff
 * editor, beside the ticket) and View Version Control, which shows all of it under the ticket's card in the Backlog
 * (BL-275). The ticket has no file tree or diffs of its own.
 */
export function Changes({ ticket }: { ticket: TicketView }) {
  const change = ticket.changes;
  const section = useRef<HTMLElement>(null);
  // Back to the ticket from one of its diffs: its Changes in view.
  useEffect(() => {
    const listener = (e: MessageEvent<TicketHostMessage>) => {
      if (e.data.type === 'showChange') section.current?.scrollIntoView({ block: 'start' });
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);
  const { files, more } = change && change.files > 0 ? biggestFiles(change) : { files: [], more: 0 };
  return (
    <section class="block changes" ref={section}>
      <div class="block-head">
        <h2>
          Changes{' '}
          {change && change.files > 0 && (
            <span class="muted changes-total" title={STAGE[change.stage]}>
              {change.files} file{change.files === 1 ? '' : 's'} <Counts added={change.added} deleted={change.deleted} />
            </span>
          )}
        </h2>
        {change && change.files > 0 && (
          <ActionButton
            class="button view-vc"
            message={{ type: 'viewVersionControl' }}
            working="Opening…"
            title="All its changes, commits and CI in the Backlog, under its card"
          >
            <i class="codicon codicon-diff" /> View Version Control
          </ActionButton>
        )}
      </div>
      <div class="work">
        {!change ? (
          <div class="work-empty muted">Reading the changes…</div>
        ) : !change.files ? (
          <div class="work-empty muted">No changes yet</div>
        ) : (
          <>
            {files.map(({ group, file, branch }) => {
              const letter = changeLetter(file);
              return (
                <button
                  key={`${group}:${file.path}`}
                  class="change-file"
                  onClick={() => send({ type: 'openChange', group, path: file.path })}
                  title={`${file.origPath ? `${file.origPath} → ` : ''}${file.path}${file.uncommitted ? '\nNot committed yet' : ''}\nIts diff, beside the ticket`}
                >
                  <span class={`change-letter kind-${letter}`}>{letter}</span>
                  <span class="change-name">{file.path}</span>
                  {branch && <span class="branch-tag">{branch}</span>}
                  {file.uncommitted && <span class="change-uncommitted">uncommitted</span>}
                  <Counts added={file.added} deleted={file.deleted} binary={file.binary} />
                </button>
              );
            })}
            {more > 0 && (
              <button class="text-button changes-more" onClick={() => send({ type: 'viewVersionControl' })}>
                and {more} more in View Version Control
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

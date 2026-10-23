import { useEffect, useState } from 'preact/hooks';
import { capitalize } from '../../features/backlog/mainDrift';
import type { TicketView } from '../ticketProtocol';
import { PRIORITY } from '../ui/priority';
import { act, ActionButton, send } from './actions';
import { LANE_ICON } from './header';
import { ago } from './agents';

/**
 * Create Worktree ▾: a click creates a new worktree at once, its branch named without asking (numbered when the name is
 * taken); the menu's item asks for the branch name first. While one is being created, it says so and waits.
 */
export function CreateWorktreeButton({ creating, another }: { creating: boolean; another: boolean }) {
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);
  if (creating) {
    return (
      <button class="button secondary" disabled aria-busy="true">
        <i class="codicon codicon-loading codicon-modifier-spin" /> Creating worktree…
      </button>
    );
  }
  return (
    <span class="split-button">
      <ActionButton
        class="button secondary"
        message={{ type: 'start', agent: false, newWorktree: 'auto' }}
        working="Creating…"
        title="Creates a new worktree and branch for it at once, without an agent (an epic can have several)"
      >
        <i class="codicon codicon-git-branch" /> {another ? 'Add a Worktree' : 'Create Worktree'}
      </ActionButton>
      <button
        class="button secondary more"
        aria-label="More Ways to Create a Worktree…"
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={(e) => {
          e.stopPropagation();
          setMenu(!menu);
        }}
      >
        <i class="codicon codicon-chevron-down" />
      </button>
      {menu && (
        <span class="menu priority-menu" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              setMenu(false);
              act({ type: 'start', agent: false, newWorktree: 'named' }, 'Creating…');
            }}
          >
            <i class="codicon codicon-edit" />
            <span>Create Worktree with Branch Name…</span>
          </button>
        </span>
      )}
    </span>
  );
}

/** The ticket's parts (sub-tickets), with how far along they are. */
export function Parts({ ticket }: { ticket: TicketView }) {
  const done = ticket.children.filter((c) => c.status === 'done').length;
  return (
    <section class="block">
      <div class="block-head">
        <h2>
          Parts{' '}
          <span class="muted parts-progress">
            {done} of {ticket.children.length} done
          </span>
        </h2>
      </div>
      <div class="work">
        {ticket.children.map((c) => (
          <button
            key={c.id}
            class={`work-row${c.status === 'done' ? ' dim' : ''}`}
            onClick={() => send({ type: 'openTicket', id: c.id })}
            title="Open its ticket"
          >
            <i class={`codicon codicon-${c.proposed ? 'lightbulb' : LANE_ICON[c.status]}`} />
            <span class="hash">{c.id}</span>
            <span class="work-main subject">{c.title}</span>
            {c.proposed && <span class="branch-tag mention">proposed</span>}
            {c.priority && <i class={`codicon codicon-${PRIORITY[c.priority].icon} prio-${c.priority}`} />}
            <i class="codicon codicon-arrow-right open-arrow" />
          </button>
        ))}
      </div>
    </section>
  );
}

const COMMITS_SHOWN = 8;

/** A history kept from a clean-up: what it was, and (opened) its commits. */
function HistoryVersionRow({ version: v }: { version: TicketView['history'][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button class="work-row" onClick={() => setOpen(!open)} aria-expanded={open} title={`Kept as ${v.ref}: not a branch, and not pushed`}>
        <i class={`codicon codicon-chevron-${open ? 'down' : 'right'}`} />
        <span class="work-main">
          v{v.version} <span class="muted">{v.branch}</span>
        </span>
        <span class="muted">
          {v.commits} commit{v.commits === 1 ? '' : 's'}, cleaned up into {v.cleanCommits} · {ago(v.archived)}
        </span>
      </button>
      {open &&
        v.log.map((c) => (
          <ActionButton
            key={c.hash}
            class="work-row commit nested"
            message={{ type: 'openCommit', hash: c.hash }}
            working="Opening…"
            title={`${c.subject}\n${c.author}, ${new Date(c.date).toLocaleString()}\nClick to show what it changed`}
          >
            <span class="hash">{c.short}</span>
            <span class="work-main subject">{c.subject}</span>
            <span class="muted work-when">
              {c.author} · {ago(c.date)}
            </span>
          </ActionButton>
        ))}
    </>
  );
}

/** Where the work on the ticket is: its worktrees (and branches without one), and its commits. */
export function Work({ ticket }: { ticket: TicketView }) {
  const [allCommits, setAllCommits] = useState(false);
  const commits = allCommits ? ticket.commits : ticket.commits.slice(0, COMMITS_SHOWN);
  return (
    <section class="block">
      <div class="block-head">
        <h2>Work</h2>
      </div>
      <div class="work">
        <div class="work-head">
          <i class="codicon codicon-git-branch" /> Worktrees <span class="count">{ticket.worktrees.length}</span>
          {ticket.updateFromMain && (
            <ActionButton
              class="text-button work-head-action"
              message={{ type: 'updateFromMain' }}
              working="Updating…"
              title={`Merges ${ticket.updateFromMain.base} into its branch; when that conflicts, its agent does it and resolves the conflicts`}
            >
              <i class="codicon codicon-sync" /> Update from {capitalize(ticket.updateFromMain.base)}
            </ActionButton>
          )}
        </div>
        {!ticket.worktrees.length && <div class="work-empty muted">None yet. Create one above to work on it.</div>}
        {ticket.worktrees.map((ws) => (
          <button key={ws.key} class="work-row" onClick={() => send({ type: 'openWorktree', key: ws.key })} title="Open its tab in Flotilla">
            <span class="work-main">{ws.branch}</span>
            <span class={`state ${AGENT_STATE_CLASS[ws.attention] ?? ''}`}>{ws.status}</span>
            {ws.message && <span class="muted work-message">“{ws.message}”</span>}
            <span class="work-facts muted">
              {ws.changes > 0 && (
                <span title="Uncommitted changes">
                  <i class="codicon codicon-diff" /> {ws.changes}
                </span>
              )}
              {ws.upstream ? (
                (ws.ahead > 0 || ws.behind > 0) && (
                  <span title={`Against ${ws.upstream}: ${ws.ahead} to push, ${ws.behind} to pull`}>
                    {ws.ahead > 0 && `↑${ws.ahead}`} {ws.behind > 0 && `↓${ws.behind}`}
                  </span>
                )
              ) : (
                <span title="Not pushed yet">
                  <i class="codicon codicon-cloud" /> not pushed
                </span>
              )}
            </span>
            <i class="codicon codicon-arrow-right open-arrow" />
          </button>
        ))}
        {ticket.branches.map((b) => (
          <div key={b} class="work-row dim">
            <span class="work-main">{b}</span>
            <span class="muted">branch, no worktree</span>
            <ActionButton class="text-button work-action" message={{ type: 'checkout', branch: b }} working="Creating the worktree…" title="Create a worktree for this branch">
              <i class="codicon codicon-add" /> Worktree
            </ActionButton>
          </div>
        ))}
        <div class="work-head">
          <i class="codicon codicon-git-commit" /> Commits <span class="count">{ticket.commits.length}</span>
          {ticket.canCleanUp && (
            <ActionButton
              class="text-button work-head-action"
              message={{ type: 'cleanUp' }}
              working="Starting…"
              title="Rewrite the branch's commits into a clean history (an agent with you, or yourself). The old history is kept, and shown here."
            >
              <i class="codicon codicon-wand" /> Clean Up History…
            </ActionButton>
          )}
        </div>
        {!ticket.commits.length && <div class="work-empty muted">None yet. Commits on its branches, or that mention {ticket.item.id}, show here.</div>}
        {commits.map((c) => (
          <ActionButton
            key={c.hash}
            class="work-row commit"
            message={{ type: 'openCommit', hash: c.hash }}
            working="Opening…"
            title={`${c.subject}\n${c.author}, ${new Date(c.date).toLocaleString()}\nClick to show it in its worktree’s history`}
          >
            <span class="hash">{c.short}</span>
            <span class="work-main subject">{c.subject}</span>
            {c.branches.length ? (
              c.branches.map((b) => (
                <span key={b} class="branch-tag">
                  {b}
                </span>
              ))
            ) : (
              <span class="branch-tag mention" title={`Its message mentions ${ticket.item.id} or a linked issue`}>
                mentions it
              </span>
            )}
            <span class="muted work-when">
              {c.author} · {ago(c.date)}
            </span>
          </ActionButton>
        ))}
        {ticket.commits.length > COMMITS_SHOWN && (
          <button class="text-button work-more" onClick={() => setAllCommits(!allCommits)}>
            {allCommits ? 'Show fewer' : `Show all ${ticket.commits.length}`}
          </button>
        )}
        {ticket.history.length > 0 && (
          <>
            <div class="work-head">
              <i class="codicon codicon-history" /> Earlier Histories <span class="count">{ticket.history.length}</span>
            </div>
            {ticket.history.map((v) => (
              <HistoryVersionRow key={v.ref} version={v} />
            ))}
          </>
        )}
      </div>
    </section>
  );
}

const AGENT_STATE_CLASS: Record<string, string | undefined> = {
  'waiting-for-input': 'waiting',
  error: 'error',
  working: 'working',
  done: 'done',
};

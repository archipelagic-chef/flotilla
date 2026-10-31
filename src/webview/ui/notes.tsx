import {
  useEffect,
  useState,
} from 'preact/hooks';
import type {
  NoteView,
  WebviewMessage,
} from '../protocol';
import { send } from './api';
import { stopControlClick } from './cardClick';
import './notes.css';

type NoteMessage = Extract<WebviewMessage, { type: 'note' }>;

/** The note actions sent and not done yet (the host's noteDone ends each), and who re-renders when that changes. */
const pending = new Set<string>();
const listeners = new Set<() => void>();
const keyOf = (m: NoteMessage) => (m.op === 'new' ? 'new' : `${m.op}:${m.id}`);

function act(m: NoteMessage): void {
  pending.add(keyOf(m));
  listeners.forEach((l) => l());
  send(m);
}

/** The host is done with a note action (app.tsx calls it on noteDone). */
export function noteFinished(m: NoteMessage): void {
  pending.delete(keyOf(m));
  listeners.forEach((l) => l());
}

function useWorking(key: string): boolean {
  const [, render] = useState(0);
  useEffect(() => {
    const l = () => render((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return pending.has(key);
}

/** The limit a note's agent waits for (BL-203). */
const LIMIT: Record<NonNullable<NoteView['waits']>['kind'], string> = {
  usage: 'the usage limit',
  rate: 'the rate limit',
  overloaded: 'Claude to take work again',
};

const STATUS: Record<NoteView['status'], { icon: string; label: (n: NoteView) => string }> = {
  open: {
    icon: 'clock',
    label: (n) =>
      n.waits
        ? `${n.agent ?? 'Its agent'} is waiting for ${LIMIT[n.waits.kind]} (${n.waits.known ? 'resets' : 'tries again'} at ${new Date(n.waits.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`
        : n.agent
          ? `Waiting for ${n.agent} to go on`
          : 'Waiting for an agent',
  },
  working: { icon: 'loading codicon-modifier-spin', label: (n) => `${n.agent ?? 'An agent'} is turning it into tickets` },
  asking: { icon: 'comment-discussion', label: (n) => `${n.agent ?? 'Its agent'} asks you` },
  handled: { icon: 'pass', label: () => 'Handled' },
};

/** The tickets a note became, each opening its ticket. */
function Became({ note }: { note: NoteView }) {
  const proposals = note.became.filter((b) => b.kind === 'proposal');
  const added = note.became.filter((b) => b.kind === 'added');
  const links = (list: typeof note.became) =>
    list.map((b, i) => (
      <span key={b.id}>
        {i > 0 && ', '}
        <button class="link" onClick={() => send({ type: 'backlog', op: 'open', id: b.id })}>
          {b.id}
        </button>
      </span>
    ));
  if (!proposals.length && !added.length) return <span class="note-became">{note.status === 'handled' ? 'Became no ticket' : ''}</span>;
  return (
    <span class="note-became">
      {proposals.length > 0 && (
        <>
          Became {links(proposals)} ({proposals.length === 1 ? 'proposal' : 'proposals'})
        </>
      )}
      {proposals.length > 0 && added.length > 0 && '; '}
      {added.length > 0 && (
        <>
          {proposals.length ? 'added' : 'Added'} to {links(added)}
        </>
      )}
    </span>
  );
}

/** A note's Edit action (BL-204): its note tab, where you change what you wrote or write more, whatever its state. */
function EditNote({ id }: { id: string }) {
  return (
    <button
      class="icon note-edit"
      title="Edit the note, or write more in it: its agent takes in the change (a handled note is opened again)"
      aria-label={`Edit ${id}`}
      onClick={() => send({ type: 'note', op: 'open', id })}
    >
      <i class="codicon codicon-edit" />
    </button>
  );
}

const openNote = (id: string) => send({ type: 'note', op: 'open', id });

/** Answer on a note that asks (Needs you): its tab, at its agent's first question (BL-216). */
export function answerNote(id: string): void {
  send({ type: 'note', op: 'open', id, answer: true });
}

/** A note's × (BL-215): deletes it, with the notes handled with it, once you confirm (its agent stops). */
function DeleteNote({ id }: { id: string }) {
  const working = useWorking(`delete:${id}`);
  return (
    <button
      class="icon note-delete"
      title="Delete the note: its agent stops; the tickets it became stay"
      aria-label={`Delete ${id}`}
      disabled={working}
      onClick={(e) => {
        e.stopPropagation();
        act({ type: 'note', op: 'delete', id });
      }}
    >
      <i class={`codicon codicon-${working ? 'loading codicon-modifier-spin' : 'close'}`} />
    </button>
  );
}

/**
 * A note in the Notes lane (BL-216): its id and status, then its title, a line each; a click anywhere on it (or Enter)
 * opens its tab, where its agent's questions are answered. Its buttons (Edit, the tickets it became) do only their own.
 */
function NoteCard({ note, followers }: { note: NoteView; followers: NoteView[] }) {
  const status = STATUS[note.status];
  return (
    <div
      class={`note-card note-${note.status}`}
      tabIndex={0}
      title="Open the note: what you wrote, to edit, its agent's replies and questions, and a box to write more"
      onClick={() => openNote(note.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) openNote(note.id);
      }}
    >
      <div class="note-head" onClick={stopControlClick}>
        <span class="note-id">{note.id}</span>
        <i class={`codicon codicon-${status.icon}`} />
        <span class="note-status">{status.label(note)}</span>
        <EditNote id={note.id} />
        <DeleteNote id={note.id} />
      </div>
      <div class="note-line" onClick={stopControlClick}>
        <span class="note-title">{note.title}</span>
        {followers.length > 0 && (
          <span class="note-followers" title={followers.map((f) => `${f.id}: ${f.title}`).join('\n')}>
            +{followers.length} {followers.length === 1 ? 'note' : 'notes'}
          </span>
        )}
        {note.became.length > 0 && <Became note={note} />}
      </div>
    </div>
  );
}

/**
 * The Notes lane, under Needs you (a note is written in the editor: New Note): the notes not handled yet, each with
 * what its agent is doing (or that it asks) and how many notes are handled with it; then Past notes, folded, with what
 * each became.
 */
export function NotesLane({ notes }: { notes: NoteView[] }) {
  const [pastOpen, setPastOpen] = useState(false);
  const leads = notes.filter((n) => n.status !== 'handled' && !n.with);
  const followersOf = (id: string) => notes.filter((n) => n.with === id && n.status !== 'handled');
  const past = notes.filter((n) => n.status === 'handled' && !n.with).reverse();
  if (!leads.length && !past.length) return null;
  return (
    <div class="group lane notes-lane">
      {leads.length > 0 && (
        <>
          <div class="row group-head">
            <span class="name">Notes</span>
            <span class="badge">{leads.length}</span>
          </div>
          <div class="lane-body">
            {leads.map((n) => (
              <NoteCard key={n.id} note={n} followers={followersOf(n.id)} />
            ))}
          </div>
        </>
      )}
      {past.length > 0 && (
        <div class="notes-past">
          <div class="row group-head" onClick={() => setPastOpen(!pastOpen)}>
            <span class="name">Past notes</span>
            <i class={`codicon codicon-chevron-${pastOpen ? 'down' : 'right'} lane-chev`} aria-label={pastOpen ? 'Hide past notes' : 'Show past notes'} />
            <span class="badge">{past.length}</span>
          </div>
          {pastOpen && (
            <div class="lane-body">
              {past.map((n) => (
                <div key={n.id} class="row note-past">
                  <button class="link note-id" onClick={() => openNote(n.id)}>
                    {n.id}
                  </button>
                  <span class="note-past-title" title={n.text}>
                    {n.title}
                  </span>
                  <Became note={n} />
                  <EditNote id={n.id} />
                  <DeleteNote id={n.id} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

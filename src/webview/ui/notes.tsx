import { useEffect, useState } from 'preact/hooks';
import {
  type Answer,
  answerComment,
  answerOf,
  choose,
  defaultAnswer,
  type Question,
} from '../../features/backlog/report';
import type { NoteView, WebviewMessage } from '../protocol';
import { send } from './api';
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

const STATUS: Record<NoteView['status'], { icon: string; label: (n: NoteView) => string }> = {
  open: { icon: 'clock', label: (n) => (n.agent ? `Waiting for ${n.agent} to go on` : 'Waiting for an agent') },
  working: { icon: 'loading codicon-modifier-spin', label: (n) => `${n.agent ?? 'An agent'} is turning it into tickets` },
  asking: { icon: 'comment-discussion', label: (n) => `${n.agent ?? 'Its agent'} asks you` },
  handled: { icon: 'pass', label: () => 'Handled' },
};

/** A question's choices to click, and Other's text. */
function QuestionPicker({ q, answer, setAnswer }: { q: Question; answer: Answer; setAnswer(a: Answer): void }) {
  const other = q.options.length;
  return (
    <div class="note-question">
      <div class="note-question-text">{q.text}</div>
      {q.kind === 'text' ? (
        <input
          class="note-answer-line"
          value={answer.other}
          placeholder="Your answer"
          onInput={(e) => setAnswer({ picked: [0], other: (e.target as HTMLInputElement).value })}
        />
      ) : (
        <div class="note-choices">
          {q.options.map((o, i) => (
            <button
              key={o.text}
              class={`note-choice${answer.picked.includes(i) ? ' on' : ''}`}
              aria-pressed={answer.picked.includes(i)}
              onClick={() => setAnswer(choose(q, answer, i))}
            >
              {o.text}
              {o.recommended && <span class="note-recommended"> (recommended)</span>}
            </button>
          ))}
          <button
            class={`note-choice${answer.picked.includes(other) ? ' on' : ''}`}
            aria-pressed={answer.picked.includes(other)}
            onClick={() => setAnswer(choose(q, answer, other))}
          >
            Other…
          </button>
          {answer.picked.includes(other) && (
            <input
              class="note-answer-line"
              value={answer.other}
              placeholder="Your answer"
              onInput={(e) => setAnswer({ ...answer, other: (e.target as HTMLInputElement).value })}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** What the note's agent asks: its words, its questions to click, and a box for anything else. */
function NoteAsks({ note }: { note: NoteView }) {
  const asks = note.asks!;
  const [answers, setAnswers] = useState<Answer[]>(() => asks.questions.map(defaultAnswer));
  const [free, setFree] = useState('');
  const sending = useWorking(`answer:${note.id}`);
  const texts = asks.questions.map((q, i) => answerOf(q, answers[i] ?? defaultAnswer(q)));
  const complete = texts.every(Boolean);
  const body = [complete && asks.questions.length ? answerComment(asks.questions.map((question, i) => ({ question, answer: texts[i] }))) : '', free.trim()]
    .filter(Boolean)
    .join('\n\n');
  return (
    <div class="note-asks">
      {asks.reply && <div class="note-reply">{asks.reply}</div>}
      {asks.questions.map((q, i) => (
        <QuestionPicker key={q.text} q={q} answer={answers[i] ?? defaultAnswer(q)} setAnswer={(a) => setAnswers(answers.map((x, j) => (j === i ? a : x)))} />
      ))}
      <textarea
        class="notes-input"
        rows={2}
        placeholder={asks.questions.length ? 'Anything else to say?' : 'Your answer'}
        value={free}
        onInput={(e) => setFree((e.target as HTMLTextAreaElement).value)}
      />
      <button class="primary note-send" disabled={sending || !body} onClick={() => act({ type: 'note', op: 'answer', id: note.id, text: body })}>
        {sending ? 'Sending…' : 'Answer'}
      </button>
    </div>
  );
}

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

function NoteCard({ note, followers }: { note: NoteView; followers: NoteView[] }) {
  const status = STATUS[note.status];
  return (
    <div class={`note-card note-${note.status}`}>
      <div class="note-head">
        <button
          class="link note-id"
          title="Open the note: what you wrote, and its agent's replies"
          onClick={() => send({ type: 'note', op: 'open', id: note.id })}
        >
          {note.id}
        </button>
        <i class={`codicon codicon-${status.icon}`} />
        <span class="note-status">{status.label(note)}</span>
      </div>
      <div class="note-text">{note.text}</div>
      {followers.map((f) => (
        <div key={f.id} class="note-text note-follower" title={`${f.id}, handled with ${note.id}`}>
          <span class="note-id">{f.id}</span> {f.text}
        </div>
      ))}
      {note.became.length > 0 && <Became note={note} />}
      {note.asks && <NoteAsks key={note.asks.reply} note={note} />}
    </div>
  );
}

/**
 * The Notes lane, under Needs you (a note is written in the editor: New Note): the notes not handled yet, each with
 * what its agent is doing (and asks), the notes handled with it under it; then Past notes, folded, with what each became.
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
                  <button class="link note-id" onClick={() => send({ type: 'note', op: 'open', id: n.id })}>
                    {n.id}
                  </button>
                  <span class="note-past-title" title={n.text}>
                    {n.title}
                  </span>
                  <Became note={n} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

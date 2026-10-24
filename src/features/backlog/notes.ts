import * as fs from 'node:fs';
import * as path from 'node:path';
import { GUIDE, INBOX } from './inbox';
import { writeAtomic } from './localBacklog';
import { parseReport, type Question } from './report';
import { entryDate, formatTicket, parseTicket, type TicketEntry } from './ticket';

/**
 * Notes (BL-182): requests jotted down in the backlog ("Another thing I want is…"), as loosely as in a chat. An agent
 * picks each up, reads the code and the backlog, asks in the note when it must, and turns it into ticket proposals
 * (through the inbox) or additions to an existing ticket. The note then records what it became.
 *
 * Each note is a ticket-like file in .flotilla/backlog/notes/:
 *
 *   NOTE-12.md      "# First line", the note as written, then "## Activity" (the agent's replies, your answers)
 *   NOTE-12.json    its state: open, asking or handled, its agent and chat, the notes handled with it
 *   NOTE-12.became  what it became, a line per ticket ("BL-180 proposal", "BL-12 added"), appended by whoever records it
 *   NOTE-12/        its images
 */
export const NOTES = 'notes';
export const NOTE_PREFIX = 'NOTE';
const NOTE_ID = /^NOTE-(\d+)$/;

/** Notes written this close together are a row: one agent gets them all, and handles together those about one thing. */
export const ROW_MS = 3 * 60_000;
/** A row is picked up once its newest note is this old, so a note sent right after it joins it. */
export const SETTLE_MS = 20_000;

/** Open: waiting for an agent (again, after your answer). Asking: its agent asked you. Handled: it became tickets. */
export type NoteStatus = 'open' | 'asking' | 'handled';

export interface NoteState {
  /** When it was written (ISO 8601). */
  created: string;
  status: NoteStatus;
  /** The agent handling it, and its chat (resumed by your answer). */
  agent?: string;
  session?: string;
  /** On a note handled with others: the notes that came with it (it leads: its chat, its replies). */
  group?: string[];
  /** On a note handled with others: the one that leads. */
  with?: string;
  /** When it was handled (ISO 8601). */
  handled?: string;
}

export interface NoteOutcome {
  id: string;
  /** A ticket proposed from it, or an existing ticket it was added to. */
  kind: 'proposal' | 'added';
}

export interface Note extends NoteState {
  id: string;
  title: string;
  /** The note as written. */
  text: string;
  activity: TicketEntry[];
  became: NoteOutcome[];
}

/** The next note's id: one past the highest of the notes' files. */
export function nextNoteId(names: readonly string[]): string {
  let max = 0;
  for (const n of names) {
    const m = /^NOTE-(\d+)\./.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${NOTE_PREFIX}-${max + 1}`;
}

/** Whether an id is a note's ("NOTE-12"). */
export function isNoteId(id: string): boolean {
  return NOTE_ID.test(id);
}

/** A note's title: its first line of text (without images and Markdown marks), cut at 80 characters. */
export function noteTitle(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) =>
        l
          .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
          .replace(/^\s*(#+|[-*>]|\d+\.)\s+/, '')
          .trim(),
      )
      .find(Boolean) ?? 'Note';
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

/**
 * The notes an agent picks up next, oldest first, or undefined when none is due: a note answered after a question (its
 * chat goes on, with the notes that came with it), else the oldest open row, once its newest note has settled.
 */
export function nextNotes(notes: readonly Note[], busy: ReadonlySet<string>, now: number): Note[] | undefined {
  const open = notes.filter((n) => n.status === 'open' && !n.with && !busy.has(n.id)).sort((a, b) => a.created.localeCompare(b.created));
  const lead = open[0];
  if (!lead) return undefined;
  if (lead.session) return [lead, ...notes.filter((n) => lead.group?.includes(n.id))];
  const row = [lead];
  for (const n of open.slice(1)) {
    if (n.session || Date.parse(n.created) - Date.parse(row[row.length - 1].created) > ROW_MS) break;
    row.push(n);
  }
  return now - Date.parse(row[row.length - 1].created) < SETTLE_MS ? undefined : row;
}

/** The questions of the agent's newest reply in a note that asks you. */
export function noteQuestion(note: Pick<Note, 'status' | 'activity' | 'agent'>): { reply: string; questions: Question[] } | undefined {
  if (note.status !== 'asking') return undefined;
  const reply = [...note.activity].reverse().find((e) => /^agent\s/i.test(e.author));
  if (!reply) return undefined;
  const parts = parseReport(reply.body);
  return { reply: (parts.summary ?? reply.body).replace(/^(`{3,})question[\s\S]*?^\1\s*$/gm, '').trim(), questions: parts.questions };
}

/** Whether an agent's reply asks the user (a question block, or a "Needs from you:" line with something). */
export function asksUser(reply: string): boolean {
  return parseReport(reply).asks;
}

/** The tickets an agent's reply says it added to: its "Added to: BL-12, BL-30" line, those in the backlog. */
export function addedTo(reply: string, ids: readonly string[]): string[] {
  const known = new Map(ids.map((i) => [i.toLowerCase(), i]));
  const line = reply.split(/\r?\n/).find((l) => /^\s*[*_]*added to[*_]*\s*:/i.test(l));
  if (!line) return [];
  return [...new Set((line.match(/[A-Za-z][A-Za-z0-9_]*-\d+/g) ?? []).map((t) => known.get(t.toLowerCase())).filter((t): t is string => !!t))];
}

/** What a note became, as its card and its record say: "Became BL-180, BL-181 (proposals); added to BL-12". */
export function becameText(became: readonly NoteOutcome[], link: (id: string) => string = (id) => id): string {
  const proposals = became.filter((b) => b.kind === 'proposal').map((b) => link(b.id));
  const added = became.filter((b) => b.kind === 'added').map((b) => link(b.id));
  const parts = [
    ...(proposals.length ? [`Became ${proposals.join(', ')} (${proposals.length === 1 ? 'proposal' : 'proposals'})`] : []),
    ...(added.length ? [`${proposals.length ? 'added' : 'Added'} to ${added.join(', ')}`] : []),
  ];
  return parts.length ? parts.join('; ') : 'Became no ticket';
}

/** The line a proposal from notes ends its description with: "From [NOTE-12](notes/NOTE-12.md)." */
export function fromNotesLine(ids: readonly string[]): string {
  return `From ${ids.map((id) => `[${id}](${NOTES}/${id}.md)`).join(', ')}.`;
}

/** The ids of an inbox file's "note:" field ("NOTE-12", "NOTE-12, NOTE-13"). */
export function noteIdsOf(field: string | undefined): string[] {
  return [...new Set((field ?? '').toUpperCase().match(/NOTE-\d+/g) ?? [])];
}

/**
 * What a note agent may do: read and search the code and the backlog, write into the inbox, and edit the backlog's
 * tickets (to add to one). Write is offered, allowed where an Edit rule says (see headlessArgs); anything else is refused.
 */
export function noteTools(backlogDir: string): string[] {
  const dir = backlogDir.replace(/\\/g, '/').replace(/^\/+/, '');
  return ['Read', 'Grep', 'Glob', `Edit(//${dir}/${INBOX}/**)`, `Edit(//${dir}/*.md)`];
}

/** A note agent's first line: names first, as Flotilla reads only the start of a chat's first message. */
export function noteLead(note: Pick<Note, 'id' | 'title'>, agent: string): string {
  return `You are agent ${agent}, handling note ${note.id}: "${note.title}".`;
}

/** The note and agent name a note agent's chat was started for, from its first message (see noteLead). */
export function noteChatOf(firstPrompt: string | undefined): { note: string; agent: string } | undefined {
  const m = /^You are agent ([A-Za-z0-9-]+), handling note (NOTE-\d+)/.exec(firstPrompt?.trim() ?? '');
  return m ? { agent: m[1], note: m[2] } : undefined;
}

/** The rules every note prompt gives: where things are, what it writes, and what its reply is. */
function rules(o: { agent: string; notes: ReadonlyArray<{ id: string; file: string }>; backlogDir: string }): string[] {
  const inbox = path.join(o.backlogDir, INBOX);
  const ids = o.notes.map((n) => n.id);
  return [
    `The notes are ${o.notes.map((n) => `${n.id} (${n.file})`).join(', ')}: Markdown with what the user wrote, then an "## Activity" log of your replies and their answers. Read them first, with any images they link (paths relative to the notes' folder).`,
    `Before you propose anything, read the backlog (${path.join(o.backlogDir, 'backlog.json')}: the items in priority order, with id, title, status, parent; each item's ticket is <id>.md next to it) and the code this is about. Don't propose what a ticket already covers: when a note is about an existing ticket that nobody works on yet (To Do, or a proposal), add to that ticket's description instead (as acceptance criteria, or a section; leave its title and Activity as they are). When it's being worked on or done, propose a follow-up ticket instead, with "Depends on: <its id>" when it builds on it.`,
    `Propose tickets through the inbox, as ${path.join(o.backlogDir, GUIDE)} explains: a Markdown file per ticket in ${inbox}/ (any name ending in .md), with this front matter: \`note: ${ids.join(', ')}\` (the notes it comes from, so they record what they became), \`agent: ${o.agent}\`, and \`parent:\` when it's part of an existing ticket or of an epic you propose (propose the epic first, read its id from <name>.added, then its children). One ticket per piece of work someone can do and review on its own: one, several, or an epic with children, as the request needs.`,
    `Write each ticket in this shape: the title says what the user gets, as a short phrase; the description opens with "**When it's done:**" and what the user sees and does then (a short paragraph), then "**Why:**" and the reason, then "Acceptance criteria:" as a checklist ("- [ ] …"). When you found where in the code it goes, end with a short "### Where to start" section: the files and functions (as links with lines, like [src/a.ts:42](src/a.ts#L42)) and the approach. Add "Depends on: <id>" on a line of its own when it builds on another ticket's work.`,
    `When a note is unclear, or needs a choice only the user can make, ask before you propose: your reply then is a short line on what you found, the line "Needs from you:" and what it's about, then each question in a block fenced with \`\`\`question: its first line is the question, then the choices as "- " lines, with the one you suggest marked "(recommended)" ("choose: several" for checkboxes, "choose: yes/no" for Yes and No, no choices for a free answer). Then stop: the user answers in the note, and your chat goes on with their answer. Ask only what you can't decide yourself.`,
    `Your reply is your final message, and nothing else: Flotilla adds it to the end of the lead note's Activity, signed with your name. Write it as the reply only, with no heading and no signature. When you're done, keep it to a few lines: what you proposed or added, and why that way. When you added to existing tickets, end it with a line "Added to: <their ids>". Don't write in the notes yourself, and change no other file: no code, no branch, no commands.`,
  ];
}

/** The first message of a note agent's chat: its role, and how it turns the notes into tickets. */
export function notePrompt(o: { agent: string; notes: ReadonlyArray<Pick<Note, 'id' | 'title'> & { file: string }>; backlogDir: string }): string {
  const [lead] = o.notes;
  const several = o.notes.length > 1;
  return [
    noteLead(lead, o.agent),
    `The user jotted down ${several ? `${o.notes.length} notes in a row` : 'a note'} in the backlog: a request, as loosely as they'd say it in a chat (an idea, a bug, a wish). Turn ${several ? 'them' : 'it'} into ticket proposals that an agent can pick up and do, after looking at the code and the backlog.${several ? ' Notes about the same thing make tickets together; notes about different things, each its own.' : ''}`,
    ...rules(o),
  ].join('\n\n');
}

/** A message to a note agent whose chat goes on: the user answered in the note. */
export function noteFollowUp(o: { agent: string; notes: ReadonlyArray<{ id: string; file: string }>; backlogDir: string }): string {
  return [`The user answered in the note since your last reply: read the entries at the end of its "## Activity" section, and go on with it.`, ...rules(o)].join('\n\n');
}

/** The notes' files, in .flotilla/backlog/notes/. Only the leading window runs their agents; any window adds notes. */
export class NoteStore {
  readonly dir: string;
  /** This window's writes of a note's state, each after the one before. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly backlogDir: string) {
    this.dir = path.join(backlogDir, NOTES);
  }

  file(id: string): string {
    if (!isNoteId(id)) throw new Error(`Not a note: '${id}'.`);
    return path.join(this.dir, `${id}.md`);
  }

  /**
   * Adds a note: its id is the next free one (taken by creating its state file, so two windows can't take the same),
   * its images saved in its folder and linked at its end.
   */
  async add(text: string, images: ReadonlyArray<{ name: string; bytes: Uint8Array }> = [], now = new Date()): Promise<Note> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const state: NoteState = { created: now.toISOString(), status: 'open' };
    let id = '';
    for (let attempt = 0; attempt < 50; attempt++) {
      id = nextNoteId(await fs.promises.readdir(this.dir));
      try {
        await fs.promises.writeFile(this.stateFile(id), `${JSON.stringify(state, null, 1)}\n`, { flag: 'wx' });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt === 49) throw e;
      }
    }
    const refs: string[] = [];
    for (const image of images) refs.push(`![${path.basename(image.name)}](${await this.saveImage(id, image.name, image.bytes)})`);
    const body = [text.trim(), ...refs].filter(Boolean).join('\n\n');
    await writeAtomic(this.file(id), formatTicket({ title: noteTitle(text || refs[0] || ''), description: body, activity: [] }));
    return { id, ...state, title: noteTitle(text), text: body, activity: [], became: [] };
  }

  /** Every note, oldest first. */
  async list(): Promise<Note[]> {
    const names = await fs.promises.readdir(this.dir).catch(() => [] as string[]);
    const ids = names.flatMap((n) => /^(NOTE-\d+)\.json$/.exec(n)?.[1] ?? []);
    const notes = (await Promise.all(ids.map((id) => this.read(id)))).filter((n): n is Note => !!n);
    return notes.sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  }

  /** A note, or undefined when it has no state file (or it doesn't parse). */
  async read(id: string): Promise<Note | undefined> {
    let state: NoteState;
    try {
      state = JSON.parse(await fs.promises.readFile(this.stateFile(id), 'utf8')) as NoteState;
    } catch {
      return undefined;
    }
    const ticket = parseTicket(await fs.promises.readFile(this.file(id), 'utf8').catch(() => ''), id);
    return { ...state, id, title: ticket.title, text: ticket.description, activity: ticket.activity, became: await this.became(id) };
  }

  /** Changes a note's state, as it is when written. */
  setState(id: string, change: (state: NoteState) => NoteState): Promise<void> {
    const next = this.queue.then(async () => {
      const state = JSON.parse(await fs.promises.readFile(this.stateFile(id), 'utf8')) as NoteState;
      await writeAtomic(this.stateFile(id), `${JSON.stringify(change(state), null, 1)}\n`);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Adds an entry at the end of a note's activity. */
  append(id: string, entry: Omit<TicketEntry, 'date'>, now = new Date()): Promise<void> {
    const next = this.queue.then(async () => {
      const ticket = parseTicket(await fs.promises.readFile(this.file(id), 'utf8'), id);
      await writeAtomic(this.file(id), formatTicket({ ...ticket, activity: [...ticket.activity, { date: entryDate(now), ...entry }] }));
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Records that notes became a ticket (a line appended to each one's record: windows may record at once). */
  async recordBecame(ids: readonly string[], outcome: NoteOutcome): Promise<void> {
    for (const id of ids) {
      if (!isNoteId(id) || !fs.existsSync(this.stateFile(id))) continue;
      if ((await this.became(id)).some((b) => b.id === outcome.id && b.kind === outcome.kind)) continue;
      await fs.promises.appendFile(path.join(this.dir, `${id}.became`), `${outcome.id} ${outcome.kind}\n`);
    }
  }

  private async became(id: string): Promise<NoteOutcome[]> {
    const text = await fs.promises.readFile(path.join(this.dir, `${id}.became`), 'utf8').catch(() => '');
    return text.split('\n').flatMap((l) => {
      const m = /^(\S+)\s+(proposal|added)\s*$/.exec(l.trim());
      return m ? [{ id: m[1], kind: m[2] as NoteOutcome['kind'] }] : [];
    });
  }

  /** Saves an image in a note's folder (<id>/); returns its path relative to the notes, for Markdown. */
  async saveImage(id: string, name: string, bytes: Uint8Array): Promise<string> {
    this.file(id); // validates the id
    const folder = path.join(this.dir, id);
    await fs.promises.mkdir(folder, { recursive: true });
    const ext = (path.extname(name).toLowerCase().match(/^\.(png|jpe?g|gif|webp|svg)$/) ?? ['.png'])[0];
    const base = path.basename(name, path.extname(name)).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
    let file = `${base}${ext}`;
    for (let n = 2; fs.existsSync(path.join(folder, file)); n++) file = `${base}-${n}${ext}`;
    await fs.promises.writeFile(path.join(folder, file), bytes);
    return `${id}/${file}`;
  }

  /** Calls onChange when the notes' files change (a watch, and a look every 2 s where file events don't come). */
  watch(onChange: () => void): { dispose(): void } {
    let timer: NodeJS.Timeout | undefined;
    const fire = () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 150);
    };
    let watcher: fs.FSWatcher | undefined;
    const watchDir = () => {
      try {
        watcher ??= fs.watch(this.dir, (_e, name) => {
          if (!name?.endsWith('.tmp')) fire();
        });
      } catch {
        // no notes yet: the look notices the folder
      }
    };
    watchDir();
    let last = this.signature();
    const poll = setInterval(() => {
      const now = this.signature();
      if (now === last) return;
      last = now;
      watchDir();
      fire();
    }, 2000);
    return {
      dispose: () => {
        clearTimeout(timer);
        clearInterval(poll);
        watcher?.close();
      },
    };
  }

  private signature(): string {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((n) => !n.endsWith('.tmp'))
        .map((n) => {
          const s = fs.statSync(path.join(this.dir, n), { throwIfNoEntry: false });
          return `${n}:${s?.mtimeMs}:${s?.size}`;
        })
        .join('|');
    } catch {
      return '';
    }
  }

  private stateFile(id: string): string {
    this.file(id); // validates the id
    return path.join(this.dir, `${id}.json`);
  }
}

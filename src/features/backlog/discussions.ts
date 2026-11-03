/**
 * Discussions (BL-267): an idea talked through with an agent, with no ticket expected. Each is kept in the backlog
 * folder, discussions/DISC-n.md: its title, when it was started and last talked in, and its Claude Code session; the
 * chat itself is read back from that session's transcript (as a ticket's Discuss is, BL-241).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ASK_ALLOWED,
  ASK_DENIED,
} from './ask';
import {
  GUIDE,
  INBOX,
} from './inbox';
import { writeAtomic } from './localBacklog';
import { TICKET_SHAPE } from './notes';

/** Their folder in the backlog's. */
export const DISCUSSIONS = 'discussions';

/** A discussion's id: DISC-1, DISC-2… */
export const isDiscussionId = (id: string): boolean => /^DISC-[1-9]\d*$/.test(id);

/** What a discussion's agent may run: reads, and git's read-only commands (the Ask pane's, BL-80). */
export const DISCUSSION_ALLOWED = ASK_ALLOWED;
export const DISCUSSION_DENIED = ASK_DENIED;

/** The title of a discussion nobody wrote in yet. */
export const UNTITLED = 'New discussion';

export interface Discussion {
  id: string;
  title: string;
  /** ISO 8601. */
  created: string;
  /** When its last message was sent (ISO 8601); none until its first. */
  talked?: string;
  session: string;
  /** Renamed by hand: its first message doesn't title it. */
  renamed?: boolean;
  /** The tickets proposed from it (BL-268), oldest first. */
  became?: string[];
}

/** The title a first message gives: its first line, cut short. */
export function discussionTitle(text: string): string {
  const line = text.trim().split('\n')[0].replace(/\s+/g, ' ').trim();
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line || UNTITLED;
}

/** The next free id, after the highest of the folder's files. */
export function nextDiscussionId(names: readonly string[]): string {
  const n = Math.max(
    0,
    ...names
      .map((f) => /^DISC-(\d+)\.md$/.exec(f)?.[1])
      .filter(Boolean)
      .map(Number),
  );
  return `DISC-${n + 1}`;
}

/** A discussion's file: its title, then its facts as a list. */
export function formatDiscussion(d: Omit<Discussion, 'id'>): string {
  return [
    `# ${d.title}`,
    '',
    `- Created: ${d.created}`,
    ...(d.talked ? [`- Talked: ${d.talked}`] : []),
    `- Session: ${d.session}`,
    ...(d.renamed ? ['- Renamed: yes'] : []),
    ...(d.became?.length ? [`- Became: ${d.became.join(', ')}`] : []),
    '',
  ].join('\n');
}

export function parseDiscussion(id: string, text: string): Discussion | undefined {
  const title = /^#\s+(.+)$/m.exec(text)?.[1].trim();
  const fact = (name: string) => new RegExp(`^- ${name}: (.+)$`, 'm').exec(text)?.[1].trim();
  const created = fact('Created');
  const session = fact('Session');
  if (!title || !created || !session) return undefined;
  const talked = fact('Talked');
  const became = (fact('Became') ?? '').split(/[\s,]+/).filter(Boolean);
  return {
    id,
    title,
    created,
    session,
    ...(talked ? { talked } : {}),
    ...(fact('Renamed') ? { renamed: true } : {}),
    ...(became.length ? { became } : {}),
  };
}

/** The agent's instructions (its system prompt's addition, not shown): a free discussion, read-only, no tickets. */
export function freeDiscussionPrompt(o: { backlogDir: string }): string {
  return [
    `You're talking an idea through with this repository's owner, in a chat in Flotilla's backlog: a free discussion about this repository and its backlog.`,
    `Read the code, and the backlog in ${o.backlogDir} (backlog.json lists the tickets; <id>.md is each ticket), where it helps you answer. Say what the code does today, with links like [src/a.ts:42](src/a.ts#L42); lay out the options and their trade-offs; ask what you need to know; say what you'd do and why.`,
    `This is a discussion, not a planning session: don't propose tickets, don't steer toward them, and don't write any. You change nothing: no files, no branches, no commands that change anything. If the owner asks for tickets, say that Propose Tickets, at the top of this tab, has you propose them from the discussion.`,
    `Answer as in any chat: short, plain, to the point.`,
  ].join('\n\n');
}

/** What Propose Tickets sends (BL-268): shown in the chat as the owner's message. */
export const PROPOSE_TICKETS = 'Propose tickets from what we agreed on.';

/**
 * Whether a message asks for tickets ("make tickets of this", "can you propose a ticket for that?"): that turn, the
 * agent may propose them, as Propose Tickets has it. One that says not to ("no tickets yet", "don't make a ticket") doesn't.
 */
export function asksForTickets(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(no|not|don'?t|do not|never|without|nor)\b[^.?!\n]{0,30}\btickets?\b/.test(t)) return false;
  return (
    /\b(make|propose|write|create|turn|draft|file|add|open)\b[^.?!\n]{0,40}\btickets?\b/.test(t) ||
    /\btickets?\s+(of|from|for)\s+(this|that|it|these)\b/.test(t)
  );
}

/** What a discussion's agent may do on the turn it proposes tickets (BL-268): read, and write into the inbox only. */
export function proposeTools(backlogDir: string): string[] {
  const dir = backlogDir.replace(/\\/g, '/').replace(/^\/+/, '');
  return ['Read', 'Grep', 'Glob', `Edit(//${dir}/${INBOX}/**)`];
}

/** Offered besides proposeTools: Write, allowed only where its Edit rule says (a new file in the inbox). */
export const PROPOSE_OFFER = ['Write'] as const;

/** The agent's instructions on the turn it proposes tickets (BL-268): the note agents' ticket shape, through the inbox. */
export function proposeDiscussionPrompt(o: { id: string; agent: string; backlogDir: string }): string {
  const inbox = path.join(o.backlogDir, INBOX);
  return [
    `You're agent ${o.agent}, in a discussion (${o.id}) with this repository's owner, in a chat in Flotilla's backlog. Until now it was a free discussion; now the owner asks you to turn what you agreed on into ticket proposals. Propose only what the discussion settled on, as the owner would want it done: nothing it left open, and nothing new of your own.`,
    `Before you propose anything, read the backlog (${path.join(o.backlogDir, 'backlog.json')}: the items in priority order, with id, title, status, parent; each item's ticket is <id>.md next to it) and the code this is about. Don't propose what a ticket already covers. You can't change existing tickets: when part of it belongs in one, say so in your reply (which ticket, and what to add), or propose a follow-up with "Depends on: <its id>" when it builds on one being worked on or done.`,
    `Propose tickets through the inbox, as ${path.join(o.backlogDir, GUIDE)} explains: a Markdown file per ticket in ${inbox}/ (any name ending in .md, written with Write), with this front matter: \`discussion: ${o.id}\` (so the ticket links back to the discussion and it records what it became), \`agent: ${o.agent}\`, and \`parent:\` when it's part of an existing ticket or of an epic you propose (propose the epic first, read its id from <name>.added, then its children). One ticket per piece of work someone can do and review on its own.`,
    TICKET_SHAPE,
    `Write nothing else: no code, no other file, no branch, no commands. When the discussion didn't settle what to do, propose nothing, and ask in your reply what you need to know.`,
    `Then reply in the chat, short: the tickets you proposed (their ids, from <name>.added, and titles), and what you'd add to existing tickets, if anything.`,
  ].join('\n\n');
}

/** The ids of an inbox file's "discussion:" field ("DISC-3", "DISC-3, DISC-4"). */
export function discussionIdsOf(field: string | undefined): string[] {
  return [...new Set((field ?? '').toUpperCase().match(/DISC-[1-9]\d*/g) ?? [])];
}

/** The line a proposal from a discussion ends its description with: "From [DISC-3](discussions/DISC-3.md)." */
export function fromDiscussionsLine(ids: readonly string[]): string {
  return `From ${ids.map((id) => `[${id}](${DISCUSSIONS}/${id}.md)`).join(', ')}.`;
}

/** The discussions' files, in .flotilla/backlog/discussions/. Any window adds, renames and deletes them. */
export class DiscussionStore {
  readonly dir: string;

  constructor(readonly backlogDir: string) {
    this.dir = path.join(backlogDir, DISCUSSIONS);
  }

  file(id: string): string {
    if (!isDiscussionId(id)) throw new Error(`Not a discussion: '${id}'.`);
    return path.join(this.dir, `${id}.md`);
  }

  /** A new discussion, its session chosen: takes the next free id by creating its file (two windows can't take the same). */
  async create(now = new Date()): Promise<Discussion> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const d = { title: UNTITLED, created: now.toISOString(), session: crypto.randomUUID() };
    for (let attempt = 0; ; attempt++) {
      const id = nextDiscussionId(await fs.promises.readdir(this.dir));
      try {
        await fs.promises.writeFile(this.file(id), formatDiscussion(d), { flag: 'wx' });
        return { id, ...d };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt === 49) throw e;
      }
    }
  }

  async read(id: string): Promise<Discussion | undefined> {
    try {
      return parseDiscussion(id, await fs.promises.readFile(this.file(id), 'utf8'));
    } catch {
      return undefined;
    }
  }

  /** The discussions talked in, newest (last talked in) first. */
  async list(): Promise<Discussion[]> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return [];
    }
    const all = await Promise.all(
      names
        .map((f) => /^(DISC-\d+)\.md$/.exec(f)?.[1])
        .filter((id): id is string => !!id && isDiscussionId(id))
        .map((id) => this.read(id)),
    );
    return all.filter((d): d is Discussion & { talked: string } => !!d?.talked).sort((a, b) => b.talked.localeCompare(a.talked));
  }

  /** A message was sent: it was talked in now, and its first one titles it (unless it was renamed). */
  async talked(id: string, text: string, now = new Date()): Promise<Discussion | undefined> {
    const d = await this.read(id);
    if (!d) return undefined;
    const next = { ...d, talked: now.toISOString(), ...(!d.talked && !d.renamed ? { title: discussionTitle(text) } : {}) };
    await writeAtomic(this.file(id), formatDiscussion(next));
    return next;
  }

  async rename(id: string, title: string): Promise<void> {
    const d = await this.read(id);
    const t = title.replace(/\s+/g, ' ').trim();
    if (!d || !t) return;
    await writeAtomic(this.file(id), formatDiscussion({ ...d, title: t, renamed: true }));
  }

  /** A ticket was proposed from these discussions (the inbox's discussion: field): each records it. */
  async recordBecame(ids: readonly string[], ticket: string): Promise<void> {
    for (const id of ids) {
      if (!isDiscussionId(id)) continue;
      const d = await this.read(id);
      if (!d || d.became?.includes(ticket)) continue;
      await writeAtomic(this.file(id), formatDiscussion({ ...d, became: [...(d.became ?? []), ticket] }));
    }
  }

  /** Deletes its file (its session's transcript stays where Claude Code keeps it). */
  async delete(id: string): Promise<void> {
    await fs.promises.rm(this.file(id), { force: true });
  }
}

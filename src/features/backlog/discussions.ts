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
import { writeAtomic } from './localBacklog';

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
  return { id, title, created, session, ...(talked ? { talked } : {}), ...(fact('Renamed') ? { renamed: true } : {}) };
}

/** The agent's instructions (its system prompt's addition, not shown): a free discussion, read-only, no tickets. */
export function freeDiscussionPrompt(o: { backlogDir: string }): string {
  return [
    `You're talking an idea through with this repository's owner, in a chat in Flotilla's backlog: a free discussion about this repository and its backlog.`,
    `Read the code, and the backlog in ${o.backlogDir} (backlog.json lists the tickets; <id>.md is each ticket), where it helps you answer. Say what the code does today, with links like [src/a.ts:42](src/a.ts#L42); lay out the options and their trade-offs; ask what you need to know; say what you'd do and why.`,
    `This is a discussion, not a planning session: don't propose tickets, don't steer toward them, and don't write any. You change nothing: no files, no branches, no commands that change anything. If the owner asks for a ticket, say they can write a note or add one in the backlog.`,
    `Answer as in any chat: short, plain, to the point.`,
  ].join('\n\n');
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

  /** Deletes its file (its session's transcript stays where Claude Code keeps it). */
  async delete(id: string): Promise<void> {
    await fs.promises.rm(this.file(id), { force: true });
  }
}

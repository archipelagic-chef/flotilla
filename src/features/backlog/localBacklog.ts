import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureExcludeLine } from '../../core/git/exclude';
import { recordEvent, recordEventOf } from '../metrics/events';
import { criteriaCount } from '../metrics/productivity';
import { EMPTY_BACKLOG, entryAgent, ID_PATTERN, isBacklogData, type BacklogData, type BacklogItem } from './backlog';
import { describeChanges, descriptionHash, lineDelta } from './changes';
import { entryDate, formatTicket, parseTicket, type Ticket, type TicketEntry } from './ticket';

/** The local backlog's folder, in the main worktree; git ignores it (info/exclude), like .worktrees/. */
export const BACKLOG_DIR = path.join('.flotilla', 'backlog');
const EXCLUDE_LINE = '/.flotilla/';
/** The lock file that keeps writes of the folder apart in every process; one older than this was left by a crash. */
const LOCK_FILE = 'backlog.lock';
const LOCK_STALE_MS = 30_000;

/** How long a rename over a file another program holds open is retried before the file is written in place. */
const RENAME_RETRY_MS = 1000;

/** Errors Windows gives while another program (Explorer's preview, an indexer, a virus scanner) holds the file open. */
const HELD_OPEN = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** How long an empty ticket file is read again before it's taken as empty (see readTicketText). */
const BLANK_READ_MS = 1000;

/**
 * Writes a file as a whole: a temporary file next to it, renamed over it, so a reader never sees half of it. On Windows
 * the rename fails while another program holds the file open (COM Surrogate previewing it, for one): it's retried for a
 * moment, then the file is written in place, so the write isn't lost. The temporary file never stays behind.
 */
export async function writeAtomic(file: string, text: string, opts: { retryMs?: number; rename?: (from: string, to: string) => Promise<void> } = {}): Promise<void> {
  const rename = opts.rename ?? fs.promises.rename;
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(tmp, text);
  const deadline = Date.now() + (opts.retryMs ?? RENAME_RETRY_MS);
  let wait = 20;
  try {
    for (;;) {
      try {
        await rename(tmp, file);
        return;
      } catch (error) {
        if (!HELD_OPEN.has((error as NodeJS.ErrnoException).code ?? '') || !fs.existsSync(file)) throw error;
        if (Date.now() + wait > deadline) break;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 200);
      }
    }
    await fs.promises.writeFile(file, text);
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/**
 * The local backlog, in the main worktree's .flotilla/backlog/: backlog.json holds the items' order, status and
 * ids; each item has a ticket (<id>.md, see ticket.ts) with its description and activity, and its images in <id>/.
 * People edit tickets in Flotilla's ticket editor, agents edit the file. Every worktree and window of the repository shares it.
 * Every write of the folder's files that is read-modify-write (backlog.json, ticket activity, posted.json) runs one at a
 * time: in this window through a queue, and across windows and processes through the lock file LOCK_FILE. Files are
 * written atomically; other windows notice through a file watch.
 */
export class LocalBacklog {
  /** The writes queued in this window, each after the one before. */
  private queue: Promise<unknown> = Promise.resolve();

  readonly dir: string;
  readonly file: string;

  constructor(
    mainRoot: string,
    private readonly commonDir: string,
  ) {
    this.dir = path.join(mainRoot, BACKLOG_DIR);
    this.file = path.join(this.dir, 'backlog.json');
  }

  docPath(id: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error(`Invalid backlog item id '${id}'.`);
    return path.join(this.dir, `${id}.md`);
  }

  async read(): Promise<BacklogData> {
    // Once more after a moment when it doesn't parse: a write in place (see writeAtomic) can be read half done.
    for (let attempt = 0; ; attempt++) {
      let text: string;
      try {
        text = await fs.promises.readFile(this.file, 'utf8');
      } catch {
        return EMPTY_BACKLOG;
      }
      try {
        const data: unknown = JSON.parse(text);
        return isBacklogData(data) ? data : EMPTY_BACKLOG;
      } catch {
        if (attempt > 0) return EMPTY_BACKLOG;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  async ensureDir(): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    await ensureExcludeLine(this.commonDir, EXCLUDE_LINE).catch(() => false);
  }

  /** Runs fn after the writes queued before it, here and in other processes (holding the lock file). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => this.withLockFile(fn));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async withLockFile<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureDir();
    const lock = path.join(this.dir, LOCK_FILE);
    for (;;) {
      try {
        await fs.promises.writeFile(lock, `${process.pid}\n`, { flag: 'wx' });
        break;
      } catch (error) {
        // Windows says EPERM while a lock just released is still being deleted: it's taken, like EEXIST.
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (code !== 'EEXIST' && !HELD_OPEN.has(code)) throw error;
        const stat = await fs.promises.stat(lock).catch(() => undefined);
        if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) await fs.promises.rm(lock, { force: true });
        else await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 30));
      }
    }
    try {
      return await fn();
    } finally {
      await fs.promises.rm(lock, { force: true });
    }
  }

  /**
   * Applies change to the current contents and saves the result. What changed about each item (its status, priority…)
   * is noted in its ticket's activity, as done by `by`: "You" (the default: changes from the views), an agent ("Agent
   * Nova-7"), or "Flotilla". change may be async (it runs with the lock held: it must not call change itself).
   */
  async change(change: (data: BacklogData) => BacklogData | Promise<BacklogData>, opts: { by?: string } = {}): Promise<BacklogData> {
    const { before, next } = await this.exclusive(async () => {
      const before = await this.read();
      const next = await change(before);
      await writeAtomic(this.file, `${JSON.stringify(next, null, 1)}\n`);
      return { before, next };
    });
    const was = new Map(before.items.map((i) => [i.id, i]));
    for (const item of next.items) {
      const old = was.get(item.id);
      const lines = old ? describeChanges(old, item, opts.by ?? 'You') : [];
      if (old && old.status !== item.status) {
        const data = { from: old.status, to: item.status, by: opts.by ?? 'You' };
        // Done: with its acceptance criteria then, what it delivered (BL-189).
        if (item.status === 'done')
          recordEventOf('ticket-moved', {
            ticket: item.id,
            agent: entryAgent(opts.by ?? ''),
            data: this.readTicket(item).then(
              (t) => ({ ...data, criteria: criteriaCount(t.description) }),
              () => data,
            ),
          });
        else recordEvent('ticket-moved', { ticket: item.id, agent: entryAgent(opts.by ?? ''), data });
      }
      if (old && old.review?.state !== item.review?.state) {
        recordEvent('review-state', { ticket: item.id, data: { ...(old.review?.state ? { from: old.review.state } : {}), ...(item.review?.state ? { to: item.review.state } : {}) } });
      }
      if (lines.length) await this.appendActivity(item, { date: entryDate(new Date()), author: 'Flotilla', body: lines.join('\n\n') });
    }
    return next;
  }

  /** The ids that have a ticket file or folder, listed in backlog.json or not: a new item doesn't get one of these. */
  async ticketIds(): Promise<string[]> {
    const names = await fs.promises.readdir(this.dir).catch(() => [] as string[]);
    return names.map((n) => n.replace(/\.md$/, '')).filter((n) => ID_PATTERN.test(n));
  }

  /** The descriptions last seen, for how much an edit changed (this session only). */
  private readonly descriptions = new Map<string, string>();

  /**
   * Notes changed descriptions in their tickets' activity: an edit by `by` (with what it was before, when known), or,
   * without, any made in the ticket files since last seen (by an agent, or in an editor). Descriptions not seen before
   * are only remembered.
   */
  noteDescriptions(edit?: { id: string; before: string; by: string }): Promise<void> {
    // One at a time: an edit noted here isn't noted again by the scan its write sets off.
    const run = this.describing.then(() => this.describe(edit));
    this.describing = run.catch(() => undefined);
    return run;
  }

  private describing: Promise<unknown> = Promise.resolve();

  private async describe(edit?: { id: string; before: string; by: string }): Promise<void> {
    const data = await this.read();
    const changed: Array<{ item: BacklogItem; hash: string; body?: string }> = [];
    for (const item of data.items.filter((i) => !edit || i.id === edit.id)) {
      const description = (await this.readTicket(item)).description;
      const hash = descriptionHash(description);
      const before = edit?.before ?? this.descriptions.get(item.id);
      this.descriptions.set(item.id, description);
      if (item.descriptionHash === hash) continue;
      let body: string | undefined;
      if (item.descriptionHash !== undefined || edit) {
        const delta = before === undefined ? undefined : lineDelta(before, description);
        const size = delta && (delta.added || delta.removed) ? ` (+${delta.added} −${delta.removed} lines)` : '';
        body = edit
          ? `${edit.by === 'You' ? 'You' : edit.by} edited the description${size}.`
          : `The description was edited in its file${size}: by an agent, or in an editor.`;
        if (!description.trim() && before?.trim()) body += `\n\n${await this.keepDescription(item.id, before)}`;
      }
      changed.push({ item, hash, body });
    }
    if (!changed.length) return;
    const hashes = new Map(changed.map((c) => [c.item.id, c.hash]));
    await this.change((d) => ({ ...d, items: d.items.map((i) => (hashes.has(i.id) ? { ...i, descriptionHash: hashes.get(i.id) } : i)) }));
    for (const c of changed) if (c.body) await this.appendActivity(c.item, { date: entryDate(new Date()), author: 'Flotilla', body: c.body });
  }

  /**
   * Keeps a description that an edit removed entirely in the ticket's folder (<id>/description-<time>.md), and returns
   * the activity's note of it, with a link to it to restore it from.
   */
  private async keepDescription(id: string, description: string): Promise<string> {
    const p = (n: number) => String(n).padStart(2, '0');
    const now = new Date();
    const name = `description-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.md`;
    const folder = path.join(this.dir, id);
    await fs.promises.mkdir(folder, { recursive: true });
    await writeAtomic(path.join(folder, name), `${description.trim()}\n`);
    return `**The description is now empty.** The one before is kept in [${id}/${name}](${id}/${name}): copy it back into the ticket to restore it.`;
  }

  /** Adds an entry at the end of an item's ticket activity; entries written together all stay. */
  appendActivity(item: Pick<BacklogItem, 'id' | 'title' | 'notes'>, entry: TicketEntry): Promise<void> {
    return this.editTicket(item, (ticket) => ({ ...ticket, activity: [...ticket.activity, entry] }));
  }

  /** Changes an item's ticket as it is when written: read and written back under the lock, so nothing written meanwhile is lost. */
  editTicket(item: Pick<BacklogItem, 'id' | 'title' | 'notes'>, change: (ticket: Ticket) => Ticket): Promise<void> {
    return this.exclusive(async () => {
      await this.writeTicketFile(item.id, change(await this.readTicket(item)));
    });
  }

  /** An item's ticket; one without a file yet has its title (and any old notes) and no activity. */
  async readTicket(item: Pick<BacklogItem, 'id' | 'title' | 'notes'>): Promise<Ticket> {
    const text = await this.readTicketText(item.id);
    return text === undefined ? { title: item.title, description: item.notes ?? '', activity: [] } : parseTicket(text, item.title);
  }

  /**
   * A ticket file's text, or undefined when it has none. An agent's editor writes the file in place: read at that
   * moment it's empty (or, being replaced, briefly gone), and a ticket written back from that read loses its
   * description and activity (BL-147). So an empty or missing file is read again for a moment before it's believed.
   */
  private async readTicketText(id: string): Promise<string | undefined> {
    const file = this.docPath(id);
    const deadline = Date.now() + BLANK_READ_MS;
    let missing = 0;
    for (;;) {
      let text: string | undefined;
      try {
        text = await fs.promises.readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // A ticket that has no file yet is common: only once more.
          if (++missing > 1) return undefined;
        } else if (!HELD_OPEN.has((error as NodeJS.ErrnoException).code ?? '')) {
          throw error;
        }
      }
      if (text !== undefined && (text.trim() !== '' || Date.now() >= deadline)) return text;
      if (text === undefined && Date.now() >= deadline) throw new Error(`The ticket ${id} can't be read.`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Writes an item's whole ticket file (not while another write of the backlog is in progress: that waits its turn). */
  writeTicket(id: string, ticket: Ticket): Promise<void> {
    return this.exclusive(() => this.writeTicketFile(id, ticket));
  }

  /** Parsed tickets by id, with the file's time and size they were read at (see readTicketCached). */
  private readonly tickets = new Map<string, { stamp: string; title: string; ticket: Ticket }>();

  /**
   * An item's ticket, as readTicket reads it, but parsed again only when its file changed (its time and size): for the
   * views that show every ticket's summary and counts, which run on each change.
   */
  async readTicketCached(item: Pick<BacklogItem, 'id' | 'title' | 'notes'>): Promise<Ticket> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(this.docPath(item.id));
    } catch {
      return this.readTicket(item);
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const known = this.tickets.get(item.id);
    if (known && known.stamp === stamp && known.title === item.title) return known.ticket;
    const ticket = await this.readTicket(item);
    this.tickets.set(item.id, { stamp, title: item.title, ticket });
    return ticket;
  }

  private async writeTicketFile(id: string, ticket: Ticket): Promise<void> {
    await writeAtomic(this.docPath(id), formatTicket(ticket));
    // Its parsed copy (readTicketCached) is read again next time.
    this.tickets.delete(id);
  }

  /** Writes an item's ticket file if it has none yet; returns its path. The check and the write wait their turn together. */
  async ensureDocument(item: BacklogItem): Promise<string> {
    const file = this.docPath(item.id);
    await this.exclusive(async () => {
      if (!fs.existsSync(file)) await this.writeTicketFile(item.id, await this.readTicket(item));
    });
    return file;
  }

  /** Saves an image for a ticket in its folder (<id>/); returns its path relative to the tickets, for Markdown. */
  async saveImage(id: string, name: string, bytes: Uint8Array): Promise<string> {
    this.docPath(id); // validates the id
    const folder = path.join(this.dir, id);
    await this.ensureDir();
    await fs.promises.mkdir(folder, { recursive: true });
    const ext = (path.extname(name).toLowerCase().match(/^\.(png|jpe?g|gif|webp|svg|mp4|webm)$/) ?? ['.png'])[0];
    const base = path.basename(name, path.extname(name)).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
    let file = `${base}${ext}`;
    for (let n = 2; fs.existsSync(path.join(folder, file)); n++) file = `${base}-${n}${ext}`;
    await fs.promises.writeFile(path.join(folder, file), bytes);
    return `${id}/${file}`;
  }

  /** Identifies an activity entry of a ticket (it has no id of its own) to remember that it was posted. */
  static entryKey(id: string, e: TicketEntry): string {
    return crypto.createHash('sha1').update(`${id}\n${e.date}\n${e.author}\n${e.body.trim()}`).digest('hex').slice(0, 16);
  }

  private get postedFile(): string {
    return path.join(this.dir, 'posted.json');
  }

  /** Which activity entries were posted to which issue (by entry key). */
  async posted(): Promise<Record<string, string>> {
    try {
      const data: unknown = JSON.parse(await fs.promises.readFile(this.postedFile, 'utf8'));
      return typeof data === 'object' && data !== null ? (data as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  markPosted(key: string, issue: string): Promise<void> {
    return this.exclusive(async () => {
      const posted = { ...(await this.posted()), [key]: issue };
      await writeAtomic(this.postedFile, `${JSON.stringify(posted, null, 1)}\n`);
    });
  }

  async deleteDocument(id: string): Promise<void> {
    await fs.promises.rm(this.docPath(id), { force: true });
    await fs.promises.rm(path.join(this.dir, id), { recursive: true, force: true });
  }

  /** Takes titles from the tickets' headings (an edited ticket renames its item); true if any changed. */
  async syncTitles(): Promise<boolean> {
    const data = await this.read();
    const titles = new Map<string, string>();
    for (const item of data.items) {
      try {
        const { title } = await this.readTicketCached(item);
        if (title && title !== item.title) titles.set(item.id, title);
      } catch {
        // no ticket file (yet)
      }
    }
    if (!titles.size) return false;
    await this.change((d) => ({ ...d, items: d.items.map((i) => (titles.has(i.id) ? { ...i, title: titles.get(i.id)! } : i)) }));
    return true;
  }

  /** The backlog folder's files, each with its change time and size: a cheap way to notice changes when file events don't come. */
  private signatures(): Map<string, string> {
    const out = new Map<string, string>();
    try {
      for (const n of fs.readdirSync(this.dir)) {
        if (!n.endsWith('.md') && !n.endsWith('.json')) continue;
        const stat = fs.statSync(path.join(this.dir, n), { throwIfNoEntry: false });
        out.set(n, `${stat?.mtimeMs ?? 0}:${stat?.size ?? 0}`);
      }
    } catch {
      // no folder yet
    }
    return out;
  }

  /**
   * Calls onChange with the names of the files that changed (backlog.json, <id>.md…), once they've settled (150 ms). A
   * change that doesn't say which file (an event without a name) comes as '*'. File events don't arrive in every setup
   * (some container and network mounts), so it also compares the folder every 2 s.
   */
  watch(onChange: (changed: ReadonlySet<string>) => void): { dispose(): void } {
    let timer: NodeJS.Timeout | undefined;
    let pending = new Set<string>();
    const fire = (names: Iterable<string>) => {
      for (const n of names) pending.add(n);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const changed = pending;
        pending = new Set();
        onChange(changed);
      }, 150);
    };
    let watcher: fs.FSWatcher | undefined;
    const watchDir = () => {
      try {
        watcher ??= fs.watch(this.dir, (_event, name) => {
          if (name?.endsWith('.tmp') || name === LOCK_FILE) return;
          fire([name ?? '*']);
        });
        void ensureExcludeLine(this.commonDir, EXCLUDE_LINE).catch(() => false);
      } catch {
        // the folder doesn't exist yet: polling notices it
      }
    };
    watchDir();
    let last = this.signatures();
    const poll = setInterval(() => {
      const now = this.signatures();
      const changed = [...new Set([...now.keys(), ...last.keys()])].filter((n) => now.get(n) !== last.get(n));
      last = now;
      if (!changed.length) return;
      watchDir();
      fire(changed);
    }, 2000);
    return {
      dispose: () => {
        clearTimeout(timer);
        clearInterval(poll);
        watcher?.close();
      },
    };
  }
}

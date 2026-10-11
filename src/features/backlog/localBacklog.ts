import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureExcludeLine } from '../../core/git/exclude';
import { EMPTY_BACKLOG, isBacklogData, type BacklogData, type BacklogItem } from './backlog';
import { formatTicket, parseTicket, type Ticket, type TicketEntry } from './ticket';

/** The local backlog's folder, in the main worktree; git ignores it (info/exclude), like .worktrees/. */
export const BACKLOG_DIR = path.join('.flotilla', 'backlog');
const EXCLUDE_LINE = '/.flotilla/';

/**
 * The local backlog, in the main worktree's .flotilla/backlog/: backlog.json holds the items' order, status and
 * ids; each item has a ticket (<id>.md, see ticket.ts) with its description and activity, and its images in <id>/.
 * People edit tickets in Flotilla's ticket editor, agents edit the file. Every worktree and window of the repository shares it. Changes to backlog.json are read-modify-write of
 * the whole file, written atomically; other windows notice through a file watch.
 */
export class LocalBacklog {
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
    try {
      const data: unknown = JSON.parse(await fs.promises.readFile(this.file, 'utf8'));
      return isBacklogData(data) ? data : EMPTY_BACKLOG;
    } catch {
      return EMPTY_BACKLOG;
    }
  }

  async ensureDir(): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    await ensureExcludeLine(this.commonDir, EXCLUDE_LINE).catch(() => false);
  }

  /** Applies change to the current contents and saves the result. */
  async change(change: (data: BacklogData) => BacklogData): Promise<BacklogData> {
    const next = change(await this.read());
    await this.ensureDir();
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, `${JSON.stringify(next, null, 1)}\n`);
    await fs.promises.rename(tmp, this.file);
    return next;
  }

  /** An item's ticket; one without a file yet has its title (and any old notes) and no activity. */
  async readTicket(item: Pick<BacklogItem, 'id' | 'title' | 'notes'>): Promise<Ticket> {
    try {
      return parseTicket(await fs.promises.readFile(this.docPath(item.id), 'utf8'), item.title);
    } catch {
      return { title: item.title, description: item.notes ?? '', activity: [] };
    }
  }

  async writeTicket(id: string, ticket: Ticket): Promise<void> {
    await this.ensureDir();
    const file = this.docPath(id);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, formatTicket(ticket));
    await fs.promises.rename(tmp, file);
  }

  /** Writes an item's ticket file if it has none yet; returns its path. */
  async ensureDocument(item: BacklogItem): Promise<string> {
    const file = this.docPath(item.id);
    if (!fs.existsSync(file)) await this.writeTicket(item.id, await this.readTicket(item));
    return file;
  }

  /** Saves an image for a ticket in its folder (<id>/); returns its path relative to the tickets, for Markdown. */
  async saveImage(id: string, name: string, bytes: Uint8Array): Promise<string> {
    this.docPath(id); // validates the id
    const folder = path.join(this.dir, id);
    await this.ensureDir();
    await fs.promises.mkdir(folder, { recursive: true });
    const ext = (path.extname(name).toLowerCase().match(/^\.(png|jpe?g|gif|webp|svg)$/) ?? ['.png'])[0];
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

  async markPosted(key: string, issue: string): Promise<void> {
    const posted = { ...(await this.posted()), [key]: issue };
    await this.ensureDir();
    await fs.promises.writeFile(this.postedFile, `${JSON.stringify(posted, null, 1)}\n`);
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
        const { title } = parseTicket(await fs.promises.readFile(this.docPath(item.id), 'utf8'));
        if (title && title !== item.title) titles.set(item.id, title);
      } catch {
        // no ticket file (yet)
      }
    }
    if (!titles.size) return false;
    await this.change((d) => ({ ...d, items: d.items.map((i) => (titles.has(i.id) ? { ...i, title: titles.get(i.id)! } : i)) }));
    return true;
  }

  /** The backlog folder's files and their change times: a cheap way to notice changes when file events don't come. */
  private signature(): string {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((n) => n.endsWith('.md') || n.endsWith('.json'))
        .sort()
        .map((n) => {
          const stat = fs.statSync(path.join(this.dir, n), { throwIfNoEntry: false });
          return `${n}:${stat?.mtimeMs ?? 0}:${stat?.size ?? 0}`;
        })
        .join('|');
    } catch {
      return '';
    }
  }

  /**
   * Calls onChange when backlog.json or a ticket changes (in this or another window, or by Claude). File events
   * don't arrive in every setup (some container and network mounts), so it also compares the folder every 2 s.
   */
  watch(onChange: () => void): { dispose(): void } {
    let timer: NodeJS.Timeout | undefined;
    const fire = () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 150);
    };
    let watcher: fs.FSWatcher | undefined;
    const watchDir = () => {
      try {
        watcher ??= fs.watch(this.dir, (_event, name) => {
          if (name && !name.endsWith('.tmp')) fire();
        });
        void ensureExcludeLine(this.commonDir, EXCLUDE_LINE).catch(() => false);
      } catch {
        // the folder doesn't exist yet: polling notices it
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
}

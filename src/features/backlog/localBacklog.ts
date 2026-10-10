import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureExcludeLine } from '../../core/git/exclude';
import { EMPTY_BACKLOG, isBacklogData, type BacklogData, type BacklogItem } from './backlog';
import { formatTicket, parseTicket, type Ticket } from './ticket';

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
  private watcher: fs.FSWatcher | undefined;

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

  /**
   * Calls onChange when backlog.json or a document changes (in this or another window, or by Claude). Until the
   * folder exists (no backlog yet) it polls for backlog.json instead of creating the folder.
   */
  watch(onChange: () => void): { dispose(): void } {
    let timer: NodeJS.Timeout | undefined;
    let disposed = false;
    const fire = () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 150);
    };
    const watchDir = () => {
      try {
        this.watcher = fs.watch(this.dir, (_event, name) => {
          if (name && !name.endsWith('.tmp')) fire();
        });
        return true;
      } catch {
        return false;
      }
    };
    const poll = () => {
      if (disposed || !fs.existsSync(this.dir)) return;
      fs.unwatchFile(this.file, poll);
      if (watchDir()) fire();
    };
    if (watchDir()) void ensureExcludeLine(this.commonDir, EXCLUDE_LINE).catch(() => false);
    else fs.watchFile(this.file, { interval: 2000 }, poll);
    return {
      dispose: () => {
        disposed = true;
        clearTimeout(timer);
        fs.unwatchFile(this.file, poll);
        this.watcher?.close();
      },
    };
  }
}

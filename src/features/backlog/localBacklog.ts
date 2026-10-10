import * as fs from 'node:fs';
import * as path from 'node:path';
import { EMPTY_BACKLOG, isBacklogData, type BacklogData } from './backlog';

/**
 * The local backlog: a JSON file in the repository's shared git dir (<common .git>/flotilla/backlog.json). It's
 * never committed, and every worktree and window of the repository sees the same one. Changes are read-modify-write
 * of the whole file, written atomically; other windows notice through a file watch.
 */
export class LocalBacklog {
  readonly file: string;
  private watcher: fs.FSWatcher | undefined;

  constructor(commonDir: string) {
    this.file = path.join(commonDir, 'flotilla', 'backlog.json');
  }

  async read(): Promise<BacklogData> {
    try {
      const data: unknown = JSON.parse(await fs.promises.readFile(this.file, 'utf8'));
      return isBacklogData(data) ? data : EMPTY_BACKLOG;
    } catch {
      return EMPTY_BACKLOG;
    }
  }

  /** Applies change to the current contents and saves the result. */
  async change(change: (data: BacklogData) => BacklogData): Promise<BacklogData> {
    const next = change(await this.read());
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, `${JSON.stringify(next, null, 1)}\n`);
    await fs.promises.rename(tmp, this.file);
    return next;
  }

  /** Calls onChange when the file changes (in this or another window). */
  watch(onChange: () => void): { dispose(): void } {
    const dir = path.dirname(this.file);
    let timer: NodeJS.Timeout | undefined;
    const fire = () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 100);
    };
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.watcher = fs.watch(dir, (_event, name) => name === path.basename(this.file) && fire());
    } catch {
      // no watching: the view still updates on its own changes
    }
    return {
      dispose: () => {
        clearTimeout(timer);
        this.watcher?.close();
      },
    };
  }
}

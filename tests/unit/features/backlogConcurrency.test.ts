import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildSync } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { addItem } from '../../../src/features/backlog/backlog';
import { takeInbox } from '../../../src/features/backlog/inbox';
import { LocalBacklog } from '../../../src/features/backlog/localBacklog';
import { initRepo, makeTempDir, removeDir } from '../../helpers/gitRepo';

const run = promisify(execFile);
const cleanup: string[] = [];
let workerDir: string;
let worker: string;

beforeAll(() => {
  // The worker runs in its own process, so it's bundled like the extension is.
  workerDir = makeTempDir('flotilla-worker-');
  worker = path.join(workerDir, 'backlogWorker.js');
  buildSync({
    entryPoints: [fileURLToPath(new URL('../../helpers/backlogWorker.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: worker,
    logLevel: 'silent',
  });
});

afterEach(() => cleanup.splice(0).forEach(removeDir));
afterAll(() => removeDir(workerDir));

function newRepo(): string {
  const repo = initRepo();
  cleanup.push(repo);
  return repo;
}

/** Ids of the items, asserting that none is listed twice. */
function ids(items: { id: string }[]): string[] {
  const all = items.map((i) => i.id);
  expect(new Set(all).size).toBe(all.length);
  return all;
}

describe('backlog writes at once', () => {
  it('changes from many windows of one process all land, each with its own id', async () => {
    const repo = newRepo();
    const windows = Array.from({ length: 10 }, () => new LocalBacklog(repo, path.join(repo, '.git')));
    await Promise.all(windows.flatMap((store, w) => Array.from({ length: 5 }, (_, i) => store.change((d) => addItem(d, `w${w} ${i}`, 'BL', new Date()).data))));
    const data = await new LocalBacklog(repo, path.join(repo, '.git')).read();
    expect(ids(data.items)).toHaveLength(50);
  });

  it('changes from two processes all land', async () => {
    const repo = newRepo();
    await Promise.all([run(process.execPath, [worker, repo, '25', 'a']), run(process.execPath, [worker, repo, '25', 'b'])]);
    const data = await new LocalBacklog(repo, path.join(repo, '.git')).read();
    expect(ids(data.items)).toHaveLength(50);
    expect(data.items.map((i) => i.title).sort()).toEqual(
      [...Array.from({ length: 25 }, (_, i) => `a ${i}`), ...Array.from({ length: 25 }, (_, i) => `b ${i}`)].sort(),
    );
  });

  it('ticket entries written at once all stay', async () => {
    const repo = newRepo();
    const store = new LocalBacklog(repo, path.join(repo, '.git'));
    const data = await store.change((d) => addItem(d, 'Busy', 'BL', new Date()).data);
    const item = data.items[0];
    const other = new LocalBacklog(repo, path.join(repo, '.git'));
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => [store, other][i % 2].appendActivity(item, { date: '2026-10-11 15:50', author: 'Test', body: `entry ${i}` })),
    );
    const ticket = await store.readTicket(item);
    expect(ticket.activity.map((e) => e.body).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `entry ${i}`).sort());
  });

  it('a ticket edit and entries written at once both stay', async () => {
    const repo = newRepo();
    const store = new LocalBacklog(repo, path.join(repo, '.git'));
    const data = await store.change((d) => addItem(d, 'Edited', 'BL', new Date()).data);
    const item = data.items[0];
    const other = new LocalBacklog(repo, path.join(repo, '.git'));
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => store.appendActivity(item, { date: '2026-10-11 15:50', author: 'Test', body: `entry ${i}` })),
      other.editTicket(item, (t) => ({ ...t, description: 'Edited in the view' })),
      ...Array.from({ length: 10 }, (_, i) => other.appendActivity(item, { date: '2026-10-11 15:51', author: 'Test', body: `late ${i}` })),
    ]);
    const ticket = await store.readTicket(item);
    expect(ticket.description).toBe('Edited in the view');
    expect(ticket.activity).toHaveLength(20);
  });

  it('takes over a lock file a crashed process left behind', async () => {
    const repo = newRepo();
    const store = new LocalBacklog(repo, path.join(repo, '.git'));
    await store.ensureDir();
    const lock = path.join(store.dir, 'backlog.lock');
    fs.writeFileSync(lock, '99999\n');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    await store.change((d) => addItem(d, 'After the crash', 'BL', new Date()).data);
    expect((await store.read()).items.map((i) => i.title)).toEqual(['After the crash']);
    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe('inbox at once', () => {
  it('gives concurrent inbox files distinct ids, each answered once', async () => {
    const repo = newRepo();
    const store = new LocalBacklog(repo, path.join(repo, '.git'));
    await store.change((d) => addItem(d, 'Base', 'BL', new Date()).data);
    const inbox = path.join(store.dir, 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    const old = new Date(Date.now() - 5000);
    for (let i = 0; i < 6; i++) {
      const file = path.join(inbox, `ticket-${i}.md`);
      fs.writeFileSync(file, `# Ticket ${i}\n\nWhat ${i}.\n`);
      fs.utimesSync(file, old, old);
    }
    // Two windows take the inbox at the same time.
    const other = new LocalBacklog(repo, path.join(repo, '.git'));
    const [a, b] = await Promise.all([
      takeInbox(store, { prefix: 'BL', mode: 'add', taken: [] }),
      takeInbox(other, { prefix: 'BL', mode: 'add', taken: [] }),
    ]);
    expect(a.length + b.length).toBe(6);
    const data = await store.read();
    expect(ids(data.items)).toHaveLength(7);
    const answers = Array.from({ length: 6 }, (_, i) => fs.readFileSync(path.join(inbox, `ticket-${i}.added`), 'utf8').trim());
    expect(new Set(answers).size).toBe(6);
    expect(answers.every((id) => data.items.some((i) => i.id === id))).toBe(true);
    expect(fs.readdirSync(inbox).filter((n) => n.endsWith('.taking') || n.endsWith('.md'))).toEqual([]);
  });

  it('skips the ids of ticket files whose item is missing from backlog.json', async () => {
    const repo = newRepo();
    const store = new LocalBacklog(repo, path.join(repo, '.git'));
    await store.change((d) => addItem(d, 'Base', 'BL', new Date()).data);
    // BL-2's ticket is still on disk, though backlog.json was rewritten without it.
    await store.writeTicket('BL-2', { title: 'Left behind', description: '', activity: [] });
    const inbox = path.join(store.dir, 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    const file = path.join(inbox, 'new.md');
    fs.writeFileSync(file, '# New one\n');
    const old = new Date(Date.now() - 5000);
    fs.utimesSync(file, old, old);
    const added = await takeInbox(store, { prefix: 'BL', mode: 'add', taken: [] });
    expect(added.map((i) => i.id)).toEqual(['BL-3']);
    expect(fs.readFileSync(path.join(inbox, 'new.added'), 'utf8')).toBe('BL-3\n');
  });
});

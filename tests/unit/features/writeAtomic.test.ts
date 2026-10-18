import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalBacklog, writeAtomic } from '../../../src/features/backlog/localBacklog';
import { makeTempDir, removeDir, writeFile } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

const heldOpen = () => Object.assign(new Error('operation not permitted'), { code: 'EPERM' });

describe('writeAtomic', () => {
  it('replaces the file through a rename, leaving nothing behind', async () => {
    const dir = makeTempDir();
    cleanup.push(dir);
    writeFile(dir, 'a.json', 'old');
    await writeAtomic(path.join(dir, 'a.json'), 'new');
    expect(fs.readFileSync(path.join(dir, 'a.json'), 'utf8')).toBe('new');
    expect(fs.readdirSync(dir)).toEqual(['a.json']);
  });

  it('retries while another program holds the file open', async () => {
    const dir = makeTempDir();
    cleanup.push(dir);
    writeFile(dir, 'a.json', 'old');
    let calls = 0;
    const rename = async (from: string, to: string) => {
      if (++calls < 3) throw heldOpen();
      await fs.promises.rename(from, to);
    };
    await writeAtomic(path.join(dir, 'a.json'), 'new', { rename });
    expect(calls).toBe(3);
    expect(fs.readFileSync(path.join(dir, 'a.json'), 'utf8')).toBe('new');
    expect(fs.readdirSync(dir)).toEqual(['a.json']);
  });

  it('writes in place when the file stays held open, so the write isn’t lost', async () => {
    const dir = makeTempDir();
    cleanup.push(dir);
    writeFile(dir, 'a.json', 'old');
    await writeAtomic(path.join(dir, 'a.json'), 'new', { retryMs: 50, rename: async () => Promise.reject(heldOpen()) });
    expect(fs.readFileSync(path.join(dir, 'a.json'), 'utf8')).toBe('new');
    expect(fs.readdirSync(dir)).toEqual(['a.json']);
  });

  it('fails on other errors, and still removes its temporary file', async () => {
    const dir = makeTempDir();
    cleanup.push(dir);
    writeFile(dir, 'a.json', 'old');
    const broken = async () => Promise.reject(Object.assign(new Error('no space'), { code: 'ENOSPC' }));
    await expect(writeAtomic(path.join(dir, 'a.json'), 'new', { rename: broken })).rejects.toThrow('no space');
    expect(fs.readdirSync(dir)).toEqual(['a.json']);
  });
});

describe('LocalBacklog.read', () => {
  it('reads again when it catches a write in place half done', async () => {
    const root = makeTempDir();
    cleanup.push(root);
    const backlog = new LocalBacklog(root, path.join(root, '.git'));
    const whole = JSON.stringify({ version: 1, next: 2, counters: { BL: 1 }, items: [{ id: 'BL-1', title: 'One', status: 'todo', priority: 'medium', created: '' }] });
    writeFile(root, '.flotilla/backlog/backlog.json', whole.slice(0, 20));
    setTimeout(() => fs.writeFileSync(backlog.file, whole), 10);
    expect((await backlog.read()).items.map((i) => i.id)).toEqual(['BL-1']);
  });
});

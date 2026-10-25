import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { withLock } from '../../../scripts/vscode-download.mjs';

describe('withLock', () => {
  let dir: string;
  let lockDir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-download-'));
    lockDir = path.join(dir, '.download.lock');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('runs one holder at a time, the second after the first', async () => {
    const order: string[] = [];
    const hold = (name: string) => async () => {
      order.push(`${name} in`);
      await new Promise((r) => setTimeout(r, 50));
      order.push(`${name} out`);
    };
    await Promise.all([withLock(lockDir, hold('a'), { pollMs: 10 }), withLock(lockDir, hold('b'), { pollMs: 10 })]);
    expect(order).toEqual(['a in', 'a out', 'b in', 'b out']);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('frees the lock when the holder fails', async () => {
    await expect(withLock(lockDir, () => Promise.reject(new Error('tar failed')))).rejects.toThrow('tar failed');
    expect(fs.existsSync(lockDir)).toBe(false);
    await expect(withLock(lockDir, () => 'next')).resolves.toBe('next');
  });

  it('says once that it waits', async () => {
    let waits = 0;
    const first = withLock(lockDir, () => new Promise((r) => setTimeout(r, 60)));
    await withLock(lockDir, () => undefined, { pollMs: 10, onWait: () => waits++ });
    await first;
    expect(waits).toBe(1);
  });

  it('takes over a lock left by a process that is gone', async () => {
    fs.mkdirSync(lockDir);
    // A pid no process has: above the kernel's limit.
    fs.writeFileSync(path.join(lockDir, 'pid'), '4194305');
    await expect(withLock(lockDir, () => 'ran', { pollMs: 10 })).resolves.toBe('ran');
  });

  it('takes over a lock older than staleMs', async () => {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, old, old);
    await expect(withLock(lockDir, () => 'ran', { staleMs: 30_000, pollMs: 10 })).resolves.toBe('ran');
  });

  it('waits for a live holder', async () => {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid));
    setTimeout(() => fs.rmSync(lockDir, { recursive: true, force: true }), 50);
    const start = Date.now();
    await withLock(lockDir, () => undefined, { pollMs: 10 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });
});

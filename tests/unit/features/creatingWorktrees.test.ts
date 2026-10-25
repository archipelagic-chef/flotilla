import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { clearCreatingRecord, CreatingWorktrees, readCreatingRecords } from '../../../src/features/backlog/creatingWorktrees';

describe('CreatingWorktrees', () => {
  it('runs one creation per ticket at a time; a second start meanwhile creates nothing', async () => {
    const creating = new CreatingWorktrees();
    let finish!: (key: string) => void;
    let made = 0;
    const create = () => {
      made++;
      return new Promise<string>((resolve) => (finish = resolve));
    };

    const first = creating.run('BL-12', create);
    expect(creating.has('BL-12')).toBe(true);
    expect(await creating.run('BL-12', create)).toEqual({ busy: true });
    expect(made).toBe(1);

    finish('wt-key');
    expect(await first).toEqual({ busy: false, value: 'wt-key' });
    expect(creating.has('BL-12')).toBe(false);
  });

  it('lets other tickets create at the same time, and says when each starts and ends', async () => {
    const creating = new CreatingWorktrees();
    const seen: string[][] = [];
    creating.onDidChange(() => seen.push(creating.ids()));
    await Promise.all([creating.run('BL-1', async () => 1), creating.run('BL-2', async () => 2)]);
    expect(seen[0]).toEqual(['BL-1']);
    expect(seen[1]).toEqual(['BL-1', 'BL-2']);
    expect(seen.at(-1)).toEqual([]);
  });

  it('ends a failed creation too, and waits for one that runs', async () => {
    const creating = new CreatingWorktrees();
    let fail!: (e: Error) => void;
    const run = creating.run('BL-3', () => new Promise((_, reject) => (fail = reject)));
    const waited = creating.settled('BL-3');
    fail(new Error('git failed'));
    await expect(run).rejects.toThrow('git failed');
    await waited;
    expect(creating.has('BL-3')).toBe(false);
    expect((await creating.run('BL-3', async () => 'again')).busy).toBe(false);
  });

  describe('shared between windows', () => {
    const dirs: string[] = [];
    const tmp = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creating-'));
      dirs.push(dir);
      return path.join(dir, 'flotilla', 'creating');
    };
    afterEach(() => {
      for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    });
    const window = (pid: number, running: Set<number>, host = 'box') => new CreatingWorktrees({ pid, host }, (p) => running.has(p));

    it('records a creation while it runs, so another window sees it and creates nothing', async () => {
      const dir = tmp();
      const running = new Set([1, 2]);
      const a = window(1, running);
      const b = window(2, running);
      const disposers = [a.attach(dir), b.attach(dir)];
      let finish!: () => void;
      const first = a.run('BL-7', () => new Promise<void>((resolve) => (finish = resolve)));

      expect(readCreatingRecords(dir)).toMatchObject([{ id: 'BL-7', pid: 1, host: 'box' }]);
      b.reload();
      expect(b.has('BL-7')).toBe(true);
      expect(await b.run('BL-7', async () => 'second')).toEqual({ busy: true });

      const waited = b.settled('BL-7');
      finish();
      await first;
      await waited;
      expect(readCreatingRecords(dir)).toEqual([]);
      expect(b.has('BL-7')).toBe(false);
      for (const d of disposers) d.dispose();
    });

    it("doesn't count a record left by a window that closed mid-creation; clearing removes it", () => {
      const dir = tmp();
      const running = new Set([2]);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'BL-8.json'), JSON.stringify({ id: 'BL-8', pid: 1, host: 'box', at: 0 }));
      const b = window(2, running);
      const d = b.attach(dir);
      expect(b.has('BL-8')).toBe(false);
      expect(readCreatingRecords(dir)).toHaveLength(1);
      clearCreatingRecord(dir, 'BL-8');
      expect(readCreatingRecords(dir)).toEqual([]);
      d.dispose();
    });

    it("trusts another machine's record, whose process it can't see", () => {
      const dir = tmp();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'BL-9.json'), JSON.stringify({ id: 'BL-9', pid: 1, host: 'elsewhere', at: 0 }));
      const b = window(2, new Set([2]));
      const d = b.attach(dir);
      expect(b.has('BL-9')).toBe(true);
      d.dispose();
    });
  });
});

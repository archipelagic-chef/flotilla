import { describe, expect, it } from 'vitest';
import { CreatingWorktrees } from '../../../src/features/backlog/creatingWorktrees';

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
});

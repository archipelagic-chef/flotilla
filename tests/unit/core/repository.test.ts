import { describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repository';

describe('Repository', () => {
  it('coalesces refresh calls into one load and notifies listeners', async () => {
    let loads = 0;
    const repo = new Repository(async () => [++loads], 10);
    let changes = 0;
    repo.onDidChange(() => changes++);
    await Promise.all([repo.refresh(), repo.refresh(), repo.refresh()]);
    expect(loads).toBe(1);
    expect(repo.current).toEqual([1]);
    expect(changes).toBe(1);
  });

  it('runs one more load when refreshed during a load', async () => {
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const repo = new Repository(async () => {
      loads++;
      if (loads === 1) await gate;
      return [loads];
    }, 5);
    const first = repo.refresh();
    await new Promise((r) => setTimeout(r, 20));
    const second = repo.refresh();
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all([first, second]);
    expect(loads).toBe(2);
    expect(repo.current).toEqual([2]);
  });

  it('keeps the previous snapshot and reports errors', async () => {
    let fail = false;
    const errors: unknown[] = [];
    const repo = new Repository(async () => {
      if (fail) throw new Error('boom');
      return ['ok'];
    }, 5, (e) => errors.push(e));
    await repo.refresh();
    fail = true;
    await repo.refresh();
    expect(repo.current).toEqual(['ok']);
    expect(errors).toHaveLength(1);
  });

  it('stops notifying disposed listeners', async () => {
    const repo = new Repository(async () => [1], 5);
    let changes = 0;
    const sub = repo.onDidChange(() => changes++);
    sub.dispose();
    await repo.refresh();
    expect(changes).toBe(0);
  });

  it('isolates a throwing listener from other listeners and from load errors', async () => {
    const errors: unknown[] = [];
    const repo = new Repository(async () => ['ok'], 5, (e) => errors.push(e));
    let secondListenerCalls = 0;
    repo.onDidChange(() => {
      throw new Error('listener error');
    });
    repo.onDidChange(() => {
      secondListenerCalls++;
    });
    await repo.refresh();
    expect(repo.current).toEqual(['ok']);
    expect(secondListenerCalls).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect((errors[0] as Error).message).toBe('listener error');
  });
});

describe('Repository.patch', () => {
  it('applies at once, and a load that started before the patch is redone instead of undoing it', async () => {
    let value = 'old';
    let release: (() => void) | undefined;
    const repo = new Repository<string>(async () => {
      const seen = value;
      await new Promise<void>((r) => (release = r));
      return [seen];
    }, 0);
    const changes: string[][] = [];
    repo.onDidChange(() => changes.push([...repo.current]));
    const done = repo.refresh();
    await new Promise((r) => setTimeout(r, 5));
    value = 'new';
    repo.patch(() => ['patched']);
    expect(repo.current).toEqual(['patched']);
    release!(); // the first load returns 'old': discarded
    await new Promise((r) => setTimeout(r, 5));
    expect(repo.current).toEqual(['patched']);
    release!(); // the second load sees 'new'
    await done;
    expect(repo.current).toEqual(['new']);
    expect(changes).toEqual([['patched'], ['new']]);
  });
});

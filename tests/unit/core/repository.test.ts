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

  it('passes each load the scope of the refreshes it answers, merged', async () => {
    const scopes: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const repo = new Repository<string>(async (scope) => {
      scopes.push(scope);
      if (scopes.length === 1) await gate;
      return [];
    }, 5);
    const first = repo.refresh(new Set(['a']));
    await new Promise((r) => setTimeout(r, 20));
    const second = repo.refresh(new Set(['b']));
    const third = repo.refresh(new Set(['c']));
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all([first, second, third]);
    expect(scopes).toEqual([new Set(['a']), new Set(['b', 'c'])]);
  });

  it('rebuilds everything when a full refresh is merged with scoped ones', async () => {
    const scopes: unknown[] = [];
    const repo = new Repository<string>(async (scope) => {
      scopes.push(scope);
      return [];
    }, 10);
    await Promise.all([repo.refresh(new Set(['a'])), repo.refresh(), repo.refresh(new Set(['b']))]);
    expect(scopes).toEqual(['all']);
  });

  it('gives the next load the scope of a load that failed', async () => {
    const scopes: unknown[] = [];
    let fail = true;
    const repo = new Repository<string>(async (scope) => {
      scopes.push(scope);
      if (fail) throw new Error('boom');
      return ['ok'];
    }, 5, () => undefined);
    await repo.refresh(new Set(['a']));
    fail = false;
    await repo.refresh(new Set(['b']));
    expect(scopes).toEqual([new Set(['a']), new Set(['a', 'b'])]);
    expect(repo.current).toEqual(['ok']);
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

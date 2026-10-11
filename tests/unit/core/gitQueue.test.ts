import { describe, expect, it } from 'vitest';
import { currentGitPriority, inBackground, MAX_GIT_PROCESSES, ProcessQueue } from '../../../src/core/git/gitQueue';

/** A task that stays running until released, and records when it started. */
function gated(started: string[], name: string) {
  let release!: () => void;
  const done = new Promise<void>((resolve) => (release = resolve));
  const task = async () => {
    started.push(name);
    await done;
    return name;
  };
  return { task, release };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ProcessQueue', () => {
  it('runs at most the limit at once', async () => {
    const queue = new ProcessQueue(2);
    let running = 0;
    let most = 0;
    const task = async () => {
      running++;
      most = Math.max(most, running);
      await tick();
      running--;
    };
    await Promise.all(Array.from({ length: 10 }, () => queue.run('foreground', task)));
    expect(most).toBe(2);
    expect(queue.active).toBe(0);
  });

  it('starts foreground work before waiting background work', async () => {
    const queue = new ProcessQueue(1);
    const started: string[] = [];
    const blocker = gated(started, 'blocker');
    const first = queue.run('foreground', blocker.task);
    const background = queue.run('background', async () => started.push('background'));
    const foreground = queue.run('foreground', async () => started.push('foreground'));
    await tick();
    blocker.release();
    await Promise.all([first, background, foreground]);
    expect(started).toEqual(['blocker', 'foreground', 'background']);
  });

  it('keeps each lane first in, first out', async () => {
    const queue = new ProcessQueue(1);
    const order: string[] = [];
    await Promise.all(['a', 'b', 'c'].map((name) => queue.run('background', async () => void order.push(name))));
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('frees its slot when a task fails', async () => {
    const queue = new ProcessQueue(1);
    await expect(queue.run('foreground', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(queue.run('foreground', async () => 'next')).resolves.toBe('next');
  });
});

describe('git priority', () => {
  it('is foreground unless the work is inside inBackground', async () => {
    expect(currentGitPriority()).toBe('foreground');
    await inBackground(async () => {
      await tick();
      expect(currentGitPriority()).toBe('background');
    });
    expect(currentGitPriority()).toBe('foreground');
  });

  it('limits git to the CPUs, at most 8', () => {
    expect(MAX_GIT_PROCESSES).toBeGreaterThanOrEqual(1);
    expect(MAX_GIT_PROCESSES).toBeLessThanOrEqual(8);
  });
});

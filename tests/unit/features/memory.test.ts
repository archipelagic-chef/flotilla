import { describe, expect, it } from 'vitest';
import { formatMemory, isMemoryShort, shortageAfterStarting } from '../../../src/features/workstreams/memory';
import { StartingAgents } from '../../../src/features/workstreams/startingAgents';

describe('the memory check', () => {
  it('is short only below the minimum (0 never asks for room)', () => {
    expect(isMemoryShort(1999, 2048)).toBe(true);
    expect(isMemoryShort(2048, 2048)).toBe(false);
    expect(isMemoryShort(0, 0)).toBe(false);
  });

  it('counts the agents starting now against the free memory', () => {
    expect(shortageAfterStarting(2500, 0, 2048)).toBeUndefined();
    expect(shortageAfterStarting(2500, 300, 2048)).toBeUndefined();
    expect(shortageAfterStarting(2500, 600, 2048)).toEqual({ freeMB: 1900, minMB: 2048 });
  });

  it('lets a burst of starts through only while the free memory minus them is enough', () => {
    let now = 0;
    const starting = new StartingAgents(() => now);
    // The minimum plus 1,300 MB: a start leaves 300 MB less each time, so five fit, and the sixth would leave 1,848 MB.
    const free = 2048 + 1300;
    const started: number[] = [];
    for (let i = 0; i < 10; i++) {
      // Each start is checked (as the review loop and autopilot do) before it starts, in the same instant.
      if (shortageAfterStarting(free, starting.memoryMB(), 2048)) break;
      started.push(starting.begin());
    }
    expect(started).toHaveLength(5);
    // Once their minute has passed, there's room again.
    now = 60_000;
    expect(shortageAfterStarting(free, starting.memoryMB(), 2048)).toBeUndefined();
  });

  it('says sizes for people', () => {
    expect(formatMemory(900.4)).toBe('900 MB');
    expect(formatMemory(2048)).toBe('2.0 GB');
    expect(formatMemory(1536)).toBe('1.5 GB');
  });
});

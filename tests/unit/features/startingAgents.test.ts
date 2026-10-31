import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  AGENT_MB,
  PENDING_MAX_MS,
  START_WINDOW_MS,
  StartingAgents,
} from '../../../src/features/workstreams/startingAgents';

describe('starting agents', () => {
  it('counts each start at about 300 MB until its minute passes', () => {
    let now = 1_000_000;
    const starting = new StartingAgents(() => now);
    expect(starting.memoryMB()).toBe(0);

    // A burst of three starts in quick succession: each one counts.
    starting.begin();
    now += 2_000;
    starting.begin();
    now += 2_000;
    starting.begin();
    expect(AGENT_MB).toBe(300);
    expect(starting.memoryMB()).toBe(3 * 300);

    // A start stops counting when its minute has passed (the first one, 60 s after it began).
    now = 1_000_000 + START_WINDOW_MS - 1;
    expect(starting.memoryMB()).toBe(3 * 300);
    now = 1_000_000 + START_WINDOW_MS;
    expect(starting.memoryMB()).toBe(2 * 300);
    now = 1_000_000 + START_WINDOW_MS + 4_000;
    expect(starting.memoryMB()).toBe(0);
  });

  it('stops counting a start when its process has ended', () => {
    const starting = new StartingAgents(() => 0);
    const first = starting.begin();
    starting.begin();
    expect(starting.memoryMB()).toBe(2 * 300);
    starting.end(first);
    expect(starting.memoryMB()).toBe(300);
    // Ending twice (an error, then an exit) is harmless.
    starting.end(first);
    expect(starting.memoryMB()).toBe(300);
  });

  it('holds a reserved start until it spawns, however long that takes, then counts its minute from the spawn', () => {
    let now = 0;
    const starting = new StartingAgents(() => now);
    const token = starting.reserve();
    // A start that takes a while to prepare (a base, a ticket, a worktree) keeps its memory the whole time.
    now = START_WINDOW_MS * 3;
    expect(starting.memoryMB()).toBe(AGENT_MB);
    starting.spawned(token);
    now += START_WINDOW_MS - 1;
    expect(starting.memoryMB()).toBe(AGENT_MB);
    now += 1;
    expect(starting.memoryMB()).toBe(0);
  });

  it('drops a reserved start that never spawned, once it has been pending too long', () => {
    let now = 0;
    const starting = new StartingAgents(() => now);
    starting.reserve();
    now = PENDING_MAX_MS - 1;
    expect(starting.memoryMB()).toBe(AGENT_MB);
    now = PENDING_MAX_MS;
    expect(starting.memoryMB()).toBe(0);
  });
});

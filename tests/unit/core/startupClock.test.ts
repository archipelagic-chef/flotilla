import { describe, expect, it } from 'vitest';
import { StartupClock } from '../../../src/core/startupClock';

describe('StartupClock', () => {
  it('says each step once, then how long startup took once the expected steps are there', () => {
    const lines: string[] = [];
    let now = 0;
    const clock = new StartupClock(
      (l) => lines.push(l),
      ['page ready', 'worktrees shown'],
      () => now,
    );
    now = 120;
    clock.mark('activated');
    now = 900;
    clock.mark('page ready');
    clock.mark('page ready');
    now = 1450;
    clock.mark('worktrees shown');
    now = 2000;
    clock.mark('worktrees built');
    expect(lines).toEqual([
      'Startup: activated at 120 ms',
      'Startup: page ready at 900 ms',
      'Startup: worktrees shown at 1.4 s',
      'Startup took 1.4 s: activated 120 ms, page ready 900 ms, worktrees shown 1.4 s',
      'Startup: worktrees built at 2.0 s',
    ]);
  });

  it('takes a step at the time it is given, in its place in the summary', () => {
    const lines: string[] = [];
    const clock = new StartupClock(
      (l) => lines.push(l),
      ['activated'],
      () => 600,
    );
    clock.mark('bundle loading', 450);
    clock.mark('activated');
    expect(lines.at(-1)).toBe('Startup took 600 ms: bundle loading 450 ms, activated 600 ms');
  });
});

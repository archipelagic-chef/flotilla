import {
  describe,
  expect,
  it,
} from 'vitest';
import { singleFlight } from '../../../src/core/singleFlight';

/** A run that finishes when it's told to, counting how many started. */
function gated() {
  const gates: Array<() => void> = [];
  let started = 0;
  const run = () =>
    new Promise<void>((resolve) => {
      started++;
      gates.push(resolve);
    });
  return { run, gates, started: () => started };
}

describe('singleFlight', () => {
  it('runs one at a time, with one more run after it for every call meanwhile', async () => {
    const { run, gates, started } = gated();
    const call = singleFlight(run);
    const first = call();
    const later = [call(), call(), call()];
    expect(started()).toBe(1);
    gates[0]();
    await first;
    await Promise.resolve();
    await Promise.resolve();
    expect(started()).toBe(2);
    gates[1]();
    await Promise.all(later);
    expect(started()).toBe(2);
  });

  it('settles each call with a run that started after it, also when the one running fails', async () => {
    let runs = 0;
    const call = singleFlight(async () => {
      runs++;
      if (runs === 1) throw new Error('first failed');
    });
    const first = call();
    const second = call();
    await expect(first).rejects.toThrow('first failed');
    await expect(second).resolves.toBeUndefined();
    expect(runs).toBe(2);
    await call();
    expect(runs).toBe(3);
  });
});

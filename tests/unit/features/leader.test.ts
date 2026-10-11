import { afterEach, describe, expect, it } from 'vitest';
import { Leader } from '../../../src/features/backlog/leader';
import { makeTempDir, removeDir } from '../../helpers/gitRepo';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(removeDir));

describe('the leading window', () => {
  it('is one at a time; another takes over when it goes quiet or leaves', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    let now = 1_000_000;
    const a = new Leader(dir, () => now);
    const b = new Leader(dir, () => now);
    expect(a.check()).toBe(true);
    expect(b.check()).toBe(false);
    now += 60_000;
    expect(b.check()).toBe(false);
    now += 40_000;
    expect(b.check()).toBe(true);
    expect(a.check()).toBe(false);
    const handle = b.start();
    handle.dispose();
    expect(a.check()).toBe(true);
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { ShownFolders } from '../../../../src/ui/sidebar/shownFolders';

/** Waits until the predicate holds: watchers report asynchronously. */
async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('ShownFolders', () => {
  let root: string;
  let calls: Array<[string, string]>;
  let shown: ShownFolders;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'shown-folders-'));
    fs.mkdirSync(path.join(root, 'src'));
    calls = [];
    shown = new ShownFolders((key, rel) => calls.push([key, rel]));
  });

  afterEach(() => {
    shown.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports a file created in a listed folder, once per burst', async () => {
    shown.watch('wt', root, 'src');
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, 'src', `f${i}.ts`), '');
    await until(() => calls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(calls).toEqual([['wt', 'src']]);
  });

  it('does not report a write to a file that changes no listing', async () => {
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'one');
    shown.watch('wt', root, 'src');
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'two, longer');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(calls).toEqual([]);
    fs.writeFileSync(path.join(root, 'src', 'b.ts'), '');
    await until(() => calls.length > 0);
    expect(calls).toEqual([['wt', 'src']]);
  });

  it('stops watching the least recently listed folder when there are too many', async () => {
    const dirs = Array.from({ length: 101 }, (_, i) => `d${i}`);
    for (const d of dirs) fs.mkdirSync(path.join(root, d));
    for (const d of dirs) shown.watch('wt', root, d);
    fs.writeFileSync(path.join(root, 'd0', 'x.ts'), '');
    fs.writeFileSync(path.join(root, 'd100', 'x.ts'), '');
    await until(() => calls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(calls).toEqual([['wt', 'd100']]);
  });

  it('stops watching the folders of worktrees that are gone', async () => {
    shown.watch('gone', root, 'src');
    shown.watch('kept', root, '');
    shown.retain(new Set(['kept']));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), '');
    fs.writeFileSync(path.join(root, 'b.ts'), '');
    await until(() => calls.some(([key]) => key === 'kept'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(calls.some(([key]) => key === 'gone')).toBe(false);
  });

  it('ignores folders that do not exist', () => {
    expect(() => shown.watch('wt', root, 'missing')).not.toThrow();
    expect(calls).toEqual([]);
  });
});

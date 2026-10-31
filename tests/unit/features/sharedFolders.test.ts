import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { Workstream } from '../../../src/features/workstreams/workstream';
import {
  makeTempDir,
  removeDir,
  writeFile,
} from '../../helpers/gitRepo';

const settings: Record<string, unknown> = { linkFolders: ['node_modules'] };

vi.mock('vscode', () => ({
  window: { showInformationMessage: vi.fn(), withProgress: async (_o: unknown, task: () => Promise<unknown>) => task() },
  workspace: { getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings[key] ?? fallback }) },
  commands: { executeCommand: vi.fn() },
  ProgressLocation: { Notification: 15 },
}));

const cleanup: string[] = [];
const disposables: Array<{ dispose(): void }> = [];
afterEach(() => {
  disposables.splice(0).forEach((d) => d.dispose());
  cleanup.splice(0).forEach(removeDir);
});

describe('SharedFolders', () => {
  it('shares a worktree’s linked folders with the main worktree, at most once a day, in the leading window', async () => {
    const { SharedFolders } = await import('../../../src/ui/sharedFolders');
    const main = makeTempDir();
    const wt = makeTempDir();
    cleanup.push(main, wt);
    writeFile(main, 'node_modules/a/index.js', 'same');
    writeFile(wt, 'node_modules/a/index.js', 'same');
    const ws = { key: 'admin/wt', worktree: { isMain: false, path: wt, branch: 'feature/x' } } as unknown as Workstream;
    const data: Record<string, unknown> = {};
    const output: string[] = [];
    const leader = { isLeader: false };
    const shared = new SharedFolders({
      repository: { current: [ws], onDidChange: () => ({ dispose() {} }) },
      leader,
      mainRoot: main,
      workspaceState: { get: (k: string) => data[k], update: async (k: string, v: unknown) => void (data[k] = v), keys: () => [] } as never,
      output: { appendLine: (l: string) => void output.push(l) } as never,
    });
    disposables.push(shared);

    await shared.sweep();
    expect(fs.statSync(path.join(wt, 'node_modules/a/index.js')).nlink).toBe(1);

    leader.isLeader = true;
    await shared.sweep();
    expect(fs.statSync(path.join(wt, 'node_modules/a/index.js')).nlink).toBe(2);
    expect(output).toEqual([expect.stringMatching(/^Shared 1 files of node_modules in .*: 4 bytes freed\.$/)]);

    // Copied again by an install: not looked at again the same day.
    fs.rmSync(path.join(wt, 'node_modules/a/index.js'));
    writeFile(wt, 'node_modules/a/index.js', 'same');
    await shared.sweep();
    expect(fs.statSync(path.join(wt, 'node_modules/a/index.js')).nlink).toBe(1);
  });
});

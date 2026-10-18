import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGit } from '../../../src/core/git/gitCli';
import { parseLooseCount } from '../../../src/features/storage/packing';
import { parseMountInfo } from '../../../src/features/storage/storage';
import { git, initRepo, makeTempDir, removeDir } from '../../helpers/gitRepo';

const showWarningMessage = vi.fn(async (..._args: string[]) => undefined as string | undefined);
const openExternal = vi.fn(async (_uri: string) => true);

vi.mock('vscode', () => ({
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  window: { showWarningMessage },
  env: { openExternal },
  Uri: { parse: (s: string) => s },
}));

// A 9p mount over the whole file system, so that the temporary repositories are on it.
const NINE_P = parseMountInfo('40 25 0:50 / / rw - 9p C:\\ rw');
const cleanup: string[] = [];
const monitors: Array<{ dispose(): void }> = [];

beforeEach(() => {
  showWarningMessage.mockClear();
  openExternal.mockClear();
});
afterEach(() => {
  monitors.splice(0).forEach((m) => m.dispose());
  cleanup.splice(0).forEach(removeDir);
});

async function load() {
  const { StorageMonitor } = await import('../../../src/ui/storage');
  return StorageMonitor;
}

function memento(): { get<T>(k: string): T | undefined; update(k: string, v: unknown): Promise<void> } {
  const store = new Map<string, unknown>();
  return {
    get: <T,>(k: string) => store.get(k) as T | undefined,
    update: async (k, v) => void store.set(k, v),
  };
}

/** A repository with more loose objects than the packing limit (1,000). */
function repoWithLooseObjects(): string {
  const repo = initRepo();
  cleanup.push(repo);
  const dir = makeTempDir();
  cleanup.push(dir);
  const files: string[] = [];
  for (let i = 0; i < 1100; i++) {
    const file = path.join(dir, `f${i}`);
    fs.writeFileSync(file, `object ${i}\n`);
    files.push(file);
  }
  execFileSync('git', ['hash-object', '-w', '--stdin-paths'], { cwd: repo, input: files.join('\n') + '\n' });
  return repo;
}

function monitorFor(repo: string, opts: { backlogItems?: unknown[]; globalState?: ReturnType<typeof memento> } = {}, StorageMonitor: any) {
  const lines: string[] = [];
  const monitor = new StorageMonitor({
    mainRoot: repo,
    commonDir: path.join(repo, '.git'),
    backlog: { read: async () => ({ items: opts.backlogItems ?? [] }) },
    globalState: opts.globalState ?? memento(),
    output: { appendLine: (line: string) => lines.push(line) },
    mounts: () => NINE_P,
    probe: () => undefined,
  } as never);
  monitors.push(monitor);
  return { monitor, lines };
}

/** Polls until the condition holds (background work that start() doesn't wait for). */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1500 && !condition(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(condition()).toBe(true);
}

const looseCount = async (repo: string) => parseLooseCount(await runGit(['count-objects', '-v'], { cwd: repo }));

describe('StorageMonitor packing', () => {
  it('leaves a repository under the limit alone', async () => {
    const StorageMonitor = await load();
    const repo = initRepo();
    cleanup.push(repo);
    const { monitor, lines } = monitorFor(repo, {}, StorageMonitor);
    await monitor.pack();
    expect(lines.some((l) => l.startsWith('Packing the repository'))).toBe(false);
  });

  it('waits while a history clean-up is in progress, and packs after it', async () => {
    const StorageMonitor = await load();
    const repo = repoWithLooseObjects();
    const rewrite = { branch: 'b', clean: 'b-clean', base: 'main', by: 'you', started: '2026-10-12T21:00:00Z' };
    const { monitor, lines } = monitorFor(repo, { backlogItems: [{ id: 'BL-1', rewrite }] }, StorageMonitor);
    await monitor.pack();
    expect(lines).toContain('Not packing the repository now: a history clean-up is in progress.');
    expect(await looseCount(repo)).toBeGreaterThan(1000);

    const { monitor: later, lines: laterLines } = monitorFor(repo, { backlogItems: [{ id: 'BL-1' }] }, StorageMonitor);
    await later.pack();
    expect(laterLines).toContain('Packed the repository.');
    expect(await looseCount(repo)).toBe(0);
  });

  it('runs one packing at a time', async () => {
    const StorageMonitor = await load();
    const repo = repoWithLooseObjects();
    const { monitor, lines } = monitorFor(repo, {}, StorageMonitor);
    await Promise.all([monitor.pack(), monitor.pack()]);
    expect(lines.filter((l) => l.startsWith('Packing the repository ('))).toHaveLength(1);
    expect(await looseCount(repo)).toBe(0);
  });

  it('still packs when the storage could not be measured', async () => {
    const StorageMonitor = await load();
    const repo = repoWithLooseObjects();
    const lines: string[] = [];
    const monitor = new StorageMonitor({
      mainRoot: repo,
      commonDir: path.join(repo, '.git'),
      backlog: { read: async () => ({ items: [] }) },
      globalState: memento(),
      output: { appendLine: (line: string) => lines.push(line) },
      mounts: () => undefined,
      probe: () => {
        throw new Error('boom');
      },
    } as never);
    monitors.push(monitor);
    await monitor.start();
    expect(lines).toContain('Checking the repository storage failed.');
    // start() packs in the background; wait for that run to finish.
    await waitFor(() => lines.includes('Packed the repository.'));
    expect(await looseCount(repo)).toBe(0);
  });
});

describe('StorageMonitor notification', () => {
  it('says so once per repository, and never with a path', async () => {
    const StorageMonitor = await load();
    const repo = initRepo();
    cleanup.push(repo);
    const state = memento();
    const first = monitorFor(repo, { globalState: state }, StorageMonitor);
    await first.monitor.start();
    const second = monitorFor(repo, { globalState: state }, StorageMonitor);
    await second.monitor.start();

    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    const text = String(showWarningMessage.mock.calls[0][0]);
    expect(text).toContain('9p');
    expect(text).not.toContain(repo);
    expect(first.monitor.slow?.message).toContain('9p');
  });

  it('opens the docs when asked to', async () => {
    const StorageMonitor = await load();
    const repo = initRepo();
    cleanup.push(repo);
    showWarningMessage.mockResolvedValueOnce('How to Fix');
    const { monitor } = monitorFor(repo, {}, StorageMonitor);
    await monitor.start();
    expect(openExternal).toHaveBeenCalledWith(expect.stringContaining('code.visualstudio.com'));
  });
});

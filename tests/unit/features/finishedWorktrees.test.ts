import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BacklogItem } from '../../../src/features/backlog/backlog';
import type { Workstream } from '../../../src/features/workstreams/workstream';
import { makeTempDir, removeDir, writeFile } from '../../helpers/gitRepo';

const showInformationMessage = vi.fn(async (..._args: unknown[]) => undefined as string | undefined);
const showQuickPick = vi.fn(async (..._args: unknown[]) => undefined as unknown);
const settings: Record<string, unknown> = {};
const update = vi.fn(async () => undefined);

vi.mock('vscode', () => ({
  window: {
    showInformationMessage,
    showQuickPick,
    withProgress: async (_o: unknown, task: (p: { report(): void }) => Promise<void>) => task({ report() {} }),
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings[key] ?? fallback, update }),
  },
  ProgressLocation: { Notification: 15, Window: 10 },
  ConfigurationTarget: { Workspace: 2 },
}));

const cleanup: string[] = [];
const disposables: Array<{ dispose(): void }> = [];

beforeEach(() => {
  showInformationMessage.mockReset();
  showQuickPick.mockReset();
  update.mockClear();
  for (const k of Object.keys(settings)) delete settings[k];
});
afterEach(() => {
  disposables.splice(0).forEach((d) => d.dispose());
  cleanup.splice(0).forEach(removeDir);
});

function item(id: string, status: BacklogItem['status']): BacklogItem {
  return { id, title: id, status, priority: 'medium', created: '', branch: `feature/${id}` } as BacklogItem;
}

function worktree(id: string, extra: Partial<Workstream> = {}): Workstream {
  const dir = makeTempDir();
  cleanup.push(dir);
  writeFile(dir, 'file.txt', 'x'.repeat(100));
  return {
    key: `admin/${id}`,
    worktree: { isMain: false, path: dir, branch: `feature/${id}`, adminDir: `admin/${id}` },
    changes: [],
    agent: undefined,
    agentStale: false,
    windowOpen: false,
    isCurrent: false,
    activity: 'idle',
    ...extra,
  } as unknown as Workstream;
}

function memento(initial: Record<string, unknown> = {}) {
  const data = { ...initial };
  return { data, get: <T>(k: string) => data[k] as T, update: async (k: string, v: unknown) => void (data[k] = v), keys: () => Object.keys(data) };
}

async function setup(o: {
  items: BacklogItem[];
  worktrees: Workstream[];
  introduced?: boolean;
  leader?: boolean;
  leftovers?: string[];
  kept?: string[];
  keptLeftovers?: string[];
}) {
  const { FinishedWorktrees } = await import('../../../src/ui/finishedWorktrees');
  const removed: string[] = [];
  const deleted: string[] = [];
  const output: string[] = [];
  const activity: Array<[string, string]> = [];
  const state = memento({ ...(o.introduced ? { 'flotilla.finishedWorktrees.introduced': true } : {}), ...(o.kept ? { 'flotilla.finishedWorktrees.kept': o.kept } : {}),
    ...(o.keptLeftovers ? { 'flotilla.finishedWorktrees.keptLeftovers': o.keptLeftovers } : {}),
  });
  const removeAnyway = vi.fn(async () => undefined);
  const cleaner = new FinishedWorktrees({
    backlog: {
      read: async () => ({ items: o.items }) as never,
      watch: () => ({ dispose() {} }),
      appendActivity: async (i, e) => void activity.push([i.id, e.body]),
    },
    repository: { current: o.worktrees, refresh: async () => undefined, onDidChange: () => ({ dispose() {} }) } as never,
    service: {
      removalRisks: async (wt) => ({ changedFiles: o.worktrees.find((w) => w.worktree === wt)!.changes.length, unmergedCommits: 0 }),
      remove: async (wt) => void removed.push(wt.branch!),
      leftovers: async () => o.leftovers ?? [],
      deleteLeftover: async (dir) => void deleted.push(dir),
    },
    leader: { isLeader: o.leader ?? true },
    workspaceState: state as never,
    output: { appendLine: (line: string) => void output.push(line) } as never,
    removeAnyway,
  });
  disposables.push(cleaner);
  return { cleaner, removed, deleted, output, activity, state, removeAnyway };
}

describe('FinishedWorktrees', () => {
  it('removes a done ticket’s unused worktree on its own, keeps the branch, and says so in the ticket', async () => {
    const { cleaner, removed, activity } = await setup({ items: [item('BL-1', 'done')], worktrees: [worktree('BL-1')], introduced: true });

    await cleaner.sweep();

    expect(removed).toEqual(['feature/BL-1']);
    expect(showInformationMessage).not.toHaveBeenCalled();
    expect(activity).toEqual([['BL-1', 'Removed the worktree of `feature/BL-1` now that the ticket is done; the branch stays: 100 bytes freed.']]);
  });

  it('leaves tickets that aren’t done alone, and does nothing in a window that isn’t leading', async () => {
    const a = await setup({ items: [item('BL-1', 'review'), item('BL-2', 'doing')], worktrees: [worktree('BL-1'), worktree('BL-2')], introduced: true });
    await a.cleaner.sweep();
    expect(a.removed).toEqual([]);

    const b = await setup({ items: [item('BL-1', 'done')], worktrees: [worktree('BL-1')], introduced: true, leader: false });
    await b.cleaner.sweep();
    expect(b.removed).toEqual([]);
  });

  it('leaves a ticket alone while its history is being cleaned up', async () => {
    const rewriting = { ...item('BL-1', 'done'), rewrite: { branch: 'feature/BL-1' } } as BacklogItem;
    const { cleaner, removed } = await setup({ items: [rewriting], worktrees: [worktree('BL-1')], introduced: true });
    await cleaner.sweep();
    expect(removed).toEqual([]);
    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  it('asks once, with the reason, when something is at stake; Keep is remembered', async () => {
    const dirty = worktree('BL-1', { changes: [{}, {}] as never });
    const { cleaner, removed, state } = await setup({ items: [item('BL-1', 'done')], worktrees: [dirty], introduced: true });
    showInformationMessage.mockResolvedValueOnce('Keep');

    await cleaner.sweep();
    await new Promise((r) => setTimeout(r, 0));

    expect(showInformationMessage).toHaveBeenCalledWith("BL-1 is done, but its worktree wasn't removed: it has 2 uncommitted or untracked files.", 'Remove Anyway', 'Keep');
    expect(state.data['flotilla.finishedWorktrees.kept']).toEqual(['BL-1']);
    await cleaner.sweep();
    expect(showInformationMessage).toHaveBeenCalledTimes(1);
    expect(removed).toEqual([]);
  });

  it('hands Remove Anyway to the Remove command, which confirms what would be lost', async () => {
    const busy = worktree('BL-1', { agent: { state: 'working' } as never });
    const { cleaner, removed, removeAnyway } = await setup({ items: [item('BL-1', 'done')], worktrees: [busy], introduced: true });
    showInformationMessage.mockResolvedValueOnce('Remove Anyway');

    await cleaner.sweep();
    await new Promise((r) => setTimeout(r, 0));

    expect(removeAnyway).toHaveBeenCalledWith(busy);
    expect(removed).toEqual([]);
  });

  it('asks first about the worktrees that were already finished, then removes them', async () => {
    const { cleaner, removed, state } = await setup({
      items: [item('BL-1', 'done'), item('BL-2', 'done'), item('BL-3', 'review')],
      worktrees: [worktree('BL-1'), worktree('BL-2'), worktree('BL-3')],
    });
    showInformationMessage.mockResolvedValueOnce('Remove');

    await cleaner.sweep();

    expect(showInformationMessage.mock.calls[0][0]).toBe(
      '2 worktrees belong to tickets that are done and take 200 bytes. Remove them? Branches are kept, and Flotilla removes finished worktrees from now on.',
    );
    expect(removed).toEqual(['feature/BL-1', 'feature/BL-2']);
    expect(state.data['flotilla.finishedWorktrees.introduced']).toBe(true);
  });

  it('removes nothing when the first question is put off, and turns itself off on Never', async () => {
    const a = await setup({ items: [item('BL-1', 'done')], worktrees: [worktree('BL-1')] });
    showInformationMessage.mockResolvedValueOnce('Not Now');
    await a.cleaner.sweep();
    await a.cleaner.sweep();
    expect(a.removed).toEqual([]);
    expect(showInformationMessage).toHaveBeenCalledTimes(1);

    const b = await setup({ items: [item('BL-1', 'done')], worktrees: [worktree('BL-1')] });
    showInformationMessage.mockResolvedValueOnce('Never');
    await b.cleaner.sweep();
    expect(b.removed).toEqual([]);
    expect(update).toHaveBeenCalledWith('removeFinishedWorktrees', 'off', 2);
  });

  it('says once in the output why a done ticket’s worktree stays', async () => {
    const { cleaner, output, removed } = await setup({ items: [item('BL-1', 'done')], worktrees: [worktree('BL-1')], introduced: true, kept: ['BL-1'] });
    await cleaner.sweep();
    await cleaner.sweep();
    expect(removed).toEqual([]);
    expect(output.filter((l) => l.startsWith('BL-1 is done'))).toEqual([expect.stringMatching(/stays: you chose to keep it\.$/)]);
  });

  it('asks once about a folder a removal left behind, and deletes it on Delete', async () => {
    const left = makeTempDir();
    cleanup.push(left);
    writeFile(left, 'big.bin', 'x'.repeat(2048));
    const { cleaner, deleted, output } = await setup({ items: [], worktrees: [], introduced: true, leftovers: [left] });
    showInformationMessage.mockResolvedValueOnce('Delete');

    await cleaner.sweep();
    await new Promise((r) => setTimeout(r, 20));
    await cleaner.sweep();

    expect(showInformationMessage).toHaveBeenCalledTimes(1);
    expect(String(showInformationMessage.mock.calls[0][0])).toContain('was left behind by a worktree removal that stopped halfway');
    expect(String(showInformationMessage.mock.calls[0][0])).toContain('2.0 KB');
    expect(deleted).toEqual([left]);
    expect(output.at(-1)).toContain('Deleted the leftover folder');
  });

  it('lists what was kept, and asks again about what is taken back', async () => {
    const left = makeTempDir();
    cleanup.push(left);
    const leftName = path.basename(left);
    const dirty = worktree('BL-1', { changes: [{}] as never });
    const { cleaner, state } = await setup({
      items: [item('BL-1', 'done')],
      worktrees: [dirty],
      introduced: true,
      kept: ['BL-1', 'BL-9'],
      keptLeftovers: [leftName, 'gone-folder'],
      leftovers: [left],
    });
    await cleaner.sweep();
    expect(showInformationMessage).not.toHaveBeenCalled();
    showQuickPick.mockImplementationOnce(async (picks) => (picks as Array<{ label: string }>).filter((p) => p.label === 'BL-1' || p.label === leftName));

    await cleaner.showKept();
    await new Promise((r) => setTimeout(r, 20));

    const picks = showQuickPick.mock.calls[0][0] as Array<{ label: string; detail?: string }>;
    expect(picks.map((p) => [p.label, p.detail])).toEqual([
      ['BL-1', expect.stringMatching(/^Worktree '/)],
      ['BL-9', 'Its worktree is gone'],
      [leftName, undefined],
      ['gone-folder', 'No longer there'],
    ]);
    expect(state.data['flotilla.finishedWorktrees.kept']).toEqual(['BL-9']);
    expect(state.data['flotilla.finishedWorktrees.keptLeftovers']).toEqual(['gone-folder']);
    // The sweep that follows asks about both again.
    const asked = showInformationMessage.mock.calls.map((c) => String(c[0]));
    expect(asked).toContainEqual(expect.stringContaining("BL-1 is done, but its worktree wasn't removed"));
    expect(asked).toContainEqual(expect.stringContaining(`'${leftName}' in .worktrees was left behind`));
  });

  it('takes back a Keep chosen in this session too', async () => {
    const dirty = worktree('BL-1', { changes: [{}] as never });
    const { cleaner } = await setup({ items: [item('BL-1', 'done')], worktrees: [dirty], introduced: true });
    showInformationMessage.mockResolvedValueOnce('Keep');
    await cleaner.sweep();
    await new Promise((r) => setTimeout(r, 0));
    expect(cleaner.kept().tickets).toEqual(['BL-1']);

    await cleaner.forget({ tickets: ['BL-1'] });
    await new Promise((r) => setTimeout(r, 0));

    expect(showInformationMessage).toHaveBeenCalledTimes(2);
    expect(cleaner.kept().tickets).toEqual([]);
  });

  it('says so when nothing was kept, and changes nothing when the picker is closed', async () => {
    const a = await setup({ items: [], worktrees: [], introduced: true });
    await a.cleaner.showKept();
    expect(showQuickPick).not.toHaveBeenCalled();
    expect(String(showInformationMessage.mock.calls[0][0])).toContain('haven’t kept any');

    const b = await setup({ items: [], worktrees: [], introduced: true, kept: ['BL-1'] });
    await b.cleaner.showKept();
    expect(b.state.data['flotilla.finishedWorktrees.kept']).toEqual(['BL-1']);
  });

  it('does nothing when the setting is off', async () => {
    settings.removeFinishedWorktrees = 'off';
    const { cleaner, removed } = await setup({ items: [item('BL-1', 'done')], worktrees: [worktree('BL-1')], introduced: true });
    await cleaner.sweep();
    expect(removed).toEqual([]);
    expect(showInformationMessage).not.toHaveBeenCalled();
  });
});

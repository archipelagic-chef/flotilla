import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {
  MachineState,
  SlowStorageView,
} from '../../../src/webview/protocol';
// The webview's api asks VS Code for its handle when it loads: none here.
vi.hoisted(() => {
  (globalThis as { acquireVsCodeApi?: () => unknown }).acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });
});
import {
  BacklogNotices,
  machineLine,
} from '../../../src/webview/ui/backlogNotices';

/** BL-293: the Overview's warnings show at the top of the Backlog, each only while it applies. */
const machine = (freeMB: number, over: Partial<MachineState> = {}): MachineState =>
  ({ agents: 2, windows: 1, freeMB, minFreeMB: 2048, ...over }) as MachineState;

/** The text a vnode tree shows (the component is called as a function: its children are plain vnodes). */
function text(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return text((node as { props?: { children?: unknown } }).props?.children);
}

const shown = (props: Parameters<typeof BacklogNotices>[0]) => text(BacklogNotices(props));

describe('the Backlog’s machine notices', () => {
  it('shows nothing while all is well', () => {
    expect(shown({ machine: machine(16_000), missing: [] })).toBe('');
  });

  it('warns while memory is too low for agents to start', () => {
    expect(shown({ machine: machine(500), missing: [] })).toContain('Low on memory: no agent starts below');
  });

  it('says what still sees the worktrees folder, with Hide Worktrees', () => {
    const t = shown({ missing: ['search', 'file watching'] });
    expect(t).toContain("aren't excluded from: search, file watching");
    expect(t).toContain('Hide Worktrees');
  });

  it('says the repository is on a slow drive, with How to Fix', () => {
    const slow = { message: 'This repository is on a slow drive.', fix: 'Move it.' } as SlowStorageView;
    const t = shown({ missing: [], slow });
    expect(t).toContain('This repository is on a slow drive. Move it.');
    expect(t).toContain('How to Fix');
  });

  it('puts the machine in a line, for the agent count’s tooltip', () => {
    expect(machineLine(undefined)).toBeUndefined();
    expect(machineLine(machine(4096, { agents: 1, windows: 3 }))).toMatch(/^1 agent working · 3 windows open · .+ memory free$/);
  });
});

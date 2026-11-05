import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('vscode', () => ({ window: { showWarningMessage: async () => undefined } }));

import {
  MachineWarnings,
  MEMORY_WARNING_QUIET_MS,
} from '../../../src/ui/machineWarnings';
import { machineLine } from '../../../src/webview/ui/machineLine';
import type { MachineState } from '../../../src/webview/protocol';

/** BL-293: the Overview's warnings are toasts now, shown when they start to apply, not on every refresh. */
function setup(opts: { answer?: string; offeredHere?: boolean } = {}) {
  const shown: Array<{ message: string; buttons: string[] }> = [];
  const state = new Map<string, unknown>();
  let now = 0;
  const hide = vi.fn(async () => undefined);
  const markOffered = vi.fn(async () => undefined);
  const warnings = new MachineWarnings({
    mainRoot: '/repo',
    globalState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => void state.set(k, v), keys: () => [...state.keys()] } as never,
    show: async (message, ...buttons) => {
      shown.push({ message, buttons });
      return opts.answer;
    },
    hideWorktrees: hide,
    offeredHere: () => !!opts.offeredHere,
    markOffered,
    now: () => now,
  });
  return { warnings, shown, hide, markOffered, tick: (ms: number) => (now += ms) };
}

describe('the missing-exclusions toast', () => {
  it('says what still sees the worktrees folder, once per new set, with Hide Worktrees', async () => {
    const { warnings, shown, markOffered } = setup();
    await warnings.exclusions(['search', 'file watching']);
    await warnings.exclusions(['search', 'file watching']);
    expect(shown).toHaveLength(1);
    expect(shown[0].message).toContain("aren't excluded from: search, file watching");
    expect(shown[0].buttons).toEqual(['Hide Worktrees', "Don't Show Again"]);
    expect(markOffered).toHaveBeenCalled();
    await warnings.exclusions([]);
    await warnings.exclusions(['search']);
    expect(shown).toHaveLength(2);
  });

  it('hides the worktrees on Hide Worktrees', async () => {
    const { warnings, hide } = setup({ answer: 'Hide Worktrees' });
    await warnings.exclusions(['search']);
    expect(hide).toHaveBeenCalled();
  });

  it("isn't shown again for the repository after Don't Show Again", async () => {
    const { warnings, shown } = setup({ answer: "Don't Show Again" });
    await warnings.exclusions(['search']);
    await warnings.exclusions([]);
    await warnings.exclusions(['search']);
    expect(shown).toHaveLength(1);
  });

  it('says nothing right after the first-time offer to hide .worktrees, which asks the same', async () => {
    const { warnings, shown } = setup({ offeredHere: true });
    await warnings.exclusions(['search']);
    expect(shown).toHaveLength(0);
  });
});

describe('the low-memory toast', () => {
  it('warns when memory falls below the minimum, not on each refresh while it stays low', () => {
    const { warnings, shown } = setup();
    warnings.memory(4000, 2048);
    warnings.memory(1000, 2048);
    warnings.memory(900, 2048);
    expect(shown).toHaveLength(1);
    expect(shown[0].message).toContain('Low on memory: no agent starts below');
  });

  it('warns again after memory recovers and falls, but not within the quiet time', () => {
    const { warnings, shown, tick } = setup();
    warnings.memory(1000, 2048);
    warnings.memory(4000, 2048);
    warnings.memory(1000, 2048);
    expect(shown).toHaveLength(1);
    tick(MEMORY_WARNING_QUIET_MS);
    warnings.memory(4000, 2048);
    warnings.memory(1000, 2048);
    expect(shown).toHaveLength(2);
  });
});

describe('the machine line', () => {
  it('puts the machine in a line, for the agent count’s tooltip', () => {
    expect(machineLine(undefined)).toBeUndefined();
    const machine = { agents: 1, windows: 3, freeMB: 4096, minFreeMB: 2048 } as MachineState;
    expect(machineLine(machine)).toMatch(/^1 agent working · 3 windows open · .+ memory free$/);
  });
});

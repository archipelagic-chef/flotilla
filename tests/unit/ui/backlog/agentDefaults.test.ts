import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const state = vi.hoisted(() => ({
  folders: [] as unknown[],
  updates: [] as Array<{ key: string; value: unknown; target: number }>,
}));

vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  workspace: {
    get workspaceFolders() {
      return state.folders;
    },
    getConfiguration: () => ({
      get: (_k: string, d: unknown) => d,
      update: async (key: string, value: unknown, target: number) => void state.updates.push({ key, value, target }),
    }),
  },
  extensions: { getExtension: () => undefined },
}));

import { defaultsLabel } from '../../../../src/features/backlog/backlog';
import { saveAgentDefault } from '../../../../src/ui/backlog/agentDefaults';

beforeEach(() => {
  state.folders = [];
  state.updates = [];
});

describe("saving the agents' default (BL-242)", () => {
  it("saves in the workspace's settings when a folder is open", async () => {
    state.folders = [{}];
    expect(await saveAgentDefault('model', 'sonnet')).toBe('workspace');
    expect(state.updates).toEqual([{ key: 'agents.model', value: 'sonnet', target: 2 }]);
  });

  it("saves in the user's settings without a folder", async () => {
    expect(await saveAgentDefault('effort', 'high')).toBe('user');
    expect(state.updates).toEqual([{ key: 'agents.effort', value: 'high', target: 1 }]);
  });

  it("unsets it when empty: Claude Code's default", async () => {
    expect(await saveAgentDefault('model', '  ')).toBe('user');
    expect(state.updates).toEqual([{ key: 'agents.model', value: undefined, target: 1 }]);
  });

  it("refuses what isn't a model's name or an effort", async () => {
    expect(await saveAgentDefault('model', '--dangerously-skip-permissions')).toBeUndefined();
    expect(await saveAgentDefault('effort', 'extreme')).toBeUndefined();
    expect(state.updates).toEqual([]);
  });
});

describe("the default's label", () => {
  it('names the model and effort, and the unset parts as Claude Code’s', () => {
    expect(defaultsLabel({ model: 'opus', effort: 'high' })).toBe('Opus · high');
    expect(defaultsLabel({ effort: 'low' })).toBe("Claude Code's model · low");
    expect(defaultsLabel({})).toBe("Claude Code's model · Claude Code's effort");
  });
});

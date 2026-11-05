import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const vscode = vi.hoisted(() => ({
  workspace: { workspaceFolders: undefined as unknown[] | undefined },
  commands: { executeCommand: vi.fn(async () => undefined) },
}));
vi.mock('vscode', () => vscode);
const { FLOTILLA_SETTINGS_QUERY, openFlotillaSettings } = await import('../../../src/ui/flotillaSettings');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'));

describe('Flotilla Settings (the sidebar gear)', () => {
  beforeEach(() => vscode.commands.executeCommand.mockClear());

  it('opens the Workspace tab of the Settings editor on Flotilla, when a folder is open', async () => {
    vscode.workspace.workspaceFolders = [{}];
    await openFlotillaSettings();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.openWorkspaceSettings', { query: FLOTILLA_SETTINGS_QUERY });
  });

  it('opens the User settings without a folder', async () => {
    vscode.workspace.workspaceFolders = undefined;
    await openFlotillaSettings();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.openSettings', { query: FLOTILLA_SETTINGS_QUERY });
  });

  it('filters to this extension', () => {
    expect(FLOTILLA_SETTINGS_QUERY).toBe(`@ext:${pkg.publisher}.${pkg.name}`);
  });

  it("is a gear in the Flotilla view's title bar, with Integrations in its … menu", () => {
    const command = pkg.contributes.commands.find((c: { command: string }) => c.command === 'flotilla.openSettings');
    expect(command).toMatchObject({ title: 'Flotilla Settings…', icon: '$(gear)' });
    const title = pkg.contributes.menus['view/title'].filter((m: { when: string }) => m.when.startsWith('view == flotilla.sidebar'));
    expect(title.find((m: { command: string }) => m.command === 'flotilla.openSettings').group).toMatch(/^navigation@/);
    expect(title.some((m: { command: string }) => m.command === 'flotilla.backlogIntegrations')).toBe(true);
  });

  it('groups every Flotilla setting into one of six titled sections, in order', () => {
    const sections: { title: string; order: number; properties: Record<string, unknown> }[] = pkg.contributes.configuration;
    expect(sections.map((s) => s.title)).toEqual(['Worktrees', 'Backlog & Tickets', 'Agents', 'Autopilot', 'Review & Merge', 'CI & Notifications']);
    expect(sections.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6]);
    const keys = sections.flatMap((s) => Object.keys(s.properties));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => k.startsWith('flotilla.'))).toBe(true);
    const autopilot = Object.keys(sections[3].properties);
    expect(autopilot).toEqual(expect.arrayContaining(['flotilla.agents.maxRunning', 'flotilla.agents.maxPrioritized']));
  });

  it('leads from the backlog settings to Integrations', () => {
    const backlog = pkg.contributes.configuration[1].properties;
    expect(backlog['flotilla.backlog.idPrefix'].markdownDescription).toContain('(command:flotilla.backlogIntegrations)');
  });
});

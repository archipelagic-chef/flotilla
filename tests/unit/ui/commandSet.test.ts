import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Whatever a module touches of vscode (or of a feature's deps) at registration is a stub; registerCommand notes the id.
const registered: string[] = [];
function stub(): any {
  const fn = function () {};
  return new Proxy(fn, {
    get: (_t, key) => (key === 'then' ? undefined : key === Symbol.toPrimitive ? () => '' : stub()),
    apply: () => stub(),
    construct: () => stub(),
  });
}
vi.mock('vscode', () => {
  const vscode = stub();
  return new Proxy(
    {},
    {
      has: () => true,
      get: (_t, key) =>
        key === 'commands'
          ? { registerCommand: (id: string) => (registered.push(id), { dispose() {} }), executeCommand: () => Promise.resolve() }
          : key === 'Uri'
            ? class {}
            : key === 'env'
              ? { remoteName: undefined }
              : vscode[key as string],
    },
  );
});
const { joinCommands, registerAll } = await import('../../../src/ui/commandSet');
const { registerCommands } = await import('../../../src/ui/commands');
const { registerSelfUpdate } = await import('../../../src/ui/selfUpdate');
const { registerFileCommands } = await import('../../../src/ui/sidebar/fileCommands');
const { mergeCommands } = await import('../../../src/ui/backlog/mergeCommands');
const { agentCommands } = await import('../../../src/ui/backlog/agentCommands');
const { autopilotCommands } = await import('../../../src/ui/backlog/autopilotCommands');
const { metricsCommands } = await import('../../../src/ui/metrics/metricsCommands');
const { viewCommands } = await import('../../../src/ui/sidebar/viewCommands');
const { activeWorktreeCommands } = await import('../../../src/ui/activeWorktreeCommands');
const { hygieneCommands } = await import('../../../src/ui/hygiene');
const { noteCommands } = await import('../../../src/ui/backlog/notes');

const root = path.join(__dirname, '../../..');
/** The features' command lists extension.ts registers (BL-185): a new feature's goes here too. */
const features = { mergeCommands, agentCommands, autopilotCommands, metricsCommands, viewCommands, activeWorktreeCommands, hygieneCommands, noteCommands };

describe('commands', () => {
  it('registers every command of package.json, each once', () => {
    registered.length = 0;
    const subscriptions: { dispose(): unknown }[] = [];
    const extension = { subscriptions, extension: { packageJSON: {} }, extensionPath: root, globalState: stub(), workspaceState: stub(), extensionMode: 1 };
    registerCommands({ ...stub(), extension, service: stub(), repository: stub() });
    registerSelfUpdate(extension as never);
    registerFileCommands(extension as never, stub(), stub(), stub());
    registerAll(subscriptions, joinCommands(...Object.values(features).map((f) => f(stub()))));

    const declared = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { contributes: { commands: { command: string }[] } }).contributes.commands.map((c) => c.command);
    expect(declared.filter((id) => !registered.includes(id))).toEqual([]);
    expect(registered.filter((id, i) => registered.indexOf(id) !== i)).toEqual([]);
  });

  it('extension.ts registers the features’ lists, and no command of its own', () => {
    const source = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
    for (const name of Object.keys(features)) expect(source, name).toMatch(new RegExp(`registerAll\\(context\\.subscriptions, ${name}\\(`));
    expect(source).not.toMatch(/commands\.registerCommand\(/);
  });

  it('refuses an id two features both have', () => {
    expect(() => joinCommands({ 'flotilla.a': () => 1 }, { 'flotilla.a': () => 2 })).toThrow('flotilla.a');
    expect(Object.keys(joinCommands({ 'flotilla.a': () => 1 }, { 'flotilla.b': () => 2 }))).toEqual(['flotilla.a', 'flotilla.b']);
  });
});

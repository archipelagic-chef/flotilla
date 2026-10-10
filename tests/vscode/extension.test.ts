import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('Flotilla smoke test', () => {
  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension('archipelagic.flotilla');
    assert.ok(extension, 'extension not found');
    await extension.activate();
  });

  test('registers its commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    const ids = ['flotilla.newWorkstream', 'flotilla.refresh', 'flotilla.quickSwitch', 'flotilla.remove', 'flotilla.compareWith'];
    ids.push('flotilla.commit', 'flotilla.stage', 'flotilla.unstage', 'flotilla.sync', 'flotilla.publish', 'flotilla.addToWorkspace', 'flotilla.revealInExplorer');
    ids.push('flotilla.newChat', 'flotilla.openChat', 'flotilla.installClaudeHooks', 'flotilla.showFiles', 'flotilla.showChats', 'flotilla.selectWorktree', 'flotilla.showSearch');
    for (const id of ids) {
      assert.ok(commands.includes(id), `missing ${id}`);
    }
  });

  test('opens the sidebar on each tab', async () => {
    for (const id of ['flotilla.showOverview', 'flotilla.showFiles', 'flotilla.showSearch', 'flotilla.showVersionControl', 'flotilla.showChats']) await vscode.commands.executeCommand(id);
    await vscode.commands.executeCommand('flotilla.selectWorktree', 0);
  });

  test('refresh runs without error', async () => {
    await vscode.commands.executeCommand('flotilla.refresh');
  });

  test('serves file content at a ref through the flotilla-git scheme', async () => {
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const uri = vscode.Uri.from({
      scheme: 'flotilla-git',
      path: '/README.md',
      query: JSON.stringify({ worktree: root, ref: 'HEAD', path: 'README.md' }),
    });
    const doc = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(doc.getText(), 'fixture\n');
  });
});

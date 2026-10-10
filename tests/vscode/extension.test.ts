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
    for (const id of ['flotilla.newWorkstream', 'flotilla.refresh', 'flotilla.quickSwitch', 'flotilla.remove', 'flotilla.compareWith']) {
      assert.ok(commands.includes(id), `missing ${id}`);
    }
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

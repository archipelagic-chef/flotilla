import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('Switchyard smoke test', () => {
  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension('archipelagic.switchyard');
    assert.ok(extension, 'extension not found');
    await extension.activate();
  });

  test('registers its commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['switchyard.newWorkstream', 'switchyard.refresh', 'switchyard.quickSwitch', 'switchyard.remove', 'switchyard.compareWith']) {
      assert.ok(commands.includes(id), `missing ${id}`);
    }
  });

  test('refresh runs without error', async () => {
    await vscode.commands.executeCommand('switchyard.refresh');
  });

  test('serves file content at a ref through the switchyard-git scheme', async () => {
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const uri = vscode.Uri.from({
      scheme: 'switchyard-git',
      path: '/README.md',
      query: JSON.stringify({ worktree: root, ref: 'HEAD', path: 'README.md' }),
    });
    const doc = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(doc.getText(), 'fixture\n');
  });
});

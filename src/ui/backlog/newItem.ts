import * as vscode from 'vscode';
import { addItem, currentPrefix, idProblem, ID_PATTERN, nextId } from '../../features/backlog/backlog';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import type { BacklogIntegrations } from './integrations';

/** A prefix alone ("WEB", "WEB-"): the next number for it is meant. */
const PREFIX_ONLY = /^([A-Za-z][A-Za-z0-9]{0,9})-?$/;

/**
 * Adds a backlog item through VS Code's input box (as Create Branch does): its title, with buttons to change its id
 * and to have Claude write it. Its id is the next one for the current prefix; a prefix chosen here becomes the current
 * one. Enter adds it and opens its ticket.
 */
export async function newBacklogItem(backlog: LocalBacklog, integrations: BacklogIntegrations): Promise<void> {
  const setting = () => vscode.workspace.getConfiguration('flotilla').get<string>('backlog.idPrefix', 'BL');
  // Ids of issues from integrations are taken too (they'd link to the same branches).
  const taken = integrations.issues().map((i) => i.id);
  const data = await backlog.read();
  let prefix = currentPrefix(data, setting());
  // Undefined: the next id for the prefix, worked out when it's added.
  let chosenId: string | undefined;
  const idNow = () => chosenId ?? nextId(data, prefix, taken);

  const changeId: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('tag'), tooltip: 'Change Its ID or Prefix…' };
  const withClaude: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('sparkle'), tooltip: 'Add It and Write It with Claude' };
  let title = '';
  for (;;) {
    const box = vscode.window.createInputBox();
    box.title = `New Backlog Item ${idNow()}`;
    box.placeholder = 'Title';
    box.prompt = 'Enter adds it and opens its ticket; the tag button changes its id.';
    box.value = title;
    box.valueSelection = [title.length, title.length];
    box.buttons = [changeId, withClaude];
    box.ignoreFocusOut = true;
    const result = await new Promise<'open' | 'ai' | 'id' | undefined>((resolve) => {
      box.onDidAccept(() => box.value.trim() && resolve('open'));
      box.onDidTriggerButton((b) => {
        if (b === changeId) resolve('id');
        else if (box.value.trim()) resolve('ai');
        else box.validationMessage = 'Give it a title first.';
      });
      box.onDidChangeValue(() => (box.validationMessage = undefined));
      box.onDidHide(() => resolve(undefined));
      box.show();
    });
    title = box.value;
    box.dispose();
    if (!result) return;
    if (result === 'id') {
      const id = await askId(idNow(), (v) => idProblem(data, v, taken));
      if (id) {
        const only = PREFIX_ONLY.exec(id);
        prefix = (only?.[1] ?? ID_PATTERN.exec(id)![1]).toUpperCase();
        chosenId = only ? undefined : id;
      }
      continue;
    }
    let added: string | undefined;
    await backlog.change((d) => {
      const r = addItem(d, title, prefix, new Date(), chosenId ?? nextId(d, prefix, taken));
      added = r.item.id;
      // The prefix chosen stays for the next items (the setting's isn't recorded, so changing it still works).
      return prefix === currentPrefix(d, setting()) ? r.data : { ...r.data, prefix };
    });
    if (!added) return;
    await vscode.commands.executeCommand(result === 'ai' ? 'flotilla.writeBacklogItem' : 'flotilla.openBacklogItem', added);
    return;
  }
}

/** Asks for an id: a full one (WEB-12), or a prefix alone (WEB) for the next number with it. */
async function askId(current: string, problem: (id: string) => string | undefined): Promise<string | undefined> {
  const prefixLength = ID_PATTERN.exec(current)?.[1].length ?? current.length;
  const id = await vscode.window.showInputBox({
    title: 'Backlog Item ID',
    prompt: 'An id like WEB-12, or just a prefix (WEB) for its next number. A new prefix is used for the next items too.',
    value: current,
    valueSelection: [0, prefixLength],
    validateInput: (v) => {
      const t = v.trim();
      if (PREFIX_ONLY.test(t)) return undefined;
      return problem(t.toUpperCase());
    },
  });
  return id?.trim().toUpperCase();
}

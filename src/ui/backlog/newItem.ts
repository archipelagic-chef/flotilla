import * as vscode from 'vscode';
import {
  addItem,
  currentPrefix,
  parseNewItem,
} from '../../features/backlog/backlog';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import type { BacklogIntegrations } from './integrations';

/**
 * Adds a backlog item through VS Code's input box (as Create Branch does). What's typed is its title, optionally
 * after its id ("WEB-12 Fix login") or a prefix for the next number ("WEB- Fix login"); otherwise it gets the next
 * number for the current prefix. A prefix typed here becomes the current one. Enter adds it and opens its ticket; the
 * button adds it and starts a discussion with an agent in its ticket.
 */
export async function newBacklogItem(backlog: LocalBacklog, integrations: BacklogIntegrations): Promise<void> {
  const setting = () => vscode.workspace.getConfiguration('flotilla').get<string>('backlog.idPrefix', 'BL');
  // Ids of issues from integrations are taken too (they'd link to the same branches), and so are the ids of ticket files.
  const taken = [...integrations.issues().map((i) => i.id), ...(await backlog.ticketIds())];
  const data = await backlog.read();
  const prefix = currentPrefix(data, setting());
  const parse = (text: string) => parseNewItem(text, data, prefix, taken);

  const withClaude: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('comment-discussion'), tooltip: 'Add It and Discuss It with an Agent' };
  const box = vscode.window.createInputBox();
  box.placeholder = `Title, or an id and a title: ${prefix}-12 Fix the login`;
  box.buttons = [withClaude];
  box.ignoreFocusOut = true;
  const show = () => {
    const p = parse(box.value);
    box.title = `New Backlog Item ${p.id}`;
    box.validationMessage = p.problem;
    box.prompt = p.chosen
      ? `${p.id}: ${p.title || '…'}`
      : `${p.id}${p.title ? `: ${p.title}` : ''}. Start with an id (${p.prefix}-12) to choose it, or a prefix (WEB-) for its next number.`;
  };
  show();
  const result = await new Promise<'open' | 'ai' | undefined>((resolve) => {
    const submit = (then: 'open' | 'ai') => {
      const p = parse(box.value);
      if (p.problem) return;
      if (!p.title) box.validationMessage = 'Give it a title.';
      else resolve(then);
    };
    box.onDidAccept(() => submit('open'));
    box.onDidTriggerButton(() => submit('ai'));
    box.onDidChangeValue(show);
    box.onDidHide(() => resolve(undefined));
    box.show();
  });
  const typed = box.value;
  box.dispose();
  if (!result) return;

  let added: string | undefined;
  let problem: string | undefined;
  await backlog.change(async (d) => {
    // Read again, with the ticket files as they are now: another window may have added items meanwhile.
    const p = parseNewItem(typed, d, currentPrefix(d, setting()), [...taken, ...(await backlog.ticketIds())]);
    if (p.problem) {
      problem = p.problem;
      return d;
    }
    const r = addItem(d, p.title, p.prefix, new Date(), p.id);
    added = r.item.id;
    // The prefix used stays for the next items (the setting's isn't recorded, so changing it still works).
    return p.prefix === currentPrefix(d, setting()) ? r.data : { ...r.data, prefix: p.prefix };
  });
  if (problem) {
    void vscode.window.showErrorMessage(`Not added: ${problem}`);
    return;
  }
  if (added) await vscode.commands.executeCommand(result === 'ai' ? 'flotilla.discussBacklogItem' : 'flotilla.openBacklogItem', added);
}

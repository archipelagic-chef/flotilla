import * as vscode from 'vscode';
import type { TicketChecker } from './ticketCheck';
import type { TicketPanels } from './ticketPanel';

/**
 * Check All (BL-163): every ticket's Check, and what no ticket's covers (BL-166: merge queue entries of tickets that
 * don't exist, temporary merge worktrees no ticket names). What isn't what it says is listed, for Clean Up All (asking
 * before a process is stopped or a worktree with uncommitted changes removed) or to open the first ticket and clean up
 * there, one at a time.
 */
export async function checkAllTickets(checker: TicketChecker, tickets: Pick<TicketPanels, 'open' | 'check' | 'cleanUp'>): Promise<void> {
  const found = await checker.checkAll();
  const repo = (await checker.checkRepo()).filter((c) => !c.ok);
  const glitched = [...found].map(([id, claims]) => ({ id, bad: claims.filter((c) => !c.ok) })).filter((t) => t.bad.length);
  const claims = [...found.values()].reduce((n, c) => n + c.length, 0);
  if (!glitched.length && !repo.length) {
    void vscode.window.showInformationMessage(
      claims
        ? `Checked ${claims} thing${claims === 1 ? '' : 's'} going on in ${found.size} ticket${found.size === 1 ? '' : 's'}: all as they say.`
        : 'Checked the tickets: none says anything is going on.',
    );
    return;
  }
  const count = glitched.reduce((n, t) => n + t.bad.length, 0) + repo.length;
  const detail = [...glitched.flatMap((t) => t.bad.map((c) => `${t.id}: ✗ ${c.text}`)), ...repo.map((c) => `✗ ${c.text}`)].join('\n');
  const first = glitched[0]?.id;
  const where = [...glitched.map((t) => t.id), ...(repo.length ? ['the merge queue and worktrees'] : [])].join(', ');
  const choice = await vscode.window.showWarningMessage(
    `${count} thing${count === 1 ? '' : 's'} in ${where} ${count === 1 ? "isn't" : "aren't"} what ${count === 1 ? 'it says' : 'they say'}.`,
    { modal: true, detail },
    'Clean Up All',
    ...(first ? [`Open ${first}`] : []),
  );
  if (first && choice === `Open ${first}`) {
    await tickets.open(first);
    await tickets.check(first);
  } else if (choice === 'Clean Up All') {
    for (const t of glitched) await tickets.cleanUp(t.id);
    const notes = await checker.cleanUpRepo({
      confirm: async (question) => (await vscode.window.showWarningMessage(question, { modal: true }, 'Remove')) === 'Remove',
    });
    if (notes.length) void vscode.window.showInformationMessage(notes.map((n) => n.replace(/^Check: /, '')).join(' '));
  }
}

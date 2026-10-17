import * as vscode from 'vscode';
import type { Repository } from '../core/repository';
import type { Leader } from '../features/backlog/leader';
import { agentChatItem } from '../features/backlog/backlog';
import { BIG_CHAT_HINT, formatTokens } from '../features/chats/usage';
import type { Workstream } from '../features/workstreams/workstream';

export interface BigChatsDeps {
  repository: Pick<Repository<Workstream>, 'current' | 'onDidChange'>;
  leader: Pick<Leader, 'isLeader'>;
  /** Shared by the windows: which chats were mentioned, and whether the user wants no more. */
  globalState: vscode.Memento;
}

const SAID = 'flotilla.bigChats.said';
const NEVER = 'flotilla.bigChats.never';

/**
 * Says once per chat when one of the user's own open chats grows past flotilla.chats.bigContext (BL-70): every turn
 * re-reads the whole chat, so a long one costs more with each answer. Flotilla's agents aren't mentioned (their
 * context is kept small when they start); the sidebar marks every big chat.
 */
export class BigChats implements vscode.Disposable {
  private readonly subscription: { dispose(): void };

  constructor(private readonly deps: BigChatsDeps) {
    this.subscription = deps.repository.onDidChange(() => void this.check());
  }

  private async check(): Promise<void> {
    if (!this.deps.leader.isLeader || this.deps.globalState.get<boolean>(NEVER)) return;
    const limit = vscode.workspace.getConfiguration('flotilla').get<number>('chats.bigContext', 200_000);
    if (limit <= 0) return;
    const said = new Set(this.deps.globalState.get<string[]>(SAID, []));
    const chat = this.deps.repository.current
      .flatMap((w) => w.chats)
      .find((c) => c.open && (c.usage?.context ?? 0) >= limit && !said.has(c.id) && !agentChatItem(c.firstPrompt));
    if (!chat) return;
    // The last 200 are kept: enough to never say it twice about a chat still around.
    await this.deps.globalState.update(SAID, [...said, chat.id].slice(-200));
    const choice = await vscode.window.showInformationMessage(
      `The chat "${chat.title}" re-reads ${formatTokens(chat.usage!.context)} tokens on every turn. ${BIG_CHAT_HINT}`,
      'OK',
      "Don't Say Again",
    );
    if (choice === "Don't Say Again") await this.deps.globalState.update(NEVER, true);
  }

  dispose(): void {
    this.subscription.dispose();
  }
}

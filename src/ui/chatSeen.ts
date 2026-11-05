import * as vscode from 'vscode';
import {
  markSeen,
  type SeenRecord,
} from '../features/chats/seen';

const KEY = 'flotilla.chatsSeen';

/** When this window last opened each chat (BL-286), kept in workspace state so it survives reloads. */
export class ChatSeen implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly state: vscode.Memento) {}

  get record(): SeenRecord {
    const kept = this.state.get<SeenRecord>(KEY);
    if (kept && typeof kept.since === 'number' && kept.at) return kept;
    const fresh: SeenRecord = { since: Date.now(), at: {} };
    void this.state.update(KEY, fresh);
    return fresh;
  }

  async mark(id: string, now = Date.now()): Promise<void> {
    await this.state.update(KEY, markSeen(this.record, id, now));
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}

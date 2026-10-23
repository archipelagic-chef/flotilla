import { describe, expect, it, vi } from 'vitest';

const vscode = vi.hoisted(() => ({ commands: { executeCommand: vi.fn(async () => undefined) }, window: { showWarningMessage: vi.fn(async () => undefined) } }));
vi.mock('vscode', () => vscode);
const { attachmentsFolded, keepAttachmentsFolded, keepShowActivity, showActivityKept, TicketPanels } = await import('../../../src/ui/backlog/ticketPanel');

/** A memento as VS Code's global state is: values kept by key, read synchronously. */
function memento(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: <T>(key: string, fallback?: T) => (values.has(key) ? (values.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => void values.set(key, value),
  };
}

describe('the Show activity choice', () => {
  it('is shut until the user opens it', () => {
    expect(showActivityKept(memento() as never)).toBe(false);
  });

  it('is kept for the user once chosen, and shut again when they shut it', async () => {
    const state = memento();
    await keepShowActivity(state as never, true);
    expect(showActivityKept(state as never)).toBe(true);
    await keepShowActivity(state as never, false);
    expect(showActivityKept(state as never)).toBe(false);
  });
});

describe('the Attachments section, folded', () => {
  it('is remembered per ticket', async () => {
    const state = memento();
    expect(attachmentsFolded(state as never, 'BL-1')).toBe(false);
    await keepAttachmentsFolded(state as never, 'BL-1', true);
    await keepAttachmentsFolded(state as never, 'BL-2', true);
    expect(attachmentsFolded(state as never, 'BL-1')).toBe(true);
    await keepAttachmentsFolded(state as never, 'BL-1', false);
    expect(attachmentsFolded(state as never, 'BL-1')).toBe(false);
    expect(attachmentsFolded(state as never, 'BL-2')).toBe(true);
  });
});

/** A tab as the host sees it: what it's sent is recorded. */
function tab() {
  return { webview: { postMessage: vi.fn(async (_message: unknown) => true), cspSource: '', asWebviewUri: (u: unknown) => u }, reveal: vi.fn(), dispose: vi.fn(), onDidDispose: () => ({ dispose: vi.fn() }) };
}

/** Ticket panels over a backlog whose one item's writes fail (or not): only what onMessage needs is there. */
function panelsWith(change: () => Promise<unknown>, o: { workstreams?: unknown[]; activity?: unknown[] } = {}) {
  const none = { dispose: () => undefined };
  const backlog = {
    dir: '/nonexistent/backlog',
    read: async () => ({ items: [{ id: 'BL-1', title: 'A ticket', status: 'doing', created: '' }] }),
    change,
    watch: () => none,
    readTicket: async () => ({ description: '', activity: o.activity ?? [] }),
  };
  const deps = {
    backlog,
    repository: { current: o.workstreams ?? [], onDidChange: () => none },
    integrations: { current: [], issues: () => [], onDidChange: () => none },
    merges: { watch: () => none, get: () => undefined },
    memento: { get: (_key: string, fallback: unknown) => fallback, update: async () => undefined },
  };
  const panels = new TicketPanels(deps as never) as unknown as {
    panels: Map<string, unknown>;
    post: (id: string, panel: unknown) => Promise<void>;
    postView: (id: string, panel: unknown) => Promise<void>;
    onMessage: (id: string, panel: unknown, m: unknown) => Promise<void>;
  };
  // The view itself isn't under test here: posting it is stubbed.
  panels.post = vi.fn(async () => undefined);
  return panels;
}

describe("the host's done for an action", () => {
  it('ends a failed action: done with failed, after the view is posted', async () => {
    const panels = panelsWith(async () => {
      throw new Error('disk full');
    });
    const t = tab();
    panels.panels.set('BL-1', t);
    const message = { type: 'status', status: 'done' };
    await expect(panels.onMessage('BL-1', t, message)).rejects.toThrow('disk full');
    expect(panels.post).toHaveBeenCalledWith('BL-1', t);
    expect(t.webview.postMessage).toHaveBeenCalledWith({ type: 'done', message, failed: true });
  });

  it('ends an action that worked: done, not failed', async () => {
    const panels = panelsWith(async () => undefined);
    const t = tab();
    panels.panels.set('BL-1', t);
    const message = { type: 'priority', priority: 'high' };
    await panels.onMessage('BL-1', t, message);
    expect(t.webview.postMessage).toHaveBeenCalledWith({ type: 'done', message, failed: false });
  });

  it('is sent once the posts running for the tab are done: a newer post carries what a superseded one would have', async () => {
    const panels = panelsWith(async () => undefined);
    const t = tab();
    panels.panels.set('BL-1', t);
    // The real post (postView, which builds the view, is stubbed to take time and to start a newer post meanwhile).
    panels.post = (id, panel) => (TicketPanels.prototype as unknown as { post: typeof panels.post }).post.call(panels, id, panel);
    const sent: string[] = [];
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let calls = 0;
    panels.postView = vi.fn(async () => {
      if (++calls === 1) {
        // The action's own post: the watcher's post starts while it runs, and the action's is superseded (sends nothing).
        void panels.post('BL-1', t);
        await delay(10);
        sent.push('own');
        return;
      }
      await delay(40);
      sent.push('newer');
    });
    t.webview.postMessage.mockImplementation(async (m: unknown) => {
      if ((m as { type: string }).type === 'done') sent.push('done');
      return true;
    });
    await panels.onMessage('BL-1', t, { type: 'priority', priority: 'high' });
    expect(sent).toEqual(['own', 'newer', 'done']);
  });

  it('is not sent for ready, which only asks for the view', async () => {
    const panels = panelsWith(async () => undefined);
    const t = tab();
    panels.panels.set('BL-1', t);
    await panels.onMessage('BL-1', t, { type: 'ready' });
    expect(panels.post).toHaveBeenCalledWith('BL-1', t);
    expect(t.webview.postMessage).not.toHaveBeenCalled();
  });

  it('is not sent to a tab that was closed meanwhile (nothing to show there)', async () => {
    const panels = panelsWith(async () => {
      throw new Error('disk full');
    });
    const t = tab();
    // Not in the panels: the tab was closed while the action ran.
    await expect(panels.onMessage('BL-1', t, { type: 'status', status: 'done' })).rejects.toThrow('disk full');
    expect(panels.post).not.toHaveBeenCalled();
    expect(t.webview.postMessage).not.toHaveBeenCalled();
  });
});

describe('Open Chat (BL-131)', () => {
  const at = new Date('2026-10-18T21:46:00Z');
  /** A worktree whose branch doesn't name the ticket, with the chat of an agent that signed one of its entries. */
  const elsewhere = {
    key: '/repo/.git/worktrees/feedback',
    worktree: { branch: 'feature/update-from-main-feedback', path: '/repo/.worktrees/feedback', isMain: false },
    chats: [{ id: 'f545f4ca', title: 'Update from main', state: 'done', agent: 'Byte-2', updatedAt: at, startedAt: at }],
  };
  const signed = [{ date: '2026-10-18 21:40', author: 'Agent Byte-2', body: 'Fixed it.' }];

  it('opens a chat the ticket lists, in a worktree whose branch does not name the ticket', async () => {
    vscode.commands.executeCommand.mockClear();
    const panels = panelsWith(async () => undefined, { workstreams: [elsewhere], activity: signed });
    await panels.onMessage('BL-1', tab(), { type: 'openChat', key: elsewhere.key, id: 'f545f4ca' });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('flotilla.openChat', { key: elsewhere.key, chatId: 'f545f4ca' });
  });

  it("says why it can't open a chat the ticket doesn't list, instead of doing nothing", async () => {
    vscode.commands.executeCommand.mockClear();
    vscode.window.showWarningMessage.mockClear();
    const panels = panelsWith(async () => undefined, { workstreams: [elsewhere], activity: [] });
    await panels.onMessage('BL-1', tab(), { type: 'openChat', key: elsewhere.key, id: 'f545f4ca' });
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("Can't open this chat"));
  });
});

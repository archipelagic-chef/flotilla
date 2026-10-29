import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const vscode = vi.hoisted(() => ({
  commands: { executeCommand: vi.fn(async () => undefined) },
  window: { showWarningMessage: vi.fn(async () => undefined) },
  workspace: { onDidChangeConfiguration: () => ({ dispose() {} }) },
}));
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
  return {
    webview: { postMessage: vi.fn(async (_message: unknown) => true), cspSource: '', asWebviewUri: (u: unknown) => u },
    reveal: vi.fn(),
    dispose: vi.fn(),
    onDidDispose: () => ({ dispose: vi.fn() }),
  };
}

/** Ticket panels over a backlog whose one item's writes fail (or not): only what onMessage needs is there. */
function panelsWith(
  change: () => Promise<unknown>,
  o: { workstreams?: unknown[]; activity?: unknown[]; item?: Record<string, unknown>; deps?: Record<string, unknown> } = {},
) {
  const none = { dispose: () => undefined };
  const backlog = {
    dir: '/nonexistent/backlog',
    read: async () => ({ items: [{ id: 'BL-1', title: 'A ticket', status: 'doing', created: '', ...o.item }] }),
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
    ...o.deps,
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

describe("the status bar's status (BL-231)", () => {
  it('sets the status of a ticket that is open', async () => {
    const change = vi.fn(async () => undefined);
    const panels = panelsWith(change);
    const t = tab();
    panels.panels.set('BL-1', t);
    vscode.commands.executeCommand.mockClear();
    await panels.onMessage('BL-1', t, { type: 'status', status: 'review' });
    expect(change).toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('flotilla.reopenBacklogItem', expect.anything(), expect.anything());
  });

  it('reopens a discarded ticket into the status picked, as Reopen does', async () => {
    const change = vi.fn(async () => undefined);
    const panels = panelsWith(change, { item: { discarded: { at: '2026-10-28T06:40:00Z' } } });
    const t = tab();
    panels.panels.set('BL-1', t);
    vscode.commands.executeCommand.mockClear();
    await panels.onMessage('BL-1', t, { type: 'status', status: 'review' });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('flotilla.reopenBacklogItem', 'BL-1', 'review');
    // The command writes it: nothing is set here.
    expect(change).not.toHaveBeenCalled();
  });
});

describe('the buttons that wait on the host (BL-118)', () => {
  /** What the handlers call: every method of it fails. */
  const fail = async () => Promise.reject(new Error('it broke'));
  const failing = () => new Proxy({}, { get: () => fail });

  it.each([
    { type: 'updateFromMain' },
    { type: 'mergeCancel' },
    { type: 'mergeResolve' },
    { type: 'mergeRecheck' },
    { type: 'mergeApprove' },
    { type: 'prioritize' },
    { type: 'push' },
    { type: 'accept' },
    { type: 'dismiss' },
    { type: 'mergeSibling' },
    { type: 'dismissUnmerged' },
    { type: 'link' },
    { type: 'unlink', id: 'PROJ-1' },
    { type: 'agentModel', model: 'opus' },
    { type: 'agentEffort', effort: 'high' },
  ])('$type gets its done, also when its work throws', async (message) => {
    const panels = panelsWith(async () => Promise.reject(new Error('it broke'))) as ReturnType<typeof panelsWith> & Record<string, unknown>;
    Object.assign(panels, { merger: failing(), mainSync: failing(), reviews: failing(), mergeSibling: fail, dismissUnmerged: fail });
    const t = tab();
    panels.panels.set('BL-1', t);
    // Commands (Link Issue's) fail too.
    if (message.type === 'link') vscode.commands.executeCommand.mockRejectedValueOnce(new Error('it broke'));
    // Dismiss returns early (the item isn't a proposal): done all the same, not failed.
    const threw = await panels.onMessage('BL-1', t, message).then(
      () => false,
      () => true,
    );
    expect(threw).toBe(message.type !== 'dismiss');
    expect(t.webview.postMessage).toHaveBeenCalledWith({ type: 'done', message, failed: threw });
  });

  it.each([{ type: 'askNew' }, { type: 'askStop' }, { type: 'askPost', index: 0 }])(
    "the Ask chat's $type gets its done, also after a throw",
    async (message) => {
      const panels = panelsWith(async () => undefined) as unknown as {
        panels: Map<string, unknown>;
        asks: Map<string, unknown>;
        onAskMessage: (id: string, panel: unknown, m: unknown) => Promise<void>;
      };
      const t = tab();
      panels.panels.set('BL-1', t);
      panels.asks.set('BL-1', { reset: () => undefined, stop: () => undefined, answered: () => undefined });
      await panels.onAskMessage('BL-1', t, message);
      expect(t.webview.postMessage).toHaveBeenCalledWith({ type: 'done', message, failed: false });
      t.webview.postMessage.mockClear();
      const broke = () => {
        throw new Error('it broke');
      };
      panels.asks.set('BL-1', { reset: broke, stop: broke, answered: broke });
      await expect(panels.onAskMessage('BL-1', t, message)).rejects.toThrow('it broke');
      expect(t.webview.postMessage).toHaveBeenCalledWith({ type: 'done', message, failed: true });
    },
  );
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

describe('Expand in Changes (BL-171)', () => {
  const ws = { key: '/repo/.git/worktrees/bl-1', worktree: { branch: 'feature/BL-1-a-ticket', path: '/repo/.worktrees/bl-1', isMain: false } };
  const file = { path: 'src/reload.js', kind: 'modified', added: 4, deleted: 1 };
  const change = {
    stage: 'In progress',
    files: 1,
    added: 4,
    deleted: 1,
    groups: [{ label: 'feature/BL-1-a-ticket', dir: ws.worktree.path, left: 'main', right: 'WORKING', compared: '', files: [file] }],
  };
  const commits = [{ hash: 'b'.repeat(40), short: 'bbbbbbb', subject: 'Second', author: 'A', date: '2026-10-25T10:00:00Z', branches: [] }];
  function expandable() {
    const showTicketChanges = vi.fn(async () => undefined);
    const panels = panelsWith(async () => undefined, { workstreams: [ws], deps: { showTicketChanges } }) as ReturnType<typeof panelsWith> & {
      changesShown: () => Promise<unknown>;
      work: () => Promise<unknown>;
      ticketVc: (id: string) => Promise<unknown>;
    };
    panels.changesShown = async () => change;
    panels.work = async () => ({ commits });
    return { panels, showTicketChanges };
  }

  it("opens the sidebar's Version Control on the ticket's Changes in the file's worktree, that file selected", async () => {
    const { panels, showTicketChanges } = expandable();
    await panels.onMessage('BL-1', tab(), { type: 'expandChange', group: 0, path: 'src/reload.js' });
    expect(showTicketChanges).toHaveBeenCalledWith(ws.key, 'BL-1', 'src/reload.js');
  });

  it('does nothing for a file the Changes no longer list', async () => {
    const { panels, showTicketChanges } = expandable();
    await panels.onMessage('BL-1', tab(), { type: 'expandChange', group: 0, path: 'src/gone.js' });
    expect(showTicketChanges).not.toHaveBeenCalled();
  });

  it("shows the whole diff in the ticket's tab of a file picked in Version Control", async () => {
    const { panels } = expandable();
    const t = tab();
    panels.panels.set('BL-1', t);
    await (panels as unknown as { openTicketChange: (id: string, group: number, path: string) => Promise<void> }).openTicketChange('BL-1', 0, 'src/reload.js');
    expect(t.reveal).toHaveBeenCalled();
    expect(t.webview.postMessage).toHaveBeenCalledWith({ type: 'showFull', group: 0, path: 'src/reload.js' });
  });

  it("gives Version Control the ticket's title, Changes and commits", async () => {
    const { panels } = expandable();
    expect(await panels.ticketVc('BL-1')).toEqual({ id: 'BL-1', title: 'A ticket', change, commits });
    expect(await panels.ticketVc('BL-404')).toBeUndefined();
  });
});

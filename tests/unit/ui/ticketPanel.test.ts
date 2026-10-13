import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));
const { keepShowActivity, showActivityKept, TicketPanels } = await import('../../../src/ui/backlog/ticketPanel');

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

/** A tab as the host sees it: what it's sent is recorded. */
function tab() {
  return { webview: { postMessage: vi.fn(async () => true), cspSource: '', asWebviewUri: (u: unknown) => u }, reveal: vi.fn(), dispose: vi.fn(), onDidDispose: () => ({ dispose: vi.fn() }) };
}

/** Ticket panels over a backlog whose one item's writes fail (or not): only what onMessage needs is there. */
function panelsWith(change: () => Promise<unknown>) {
  const none = { dispose: () => undefined };
  const backlog = {
    dir: '/nonexistent/backlog',
    read: async () => ({ items: [{ id: 'BL-1', title: 'A ticket', status: 'doing', created: '' }] }),
    change,
    watch: () => none,
  };
  const deps = {
    backlog,
    repository: { current: [], onDidChange: () => none },
    integrations: { current: [], issues: () => [], onDidChange: () => none },
    memento: { get: (_key: string, fallback: unknown) => fallback, update: async () => undefined },
  };
  const panels = new TicketPanels(deps as never) as unknown as {
    panels: Map<string, unknown>;
    post: (id: string, panel: unknown) => Promise<void>;
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

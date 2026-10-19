import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TicketCi } from '../../../../src/ui/backlog/ticketCi';
import type { CiRuns } from '../../../../src/ui/ci/ciRuns';
import type { CiView } from '../../../../src/webview/protocol';

vi.mock('vscode', () => ({}));

const runs: CiView = { kind: 'runs', repo: 'acme/app', branch: 'feat', runs: [], deployments: [] };

/** The CI/CD view's reader, as the tickets use it. */
function reader(views: Record<string, CiView> = { a: runs }) {
  let listener: ((views: Record<string, CiView>) => void) | undefined;
  const ci = {
    watch: vi.fn(),
    unwatch: vi.fn(),
    snapshot: () => views,
    onDidChange: (l: typeof listener) => ((listener = l), { dispose: () => (listener = undefined) }),
    expand: vi.fn(async () => {}),
    act: vi.fn(async () => {}),
    fix: vi.fn(async () => {}),
    showLog: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    signIn: vi.fn(async () => {}),
  };
  return { ci, change: (next: Record<string, CiView>) => listener?.(next) };
}

function panel(visible = true) {
  let onState: (() => void) | undefined;
  const p = {
    visible,
    webview: { postMessage: vi.fn(async (_message: unknown) => true) },
    onDidChangeViewState: (l: () => void) => ((onState = l), { dispose: () => {} }),
  };
  return { p, setVisible: (v: boolean) => ((p.visible = v), onState?.()) };
}

function memento() {
  const data = new Map<string, unknown>();
  return { get: <T>(key: string, fallback: T) => (data.has(key) ? (data.get(key) as T) : fallback), update: async (key: string, value: unknown) => void data.set(key, value) };
}

let r: ReturnType<typeof reader>;
let tickets: TicketCi;
const showCi = vi.fn();
beforeEach(() => {
  r = reader();
  showCi.mockReset();
  tickets = new TicketCi({ ci: r.ci as unknown as CiRuns, showCi, memento: memento() as never, mainRoot: '/repo' });
});

const sent = (p: ReturnType<typeof panel>['p']) => p.webview.postMessage.mock.calls.map(([m]) => m);

describe('TicketCi: a ticket shows its worktrees\' CI (BL-106)', () => {
  it('watches its worktrees while its tab is visible, and sends their views, closed at first', () => {
    const { p, setVisible } = panel();
    tickets.open('BL-1', p as never);
    tickets.setWorktrees('BL-1', [{ key: 'a', branch: 'feat' }]);

    expect(r.ci.watch).toHaveBeenLastCalledWith('BL-1', ['a']);
    expect(sent(p)).toEqual([{ type: 'ci', ci: { open: false, worktrees: [{ key: 'a', branch: 'feat', view: runs }] } }]);
    setVisible(false);
    expect(r.ci.watch).toHaveBeenLastCalledWith('BL-1', []);
  });

  it('sends a change of its views only, and stops watching when the tab is closed', () => {
    const { p } = panel();
    const opened = tickets.open('BL-1', p as never);
    tickets.setWorktrees('BL-1', [{ key: 'a', branch: 'feat' }]);
    r.change({ a: runs, other: { kind: 'unpublished' } });
    expect(sent(p)).toHaveLength(1);
    r.change({ a: { kind: 'signIn' } });
    expect(sent(p)).toHaveLength(2);

    opened.dispose();
    expect(r.ci.unwatch).toHaveBeenCalledWith('BL-1');
  });

  it('keeps it open per ticket, and sends it open again', async () => {
    const { p } = panel();
    tickets.open('BL-1', p as never);
    tickets.setWorktrees('BL-1', [{ key: 'a', branch: 'feat' }]);
    await tickets.handle('BL-1', { type: 'ciOpen', open: true });
    expect(sent(p).at(-1)).toMatchObject({ ci: { open: true } });

    const other = panel();
    tickets.open('BL-2', other.p as never);
    tickets.setWorktrees('BL-2', [{ key: 'a', branch: 'feat' }]);
    expect(sent(other.p).at(-1)).toMatchObject({ ci: { open: false } });
  });

  it("passes the CI/CD view's requests on for its own worktrees only, its expanded runs as its own", async () => {
    const { p } = panel();
    tickets.open('BL-1', p as never);
    tickets.setWorktrees('BL-1', [{ key: 'a', branch: 'feat' }]);
    await tickets.handle('BL-1', { type: 'ci', op: 'expand', key: 'a', runId: 7 });
    await tickets.handle('BL-1', { type: 'ci', op: 'fix', key: 'a', run: 7, job: 9 });
    await tickets.handle('BL-1', { type: 'ci', op: 'act', key: 'elsewhere', run: 7, action: 'cancel' });
    await tickets.handle('BL-1', { type: 'ciShow', key: 'a' });

    expect(r.ci.expand).toHaveBeenCalledWith('a', 7, true, 'BL-1');
    expect(r.ci.fix).toHaveBeenCalledWith('a', 7, 9);
    expect(r.ci.act).not.toHaveBeenCalled();
    expect(showCi).toHaveBeenCalledWith('a');
  });
});

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { TicketCi } from '../../../../src/ui/backlog/ticketCi';
import type { CiRuns } from '../../../../src/ui/ci/ciRuns';
import type { CiView } from '../../../../src/webview/protocol';

const window = vi.hoisted(() => ({ showInformationMessage: vi.fn(), showWarningMessage: vi.fn() }));
vi.mock('vscode', () => ({ window }));

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
    runWorkflow: vi.fn(async (_key: string, start: () => Promise<boolean>, _busy?: string) => start()),
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
  return {
    get: <T>(key: string, fallback: T) => (data.has(key) ? (data.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => void data.set(key, value),
  };
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

describe("TicketCi: a ticket shows its worktrees' CI (BL-106)", () => {
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

describe('TicketCi: Run CI and Run Workflow… from the ticket (BL-222)', () => {
  const run = (status: string) => ({ id: 7, number: 3, workflow: 'CI', status, created: '2026-10-26T07:00:00Z', url: 'https://x' });
  const withRun = (status: string): CiView => ({ ...runs, runs: [run(status)] as never });
  const push = vi.fn();
  const runWorkflow = vi.fn(async () => true);
  function ticketWith(views: Record<string, CiView>) {
    r = reader(views);
    const t = new TicketCi({ ci: r.ci as unknown as CiRuns, showCi, memento: memento() as never, mainRoot: '/repo', push, runWorkflow });
    t.open('BL-1', panel().p as never);
    t.setWorktrees('BL-1', [{ key: 'a', branch: 'feat', ahead: 1 }]);
    return t;
  }
  beforeEach(() => {
    vi.useFakeTimers();
    push.mockReset();
    runWorkflow.mockClear();
    window.showInformationMessage.mockReset();
    window.showWarningMessage.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('pushes the branch, showing it as runCi, and reads the runs again once GitHub lists the new one', async () => {
    const t = ticketWith({ a: { kind: 'unpublished', repo: 'acme/app' } });
    push.mockResolvedValue({ kind: 'pushed', branch: 'feat', commit: 'abc', count: 1 });
    await t.handle('BL-1', { type: 'ci', op: 'runCi', key: 'a' });
    expect(push).toHaveBeenCalledWith('BL-1', 'feat');
    expect(r.ci.runWorkflow).toHaveBeenCalledWith('a', expect.any(Function), 'runCi');
    expect(r.ci.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(r.ci.refresh).toHaveBeenCalledWith(true);
  });

  it("re-runs the latest run when origin has the branch's head, and says so when there's none to re-run", async () => {
    push.mockResolvedValue({ kind: 'up-to-date', branch: 'feat', commit: 'abc' });
    const t = ticketWith({ a: withRun('failure') });
    await t.handle('BL-1', { type: 'ci', op: 'runCi', key: 'a' });
    expect(r.ci.act).toHaveBeenCalledWith('a', 7, 'rerun');

    const running = ticketWith({ a: withRun('running') });
    await running.handle('BL-1', { type: 'ci', op: 'runCi', key: 'a' });
    expect(r.ci.act).not.toHaveBeenCalled();
    expect(window.showInformationMessage).toHaveBeenCalledWith('CI #3 is already running on feat.');

    const none = ticketWith({ a: runs });
    await none.handle('BL-1', { type: 'ci', op: 'runCi', key: 'a' });
    expect(window.showInformationMessage).toHaveBeenLastCalledWith(expect.stringMatching(/no run of it is listed yet/));
  });

  it('says a refused push is explained in the ticket, and re-runs nothing', async () => {
    push.mockResolvedValue({ kind: 'force', branch: 'feat', commit: 'abc', remoteCommit: 'def' });
    const t = ticketWith({ a: withRun('success') });
    await t.handle('BL-1', { type: 'ci', op: 'runCi', key: 'a' });
    expect(r.ci.act).not.toHaveBeenCalled();
    expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringMatching(/Didn't push feat .*the ticket says why/));
  });

  it("runs a workflow by hand on its own worktrees' branches only", async () => {
    const t = ticketWith({ a: runs });
    await t.handle('BL-1', { type: 'ci', op: 'runWorkflow', key: 'other' });
    expect(runWorkflow).not.toHaveBeenCalled();
    await t.handle('BL-1', { type: 'ci', op: 'runWorkflow', key: 'a' });
    expect(r.ci.runWorkflow).toHaveBeenCalledWith('a', expect.any(Function));
    expect(runWorkflow).toHaveBeenCalledWith('a');
  });
});

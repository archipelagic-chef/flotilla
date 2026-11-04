import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

type Finished = { code: number | null; reply?: string; limit?: { kind: string; until: Date } };

const runs = vi.hoisted(() => ({
  started: [] as Array<{ prompt: string; tools?: string[]; choice?: { model?: string; effort?: string }; resolve: (r: Finished) => void }>,
}));

vi.mock('vscode', () => ({
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  window: { showInformationMessage: async () => undefined, showWarningMessage: async () => undefined },
}));
vi.mock('../../../src/ui/progress', () => ({ trackProgress: () => undefined }));
vi.mock('../../../src/ui/backlog/agentRunner', () => ({
  agentChoice: () => ({ effort: 'medium' }),
  validModel: (m?: string) => m,
  runAgentHeadless: (o: { prompt: string; tools?: string[] }) => {
    let resolve!: (r: Finished) => void;
    const done = new Promise<Finished>((r) => (resolve = r));
    runs.started.push({ ...o, resolve });
    return { sessionId: 's', done, stop() {} };
  },
}));

import {
  Scheduler,
  type SchedulerDeps,
} from '../../../src/ui/schedules/scheduler';
import type { AutopilotView } from '../../../src/ui/backlog/autopilot';
import * as vscode from 'vscode';
import { recordRunTicket } from '../../../src/features/schedules/schedule';

const dirs: string[] = [];
afterEach(() => {
  runs.started.length = 0;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Past the scheduler's first two minutes, when it waits for the agents working to be counted. */
const settled = () => new Date(Date.now() + 3 * 60_000);

function setup(files: Record<string, string>, view: Partial<AutopilotView> = {}, contexts?: SchedulerDeps['contexts'], items?: SchedulerDeps['items']) {
  const backlogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flotilla-schedules-'));
  dirs.push(backlogDir);
  fs.mkdirSync(path.join(backlogDir, 'schedules'));
  for (const [n, text] of Object.entries(files)) fs.writeFileSync(path.join(backlogDir, 'schedules', n), text);
  const slots: string[] = [];
  const given: number[] = [];
  const scheduler = new Scheduler({
    backlogDir,
    repository: { current: [] } as never,
    admit: (id) => (slots.push(id), slots.length),
    giveBack: (slot) => void given.push(slot),
    autopilot: () => ({ enabled: false, running: 0, max: 3, waiting: 0, elsewhere: false, ...view }) as AutopilotView,
    isLeader: () => true,
    mainRoot: '/repo',
    output: { appendLine() {} } as never,
    openPage: () => undefined,
    ...(contexts ? { contexts } : {}),
    ...(items ? { items } : {}),
  });
  return { backlogDir, scheduler, slots, given };
}

describe('the scheduler', () => {
  it('starts a due task on a slot, with its tools and model, and saves the reply as its report when it wrote none', async () => {
    // A date after the files are made: a new task's first run is due at once.
    const { backlogDir, scheduler, slots, given } = setup({ 'docs-check.md': '---\nevery: 7 days\nmodel: opus\n---\nCheck the docs.\n' });
    await scheduler.tick(new Date(2030, 0, 7, 9));
    expect(slots).toEqual(['scheduled-docs-check']);
    expect(runs.started).toHaveLength(1);
    expect(runs.started[0].prompt).toContain('Check the docs.');
    expect(runs.started[0].tools).toContain(`Edit(/${path.join(backlogDir, 'inbox')}/docs-check-*.md)`);
    expect(runs.started[0].choice).toEqual({ effort: 'medium', model: 'opus' });
    // Running already: not started again.
    await scheduler.tick(new Date(2030, 0, 7, 9));
    expect(runs.started).toHaveLength(1);

    runs.started[0].resolve({ code: 0, reply: 'All fine.' });
    await vi.waitFor(() => expect(fs.existsSync(path.join(backlogDir, 'schedules', 'docs-check', '2030-01-07.md'))).toBe(true));
    expect(fs.readFileSync(path.join(backlogDir, 'schedules', 'docs-check', '2030-01-07.md'), 'utf8')).toBe('# Docs check 2030-01-07\n\nAll fine.\n');
    expect(given).toEqual([1]);
    expect(scheduler.running('docs-check')).toBe(false);
    // Its report is its last run: not due again until 7 days on.
    await scheduler.tick(new Date(2030, 0, 8, 9));
    expect(runs.started).toHaveLength(1);
  });
  it("gives a task's agent the tools its file allows (BL-264)", async () => {
    const { scheduler } = setup({ 'product-review.md': '---\nevery: 7 days\ntools: Bash(npm run demo:*)\n---\nGo through the journeys.\n' });
    await scheduler.tick(new Date(2030, 0, 7, 9));
    expect(runs.started.at(-1)?.tools).toContain('Bash(npm run demo:*)');
  });

  it("says what's wrong with a file in its .error, and removes it once fixed", async () => {
    const { backlogDir, scheduler } = setup({ 'x.md': '---\nevery: fortnightly\n---\nDo it.\n' });
    await scheduler.tick(settled());
    const error = path.join(backlogDir, 'schedules', 'x.error');
    expect(fs.readFileSync(error, 'utf8')).toMatch(/isn't a schedule/);
    expect(runs.started).toHaveLength(0);
    fs.writeFileSync(path.join(backlogDir, 'schedules', 'x.md'), '---\nevery: 7 days\n---\nDo it.\n');
    await scheduler.tick(settled());
    expect(fs.existsSync(error)).toBe(false);
    expect(runs.started).toHaveLength(1);
  });

  it('leaves proposed tasks, and tasks held by their conditions', async () => {
    const proposed = setup({ 'p.md': '---\nevery: day\nproposed: Nova-1\n---\nDo it.\n' });
    await proposed.scheduler.tick(settled());
    const busy = setup({ 'idle.md': '---\nevery: day\n---\nDo it.\n', 'any.md': '---\nevery: day\nwhen: any\n---\nDo it.\n' }, { running: 2 });
    await busy.scheduler.tick(settled());
    expect(busy.slots).toEqual(['scheduled-any']);
    const paused = setup({ 'any.md': '---\nevery: day\nwhen: any\n---\nDo it.\n' }, { pausedAll: 2 });
    await paused.scheduler.tick(settled());
    expect(runs.started).toHaveLength(1);
  });

  it('shows each task: when it runs next, what a due one waits for, its reports; a proposed one until accepted', async () => {
    const { backlogDir, scheduler } = setup(
      {
        'weekly.md': '---\nevery: Mondays at 06:00\n---\nDo it.\n',
        'due.md': '---\nevery: 7 days\n---\nDo it.\n',
        'wrong.md': '---\nevery: fortnightly\n---\nDo it.\n',
        'offered.md': '---\nevery: day\nproposed: Nova-1\n---\nDo it.\n',
      },
      { running: 1 },
    );
    fs.mkdirSync(path.join(backlogDir, 'schedules', 'weekly'));
    for (const day of ['2029-12-31', '2030-01-07']) fs.writeFileSync(path.join(backlogDir, 'schedules', 'weekly', `${day}.md`), '# Weekly\n');
    const view = await scheduler.view(new Date(2030, 0, 9, 9));
    const byName = Object.fromEntries(view.tasks.map((t) => [t.name, t]));
    expect(byName.weekly).toMatchObject({
      title: 'Weekly',
      schedule: 'Mondays at 06:00, when idle',
      next: new Date(2030, 0, 14, 6).toISOString(),
      reports: ['2030-01-07', '2029-12-31'],
    });
    expect(byName.weekly.due).toBeUndefined();
    expect(byName.due).toMatchObject({ due: true, waits: 'an agent is working', reports: [] });
    expect(byName.wrong).toMatchObject({ error: expect.stringMatching(/isn't a schedule/) });
    expect(byName.offered).toMatchObject({ proposed: 'Nova-1' });
    expect(byName.offered.due).toBeUndefined();
    await scheduler.accept('offered');
    expect((await scheduler.view()).tasks.find((t) => t.name === 'offered')?.proposed).toBeUndefined();
    await scheduler.dismiss('offered');
    expect((await scheduler.view()).tasks.map((t) => t.name)).not.toContain('offered');
    await expect(scheduler.accept('../x')).rejects.toThrow(/Not a scheduled task/);
  });

  it('waits for its first two minutes, so the agents already working are counted (BL-177, BL-263)', async () => {
    const { scheduler } = setup({ 'x.md': '---\nevery: day\nwhen: any\n---\nDo it.\n' });
    await scheduler.tick(new Date());
    expect(runs.started).toHaveLength(0);
    await scheduler.tick(settled());
    expect(runs.started).toHaveLength(1);
  });

  it("doesn't run a paused task on its schedule, and says it's paused; Run Now still runs it (BL-263)", async () => {
    const { scheduler } = setup({ 'p.md': '---\nevery: day\npaused: true\n---\nDo it.\n' });
    await scheduler.tick(settled());
    expect(runs.started).toHaveLength(0);
    const [task] = (await scheduler.view(settled())).tasks;
    expect(task).toMatchObject({ paused: true, reports: [] });
    expect(task.due).toBeUndefined();
    expect(task.next).toBeUndefined();
    expect(await scheduler.runNow('p')).toBeUndefined();
    expect(runs.started).toHaveLength(1);
    expect(await scheduler.runNow('gone')).toMatch(/no task gone/);
  });

  it('pauses and resumes a task in its file, its other lines kept (BL-262)', async () => {
    const { scheduler, backlogDir } = setup({ 'p.md': '---\nevery: day\nwhen: any\n---\nDo it.\n' });
    const file = path.join(backlogDir, 'schedules', 'p.md');
    await scheduler.pause('p', true);
    expect(fs.readFileSync(file, 'utf8')).toBe('---\nevery: day\nwhen: any\npaused: true\n---\nDo it.\n');
    await scheduler.tick(settled());
    expect(runs.started).toHaveLength(0);
    await scheduler.pause('p', false);
    expect(fs.readFileSync(file, 'utf8')).toBe('---\nevery: day\nwhen: any\n---\nDo it.\n');
    await scheduler.tick(settled());
    expect(runs.started).toHaveLength(1);
  });

  it('asks before Run Now during Pause All, and starts only if you say so (BL-262)', async () => {
    const { scheduler } = setup({ 'p.md': '---\nevery: day\n---\nDo it.\n' }, { pausedAll: 2 });
    const ask = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValueOnce(undefined as never);
    expect(await scheduler.runNow('p')).toBe('all agents are paused');
    expect(runs.started).toHaveLength(0);
    expect(ask).toHaveBeenCalledWith(expect.stringMatching(/All agents are paused/), { modal: true }, 'Run Now');
    ask.mockResolvedValueOnce('Run Now' as never);
    expect(await scheduler.runNow('p')).toBeUndefined();
    expect(runs.started).toHaveLength(1);
    ask.mockRestore();
  });

  it('lists the tickets each run proposed, with whether each was accepted, dismissed or is still proposed (BL-262)', async () => {
    const items = async () =>
      [
        { id: 'BL-1', title: 'One', status: 'todo', created: '' },
        { id: 'BL-2', title: 'Two', status: 'todo', created: '', proposed: {} },
      ] as never;
    const { scheduler, backlogDir } = setup({ 'p.md': '---\nevery: day\n---\nDo it.\n' }, {}, undefined, items);
    fs.mkdirSync(path.join(backlogDir, 'schedules', 'p'));
    fs.writeFileSync(path.join(backlogDir, 'schedules', 'p', '2026-11-02.md'), '# Report\n');
    for (const t of [
      { id: 'BL-1', title: 'One' },
      { id: 'BL-2', title: 'Two' },
      { id: 'BL-3', title: 'Three' },
    ])
      await recordRunTicket(backlogDir, 'p', '2026-11-02', t);
    const [task] = (await scheduler.view(settled())).tasks;
    expect(task.reports).toEqual(['2026-11-02']);
    expect(task.proposals).toEqual({
      '2026-11-02': [
        { id: 'BL-1', title: 'One', state: 'accepted' },
        { id: 'BL-2', title: 'Two', state: 'proposed' },
        { id: 'BL-3', title: 'Three', state: 'dismissed' },
      ],
    });
  });

  it('adds what its context: line names to the prompt, after its instructions (BL-263)', async () => {
    const seen: string[] = [];
    const { scheduler } = setup(
      { 'r.md': '---\nevery: day\ncontext: metrics\n---\nReview it.\n', 'u.md': '---\nevery: day\ncontext: nothing\n---\nDo it.\n' },
      undefined,
      {
        metrics: async ({ task }) => (seen.push(task.name), '## The numbers\n\nTABLE'),
      },
    );
    await scheduler.runNow('r');
    expect(seen).toEqual(['r']);
    expect(runs.started[0].prompt).toMatch(/Review it\.[\s\S]*## The numbers\n\nTABLE/);
    // One Flotilla doesn't know: it runs without.
    runs.started[0].resolve({ code: 0 });
    await scheduler.runNow('u');
    expect(runs.started[1].prompt).toContain('Do it.');
  });

  it('writes no report when its run stops on a usage limit, so it runs again once the limit lifts (BL-263)', async () => {
    const { backlogDir, scheduler } = setup({ 'x.md': '---\nevery: 7 days\n---\nDo it.\n' });
    await scheduler.tick(settled());
    runs.started[0].resolve({ code: 1, limit: { kind: 'session', until: new Date(Date.now() + 3600_000) } });
    await vi.waitFor(() => expect(scheduler.running('x')).toBe(false));
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(path.join(backlogDir, 'schedules', 'x'))).toBe(true);
    expect(fs.readdirSync(path.join(backlogDir, 'schedules', 'x'))).toEqual([]);
    await scheduler.tick(settled());
    expect(runs.started).toHaveLength(2);
  });
});

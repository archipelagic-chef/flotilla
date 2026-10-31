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

type Finished = { code: number | null; reply?: string };

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

import { Scheduler } from '../../../src/ui/schedules/scheduler';
import type { AutopilotView } from '../../../src/ui/backlog/autopilot';

const dirs: string[] = [];
afterEach(() => {
  runs.started.length = 0;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(files: Record<string, string>, view: Partial<AutopilotView> = {}) {
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

  it("says what's wrong with a file in its .error, and removes it once fixed", async () => {
    const { backlogDir, scheduler } = setup({ 'x.md': '---\nevery: fortnightly\n---\nDo it.\n' });
    await scheduler.tick();
    const error = path.join(backlogDir, 'schedules', 'x.error');
    expect(fs.readFileSync(error, 'utf8')).toMatch(/isn't a schedule/);
    expect(runs.started).toHaveLength(0);
    fs.writeFileSync(path.join(backlogDir, 'schedules', 'x.md'), '---\nevery: 7 days\n---\nDo it.\n');
    await scheduler.tick();
    expect(fs.existsSync(error)).toBe(false);
    expect(runs.started).toHaveLength(1);
  });

  it('leaves proposed tasks, and tasks held by their conditions', async () => {
    const proposed = setup({ 'p.md': '---\nevery: day\nproposed: Nova-1\n---\nDo it.\n' });
    await proposed.scheduler.tick();
    const busy = setup({ 'idle.md': '---\nevery: day\n---\nDo it.\n', 'any.md': '---\nevery: day\nwhen: any\n---\nDo it.\n' }, { running: 2 });
    await busy.scheduler.tick();
    expect(busy.slots).toEqual(['scheduled-any']);
    const paused = setup({ 'any.md': '---\nevery: day\nwhen: any\n---\nDo it.\n' }, { pausedAll: 2 });
    await paused.scheduler.tick();
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
});

import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  acceptedTask,
  nextRun,
  parseEvery,
  parseOnce,
  parseTask,
  proposedTask,
  type Schedule,
  scheduleText,
  taskBlocked,
  taskDue,
  taskPrompt,
  taskTools,
} from '../../../../src/features/schedules/schedule';

const task = (front: string, body = 'Check the docs.') => `---\n${front}\n---\n${body}\n`;
const local = (s: string) => new Date(s);

describe('parsing a task', () => {
  it('reads every:, when:, model:, effort: and the instructions', () => {
    const t = parseTask('docs-check', task('every: Mondays at 06:00\nwhen: any\nmodel: opus\neffort: high # deep'));
    expect(t).toEqual({
      name: 'docs-check',
      title: 'Docs check',
      schedule: { kind: 'weekly', weekdays: [1], at: 360 },
      when: 'any',
      model: 'opus',
      effort: 'high',
      instructions: 'Check the docs.',
    });
  });

  it('defaults to when: idle, and takes a title', () => {
    const t = parseTask('x', task('every: 7 days\ntitle: Weekly check'));
    expect(t).toMatchObject({ when: 'idle', title: 'Weekly check', schedule: { kind: 'days', days: 7 } });
  });

  it('reads the schedules people write', () => {
    expect(parseEvery('day')).toEqual({ kind: 'days', days: 1 });
    expect(parseEvery('daily at 6:30')).toEqual({ kind: 'days', days: 1, at: 390 });
    expect(parseEvery('2 weeks')).toEqual({ kind: 'days', days: 14 });
    expect(parseEvery('Monday, Thursday 18:00')).toEqual({ kind: 'weekly', weekdays: [1, 4], at: 1080 });
    expect(parseEvery('fri and mon')).toEqual({ kind: 'weekly', weekdays: [1, 5], at: 0 });
    expect(parseOnce('2026-11-07')).toEqual({ kind: 'once', date: '2026-11-07' });
    expect(parseOnce('2026-11-07 at 09:00')).toEqual({ kind: 'once', date: '2026-11-07', at: 540 });
  });

  it('says what is wrong with a file', () => {
    expect(parseTask('x', 'Just text')).toEqual({ error: expect.stringMatching(/no front matter/) });
    expect(parseTask('x', task('when: idle'))).toEqual({ error: expect.stringMatching(/not when it runs/) });
    expect(parseTask('x', task('every: 7 days\nonce: 2026-11-07'))).toEqual({ error: expect.stringMatching(/both/) });
    expect(parseTask('x', task('every: fortnightly'))).toEqual({ error: expect.stringMatching(/isn't a schedule/) });
    expect(parseTask('x', task('every: 0 days'))).toEqual({ error: expect.stringMatching(/never/) });
    expect(parseTask('x', task('every: Monday 25:00'))).toEqual({ error: expect.stringMatching(/time of day/) });
    expect(parseTask('x', task('once: 2026-02-30'))).toEqual({ error: expect.stringMatching(/isn't a date/) });
    expect(parseTask('x', task('every: day\nwhen: sometimes'))).toEqual({ error: expect.stringMatching(/neither idle/) });
    expect(parseTask('x', task('every: day\neffort: huge'))).toEqual({ error: expect.stringMatching(/isn't one of/) });
    expect(parseTask('x', task('every: day', ''))).toEqual({ error: expect.stringMatching(/no instructions/) });
    expect(parseTask('My Task', task('every: day'))).toEqual({ error: expect.stringMatching(/can't be a task's name/) });
  });

  it('says its schedule in words', () => {
    expect(scheduleText({ kind: 'days', days: 7 })).toBe('every 7 days');
    expect(scheduleText({ kind: 'weekly', weekdays: [1, 4], at: 360 })).toBe('Mondays and Thursdays at 06:00');
    expect(scheduleText({ kind: 'once', date: '2026-11-07' })).toBe('once on 2026-11-07');
  });
});

describe('when a task is due', () => {
  const created = local('2026-10-27T10:00:00'); // a Tuesday

  it('every N days: at once the first time, then N days after the last run', () => {
    const s: Schedule = { kind: 'days', days: 7 };
    expect(taskDue(s, { created, now: created })).toBe(true);
    expect(taskDue(s, { last: '2026-10-27', created, now: local('2026-11-02T23:00:00') })).toBe(false);
    expect(taskDue(s, { last: '2026-10-27', created, now: local('2026-11-03T00:00:00') })).toBe(true);
  });

  it('every day at a time: not before that time', () => {
    const s: Schedule = { kind: 'days', days: 1, at: 360 };
    expect(nextRun(s, { created })).toEqual(local('2026-10-28T06:00:00'));
    expect(nextRun(s, { last: '2026-10-28', created })).toEqual(local('2026-10-29T06:00:00'));
  });

  it('weekly: its first time after it was made, then after the last run', () => {
    const s: Schedule = { kind: 'weekly', weekdays: [1], at: 360 };
    expect(nextRun(s, { created })).toEqual(local('2026-11-02T06:00:00'));
    expect(taskDue(s, { created, now: local('2026-11-02T05:59:00') })).toBe(false);
    expect(taskDue(s, { created, now: local('2026-11-02T06:00:00') })).toBe(true);
    // Run Now on the Sunday before: Monday's run still comes.
    expect(nextRun(s, { last: '2026-11-01', created })).toEqual(local('2026-11-02T06:00:00'));
    expect(nextRun(s, { last: '2026-11-02', created })).toEqual(local('2026-11-09T06:00:00'));
  });

  it('a missed run runs once when next free, not once per missed interval', () => {
    const s: Schedule = { kind: 'weekly', weekdays: [1], at: 360 };
    // Last ran 2026-10-05; the window was closed for three Mondays.
    const now = local('2026-10-28T09:00:00');
    expect(taskDue(s, { last: '2026-10-05', created, now })).toBe(true);
    // It runs that day: the next is next Monday's, not the other missed ones.
    expect(taskDue(s, { last: '2026-10-28', created, now })).toBe(false);
    expect(nextRun(s, { last: '2026-10-28', created })).toEqual(local('2026-11-02T06:00:00'));
    const d: Schedule = { kind: 'days', days: 7 };
    expect(nextRun(d, { last: '2026-10-28', created })).toEqual(local('2026-11-04T00:00:00'));
  });

  it('once: on its date, and never after it ran', () => {
    const s: Schedule = { kind: 'once', date: '2026-11-07', at: 540 };
    expect(taskDue(s, { created, now: local('2026-11-07T08:59:00') })).toBe(false);
    expect(taskDue(s, { created, now: local('2026-11-07T09:00:00') })).toBe(true);
    expect(taskDue(s, { created, now: local('2026-11-20T09:00:00') })).toBe(true);
    expect(nextRun(s, { last: '2026-11-07', created })).toBeUndefined();
    expect(taskDue(s, { last: '2026-11-07', created, now: local('2026-11-20T09:00:00') })).toBe(false);
  });
});

describe('what keeps a task from running', () => {
  const free = { running: 0, waiting: 0, enabled: true, idle: 'nothing left in To Do', elsewhere: false };

  it('never in another window, while paused or while a usage limit holds', () => {
    for (const when of ['idle', 'any'] as const) {
      expect(taskBlocked({ ...free, elsewhere: true }, when)).toMatch(/another window/);
      expect(taskBlocked({ ...free, pausedAll: 2 }, when)).toMatch(/paused/);
      expect(taskBlocked({ ...free, waitingUntil: '2026-10-31T23:00Z' }, when)).toMatch(/usage limit/);
    }
  });

  it('idle: waits for agents and the autopilot; any: only for a slot', () => {
    expect(taskBlocked(free)).toBeUndefined();
    expect(taskBlocked({ ...free, running: 1 })).toMatch(/an agent is working/);
    expect(taskBlocked({ ...free, waiting: 1 })).toMatch(/waiting for a slot/);
    expect(taskBlocked({ ...free, idle: undefined })).toMatch(/tickets to start/);
    expect(taskBlocked({ ...free, enabled: false, idle: undefined })).toBeUndefined();
    expect(taskBlocked({ ...free, running: 3, waiting: 1, idle: undefined }, 'any')).toBeUndefined();
  });
});

describe("the task's agent", () => {
  const t = parseTask('docs-check', task('every: 7 days'));
  if ('error' in t) throw new Error(t.error);
  const reportFile = '/b/schedules/docs-check/2026-11-02.md';

  it('may only read, and write its report, its files and its proposals', () => {
    expect(taskTools({ reportFile, inboxDir: '/b/inbox', name: 'docs-check' })).toEqual({
      tools: [
        'Read',
        'Grep',
        'Glob',
        'Edit(//b/schedules/docs-check/2026-11-02.md)',
        'Edit(//b/schedules/docs-check/2026-11-02-*)',
        'Edit(//b/inbox/docs-check-*.md)',
      ],
      offer: ['Write'],
    });
  });

  it('gets its instructions, its earlier reports, and what to write where', () => {
    const p = taskPrompt({
      agent: 'Nova-1',
      task: t,
      day: '2026-11-02',
      reportFile,
      earlier: ['/b/schedules/docs-check/2026-10-26.md'],
      inboxDir: '/b/inbox',
      mainRoot: '/r',
      backlogDir: '/b',
    });
    expect(p).toContain('Check the docs.');
    expect(p).toContain('- /b/schedules/docs-check/2026-10-26.md');
    expect(p).toContain(reportFile);
    expect(p).toContain('/b/inbox/docs-check-2026-11-02-<n>.md');
    expect(p).toContain('Proposed by: docs-check');
    expect(
      taskPrompt({ agent: 'Nova-1', task: t, day: '2026-11-02', reportFile, earlier: [], inboxDir: '/b/inbox', mainRoot: '/r', backlogDir: '/b' }),
    ).toContain('first run');
  });
});

describe('a task proposed through the inbox', () => {
  it('is saved as proposed, and runs once accepted', () => {
    const p = proposedTask(task('schedule: docs-check\nagent: Nova-1\nevery: 7 days'));
    if ('error' in p) throw new Error(p.error);
    expect(p.name).toBe('docs-check');
    expect(p.task.proposed).toBe('Nova-1');
    const accepted = parseTask('docs-check', acceptedTask(p.file));
    expect(accepted).toMatchObject({ schedule: { kind: 'days', days: 7 }, instructions: 'Check the docs.' });
    expect(accepted).not.toHaveProperty('proposed');
  });

  it('says what is wrong with it', () => {
    expect(proposedTask(task('schedule: Bad Name\nevery: day'))).toEqual({ error: expect.stringMatching(/name/) });
    expect(proposedTask(task('schedule: x'))).toEqual({ error: expect.stringMatching(/not when it runs/) });
  });
});

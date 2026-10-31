import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { CiNotifier } from '../../../../src/ui/ci/ciNotifier';
import type {
  CiJob,
  CiRun,
} from '../../../../src/features/ci/githubActions';
import type { FinishedRun } from '../../../../src/features/ci/notify';

const vs = vi.hoisted(() => ({
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  execute: vi.fn(),
  mode: 'failures' as string,
}));

vi.mock('vscode', () => ({
  window: { showWarningMessage: vs.warning, showInformationMessage: vs.info, showErrorMessage: vs.error },
  commands: { executeCommand: vs.execute },
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => (_key === 'ci.notify' ? vs.mode : fallback) }) },
}));

const run = (status: CiRun['status']): CiRun => ({
  id: 9,
  workflow: 'CI',
  number: 42,
  title: 'Fix the parser',
  event: 'push',
  status,
  url: 'https://github.com/acme/app/actions/runs/9',
  sha: 'abc1234',
  attempt: 1,
  created: '2026-10-11T10:00:00Z',
});

const finishedRun = (status: CiRun['status']): FinishedRun => ({ key: 'a', repo: 'acme/app', branch: 'feat/x', run: run(status) });

const failedJob: CiJob = {
  id: 77,
  name: 'test',
  status: 'failure',
  url: 'https://github.com/acme/app/actions/runs/9/job/77',
  steps: [
    { number: 1, name: 'Checkout', status: 'success' },
    { number: 2, name: 'Run tests', status: 'failure' },
  ],
};

/** A GitHub client with one run's jobs and one log. */
function github(jobs: CiJob[] = [failedJob]) {
  return {
    jobs: vi.fn(async () => jobs),
    log: vi.fn(async () => '2026-10-11T10:00:00.0000000Z ##[error]Tests failed\n'),
  };
}

/** A notice whose button is clicked (or not). */
function clicked(button: string | undefined) {
  vs.warning.mockResolvedValue(button);
  vs.info.mockResolvedValue(button);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(opts: { leader?: boolean; client?: ReturnType<typeof github> } = {}) {
  const client = opts.client ?? github();
  const show = vi.fn();
  const notifier = new CiNotifier({
    repository: { current: [{ key: 'a', worktree: { branch: 'feat/x' } }] } as never,
    isLeader: () => opts.leader ?? true,
    show,
    actions: () => client as never,
  });
  return { notifier, show, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  vs.mode = 'failures';
  clicked(undefined);
});

describe('CiNotifier', () => {
  it('shows a failure with Show and Fix with Agent, and only in the leading window', async () => {
    const { notifier } = setup({ leader: false });
    notifier.notify([finishedRun('failure')]);
    expect(vs.warning).not.toHaveBeenCalled();

    const lead = setup({ leader: true });
    lead.notifier.notify([finishedRun('failure')]);
    expect(vs.warning).toHaveBeenCalledWith('CI failed: CI #42 on feat/x.', 'Show', 'Fix with Agent');
  });

  it('starts the agent on the failed job, with its failed steps and its log cleaned', async () => {
    clicked('Fix with Agent');
    const { notifier, client } = setup();
    notifier.notify([finishedRun('failure')]);
    await flush();
    await flush();

    expect(client.jobs).toHaveBeenCalledWith(9);
    expect(client.log).toHaveBeenCalledWith(77);
    expect(vs.execute).toHaveBeenCalledWith('flotilla.ci.fixWithAgent', {
      branch: 'feat/x',
      run: { name: 'CI', url: 'https://github.com/acme/app/actions/runs/9', commit: 'abc1234' },
      job: { name: 'test', url: 'https://github.com/acme/app/actions/runs/9/job/77' },
      failedSteps: ['Run tests'],
      log: 'ERROR: Tests failed\n',
    });
  });

  it('says so, and starts nothing, when no job of the run failed', async () => {
    clicked('Fix with Agent');
    const { notifier } = setup({ client: github([{ ...failedJob, status: 'success' }]) });
    notifier.notify([finishedRun('failure')]);
    await flush();
    await flush();
    expect(vs.execute).not.toHaveBeenCalled();
    expect(vs.warning).toHaveBeenLastCalledWith(expect.stringContaining('No job of CI #42 failed'));
  });

  it("shows a pass only with the all setting, and Show opens the worktree's CI/CD view", async () => {
    const { notifier, show } = setup();
    notifier.notify([finishedRun('success')]);
    expect(vs.info).not.toHaveBeenCalled();

    vs.mode = 'all';
    clicked('Show');
    notifier.notify([finishedRun('success')]);
    expect(vs.info).toHaveBeenCalledWith('CI passed: CI #42 on feat/x.', 'Show');
    await flush();
    expect(show).toHaveBeenCalledWith('a');
  });
});

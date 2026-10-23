import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

let claudePath = '';
vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: (k: string, d: unknown) => (k === 'agents.claudePath' ? claudePath : k === 'agents.lean' ? false : d) }) },
  extensions: { getExtension: () => undefined },
}));

import { addItem, moveItem } from '../../../src/features/backlog/backlog';
import { LocalBacklog } from '../../../src/features/backlog/localBacklog';
import { eventsWritten, readEvents, setEventLog } from '../../../src/features/metrics/events';
import { runAgentHeadless, runUsage } from '../../../src/ui/backlog/agentRunner';
import { initRepo, makeTempDir } from '../../helpers/gitRepo';

const output = { appendLine: () => undefined } as never;

/** A stand-in for claude that prints result and exits with code. */
function fakeClaude(result: object, code = 0): string {
  const file = path.join(makeTempDir(), 'claude');
  fs.writeFileSync(file, `#!/bin/sh\necho '${JSON.stringify(result)}'\nexit ${code}\n`, { mode: 0o755 });
  return file;
}

afterEach(() => setEventLog(undefined));

describe('the events of agents and tickets', () => {
  it("reads a run's tokens and cost from its result", () => {
    const stdout = JSON.stringify({ result: 'ok', total_cost_usd: 0.5, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } });
    expect(runUsage(stdout)).toEqual({ tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 }, costUsd: 0.5 });
    expect(runUsage('not json')).toEqual({});
  });

  it.skipIf(process.platform === 'win32')('records an agent starting and ending, with its role, model, tokens and cost', async () => {
    const dir = makeTempDir();
    setEventLog(dir);
    claudePath = fakeClaude({ result: 'done', total_cost_usd: 0.25, usage: { input_tokens: 10, output_tokens: 20 } });
    const run = runAgentHeadless({ cwd: dir, prompt: 'x', name: 'Nova-7 · BL-1', choice: { model: 'opus' }, output, track: { ticket: 'BL-1', agent: 'Nova-7', role: 'review' } });
    await run.done;
    await eventsWritten();
    const events = await readEvents(dir);
    expect(events.map((e) => e.kind)).toEqual(['agent-started', 'agent-ended']);
    expect(events[0]).toMatchObject({ ticket: 'BL-1', agent: 'Nova-7', data: { role: 'review', model: 'opus', session: run.sessionId } });
    expect(events[1]).toMatchObject({ data: { role: 'review', ok: true, code: 0, costUsd: 0.25, tokens: { input: 10, output: 20, cacheRead: 0, cacheCreation: 0 } } });
  });

  it.skipIf(process.platform === 'win32')('records a usage limit as the limit hit and the agent paused', async () => {
    const dir = makeTempDir();
    setEventLog(dir);
    claudePath = fakeClaude({ is_error: true, result: `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 3600}` }, 1);
    const run = runAgentHeadless({ cwd: dir, prompt: 'x', name: 'Nova-7 · BL-1', output, resume: '3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b', track: { ticket: 'BL-1', agent: 'Nova-7', role: 'work' } });
    await run.done;
    await eventsWritten();
    const events = await readEvents(dir);
    expect(events.map((e) => e.kind)).toEqual(['agent-resumed', 'limit-hit', 'agent-paused']);
    expect(events[2].data).toMatchObject({ reason: 'limit', role: 'work' });
  });

  it('records a ticket moving between lanes, and who moved it', async () => {
    const repo = initRepo();
    const commonDir = path.join(repo, '.git');
    setEventLog(commonDir);
    const store = new LocalBacklog(repo, commonDir);
    const data = await store.change((d) => addItem(d, 'first', 'BL', new Date()).data);
    await store.change((d) => moveItem(d, data.items[0].id, 'doing'), { by: 'Agent Nova-7' });
    await eventsWritten();
    const events = await readEvents(commonDir);
    expect(events).toEqual([expect.objectContaining({ kind: 'ticket-moved', ticket: data.items[0].id, agent: 'Nova-7', data: { from: 'todo', to: 'doing', by: 'Agent Nova-7' } })]);
  });
});

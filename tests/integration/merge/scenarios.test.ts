// The merge flow, end to end, in the sequences that broke (BL-150): each scenario runs a whole sequence of clicks on
// a real repository with scripted agents and checks, and ends with main as expected and the ticket merged (or with one
// button that works), never in a loop. The states and what moves each are in src/features/backlog/mergeStates.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { World } from './harness';

vi.mock('vscode', () => import('./fakeVscode'));
vi.mock('../../../src/ui/backlog/agentRunner', async (importOriginal) => {
  const { fakeRunAgentHeadless } = await import('./harness');
  return { ...(await importOriginal<typeof import('../../../src/ui/backlog/agentRunner')>()), runAgentHeadless: fakeRunAgentHeadless };
});

let world: World | undefined;
afterEach(() => {
  world?.dispose();
  world = undefined;
});

async function start(ids: string[]): Promise<World> {
  world = await World.create(ids);
  return world;
}

/** BL-1's branch conflicts with BL-9's, which main took in after BL-1 branched off. */
async function conflicting(): Promise<World> {
  const w = await start(['BL-1']);
  w.branch('BL-1', { 'a.txt': 'one\n' });
  w.mainMoves('BL-9', { 'a.txt': 'nine\n' });
  w.answer(/has conflicts/, 'Resolve with Agent');
  return w;
}

/** Main's history ends with these merges (main's own first commits before them). */
function expectMainEndsWith(w: World, subjects: RegExp[]): void {
  const log = w.mainLog();
  expect(log.slice(-subjects.length).map((s, i) => subjects[i].test(s) || s)).toEqual(subjects.map(() => true));
}

const MERGED_1 = /^Merge BL-1\b/;

describe('The merge flow, end to end', () => {
  it('a clean branch merges at once', async () => {
    const w = await start(['BL-1']);
    w.branch('BL-1', { 'a.txt': 'one\n' });
    expect(await w.merge('BL-1')).toMatchObject({ status: 'done', actions: [] });
    expectMainEndsWith(w, [/^initial$/, MERGED_1]);
  });

  it('conflicts: Resolve with Agent, then Approve merges', async () => {
    const w = await conflicting();
    w.agents('resolve');
    expect(await w.merge('BL-1')).toMatchObject({ state: 'resolved', next: 'approve', actions: ['cancel', 'approve'] });
    expect(await w.approve('BL-1')).toMatchObject({ status: 'done' });
    expectMainEndsWith(w, [/BL-9/, MERGED_1]);
    expect(w.checkRuns).toBe(1);
  });

  it('an agent that crashes: Resolve with Agent again works', async () => {
    const w = await conflicting();
    w.agents('crash', 'resolve');
    expect(await w.merge('BL-1')).toMatchObject({ state: 'failed', next: 'resolve' });
    expect((await w.next('BL-1')).state).toBe('resolved');
    expect((await w.next('BL-1')).status).toBe('done');
    expectMainEndsWith(w, [/BL-9/, MERGED_1]);
  });

  it('a cancel in the middle: nothing changes, and Merge to main starts over', async () => {
    const w = await conflicting();
    const before = w.mainLog();
    w.agents('later');
    expect(await w.merge('BL-1')).toMatchObject({ state: 'resolving', actions: ['cancel'], next: undefined });
    expect(await w.cancel('BL-1')).toMatchObject({ status: 'review', next: 'merge' });
    expect(w.mainLog()).toEqual(before);
    w.answer(/has conflicts/, 'Resolve with Agent');
    w.agents('resolve');
    expect((await w.next('BL-1')).state).toBe('resolved');
    expect((await w.next('BL-1')).status).toBe('done');
    expectMainEndsWith(w, [/BL-9/, MERGED_1]);
  });

  it('a window reload in the middle: the agent is gone, and Resolve with Agent starts it again', async () => {
    const w = await conflicting();
    w.agents('later');
    await w.merge('BL-1');
    await w.reload();
    expect(await w.snapshot('BL-1')).toMatchObject({ state: 'resolving', actions: ['cancel', 'resolve'], next: 'resolve' });
    w.agents('resolve');
    expect((await w.next('BL-1')).state).toBe('resolved');
    expect((await w.next('BL-1')).status).toBe('done');
    expectMainEndsWith(w, [/BL-9/, MERGED_1]);
  });

  it('checks that fail only with timeouts run again by themselves, and merge', async () => {
    const w = await start(['BL-1']);
    w.branch('BL-1', { 'a.txt': 'one\n' });
    w.checks('timeout', 'pass');
    expect((await w.merge('BL-1')).status).toBe('done');
    expect(w.checkRuns).toBe(2);
    expect(w.started).toEqual([]);
    expectMainEndsWith(w, [/^initial$/, MERGED_1]);
  });

  it('checks that fail once: Run the Checks Again merges', async () => {
    const w = await start(['BL-1']);
    w.branch('BL-1', { 'a.txt': 'one\n' });
    w.checks('fail');
    expect(await w.merge('BL-1')).toMatchObject({ state: 'failed', actions: ['cancel', 'resolve', 'recheck'], next: 'resolve' });
    expect((await w.recheck('BL-1')).status).toBe('done');
    expectMainEndsWith(w, [/^initial$/, MERGED_1]);
  });

  it('checks that keep failing: Fix with Agent commits a fix, Approve Fix merges', async () => {
    const w = await start(['BL-1']);
    w.branch('BL-1', { 'a.txt': 'one\n' });
    w.checks('fail');
    w.agents('fix');
    await w.merge('BL-1');
    expect(await w.next('BL-1')).toMatchObject({ state: 'resolved', next: 'approve' });
    expect((await w.next('BL-1')).status).toBe('done');
    // The fix lands on top of the merge commit.
    expectMainEndsWith(w, [MERGED_1, /^BL-1: Fix the checks/]);
  });

  it('an agent that commits nothing, and the checks still fail: it stays failed, and a fix after it merges', async () => {
    const w = await start(['BL-1']);
    w.branch('BL-1', { 'a.txt': 'one\n' });
    w.checks('fail', 'fail');
    w.agents('nothing', 'fix');
    await w.merge('BL-1');
    expect(await w.next('BL-1')).toMatchObject({ state: 'failed', reason: expect.stringContaining('committed no fix, and the checks still fail'), next: 'resolve' });
    expect((await w.next('BL-1')).state).toBe('resolved');
    expect((await w.next('BL-1')).status).toBe('done');
    expect(w.checkRuns).toBe(3);
  });

  // BL-102 on 2026-10-20 (BL-124): git-heavy tests timed out on a loaded machine, twice; Watt-2 found nothing to fix,
  // and the ticket stayed "failed", offering only another agent that would find the same.
  it('BL-102 as it happened: timeouts twice, an agent with nothing to fix, then the checks pass', async () => {
    const w = await start(['BL-1']);
    w.branch('BL-1', { 'a.txt': 'one\n' });
    w.checks('timeout', 'timeout', 'pass');
    w.agents('nothing');
    expect(await w.merge('BL-1')).toMatchObject({ state: 'failed', next: 'resolve' });
    expect((await w.next('BL-1')).status).toBe('done');
    expect(w.started).toEqual(['nothing']);
    expectMainEndsWith(w, [/^initial$/, MERGED_1]);
  });

  it('two tickets land through the train while a third conflicts; Resolve with Agent lands the third', async () => {
    const w = await start(['BL-1', 'BL-2', 'BL-3']);
    w.branch('BL-1', { 'a.txt': 'one\n' });
    w.branch('BL-2', { 'b.txt': 'two\n' });
    w.branch('BL-3', { 'a.txt': 'three\n' });
    w.agents('resolve');
    await w.step('BL-3', 'Merge All Ready', () => w.merger.mergeAllReady());
    expect((await w.item('BL-1')).status).toBe('done');
    expect((await w.item('BL-2')).status).toBe('done');
    expect(w.merger.queuePlace('BL-3')?.state).toMatch(/^Conflicts with main/);
    expectMainEndsWith(w, [/^initial$/, /^Merge BL-1\b/, /^Merge BL-2\b/]);
    expect(await w.step('BL-3', 'Resolve with Agent (train)', () => w.merger.resolveTrainConflict('BL-3'))).toMatchObject({ state: 'resolved', next: 'approve' });
    expect((await w.approve('BL-3')).status).toBe('done');
    expectMainEndsWith(w, [/^Merge BL-1\b/, /^Merge BL-2\b/, /^Merge BL-3\b/]);
  });

  // Before BL-149, main moving under a merge that waits for approval ended in "main moved … merge again", and the
  // agent's merge again was refused.
  describe('main moves under a merge (BL-149)', () => {
    it('a conflict resolved while main moves: Approve merges it again onto the new main', async () => {
      const w = await conflicting();
      w.agents('later');
      await w.merge('BL-1');
      w.mainMoves('BL-8', { 'c.txt': 'eight\n' });
      expect((await w.agentEnds('BL-1', 'resolve')).state).toBe('resolved');
      expect((await w.next('BL-1')).status).toBe('done');
      expectMainEndsWith(w, [/BL-9/, /BL-8/, MERGED_1]);
    });

    it('approval after main moved merges it again onto the new main, with no agent', async () => {
      const w = await conflicting();
      w.agents('resolve');
      await w.merge('BL-1');
      w.mainMoves('BL-8', { 'c.txt': 'eight\n' });
      expect((await w.approve('BL-1')).status).toBe('done');
      expect(w.started).toEqual(['resolve']);
      expectMainEndsWith(w, [/BL-9/, /BL-8/, MERGED_1]);
    });

    it('an agent that redoes the merge onto the new main, as main moved while it worked: its merge is accepted', async () => {
      const w = await conflicting();
      w.agents('later');
      await w.merge('BL-1');
      w.mainMoves('BL-8', { 'c.txt': 'eight\n' });
      expect(await w.agentEnds('BL-1', 'redoMerge')).toMatchObject({ state: 'resolved', next: 'approve' });
      expect((await w.next('BL-1')).status).toBe('done');
      expectMainEndsWith(w, [/BL-9/, /BL-8/, /^Merge BL-1 again/]);
    });

    // BL-111 on 2026-10-21: resolved at 07:49 against ca9e570; main moved (BL-141); approved at 08:02 and again at
    // 10:44, both "main moved … merge again"; Jet-3 merged again onto the new main at 10:48, which was refused.
    it('BL-111 as it happened: approved twice into "main moved", then the agent\'s merge again', async () => {
      const w = await conflicting();
      w.agents('resolve', 'redoMerge');
      expect((await w.merge('BL-1')).state).toBe('resolved');
      w.mainMoves('BL-141', { 'c.txt': 'BL-141\n' });
      let s = await w.approve('BL-1');
      if (s.status !== 'done') s = await w.approve('BL-1');
      if (s.status !== 'done') s = await w.resolve('BL-1');
      if (s.status !== 'done') s = await w.next('BL-1');
      expect(s.status).toBe('done');
      expectMainEndsWith(w, [/BL-9/, /BL-141/, MERGED_1]);
    });
  });
});

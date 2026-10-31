import {
  describe,
  expect,
  it,
} from 'vitest';
import type { BacklogItem } from '../../../src/features/backlog/backlog';
import {
  type ChatFacts,
  checkChat,
  checkMerge,
  checkReview,
  glitchLine,
  parsePs,
  processOf,
  STUCK_MS,
} from '../../../src/features/backlog/ticketCheck';

const S = '2f6a1c3e-1111-4222-8333-944445555666';
const now = new Date('2026-10-21T16:16:00');
const at = (msAgo: number) => new Date(now.getTime() - msAgo);
const chat = (o: Partial<ChatFacts> = {}): ChatFacts => ({
  session: S,
  agent: 'Orbit-2',
  gitDirs: ['/g'],
  state: 'working',
  lastWrite: at(6 * 60_000),
  runsHere: false,
  ...o,
});

describe('finding the process of a chat', () => {
  const ps = parsePs(
    [
      `  101 /usr/bin/claude -p Review BL-132 --output-format stream-json --resume ${S} --tools Bash`,
      `  102 /bin/bash -c grep -- --resume ${S} log.txt`,
      `  103 node /opt/claude-code/cli.js --session-id ${S}x --name Iris-3`,
    ].join('\n'),
  );

  it('reads ps', () => {
    expect(ps.map((p) => p.pid)).toEqual([101, 102, 103]);
  });

  it('finds the claude process that runs the session (--resume or --session-id)', () => {
    expect(processOf(ps, S)?.pid).toBe(101);
    expect(processOf(parsePs(`7 node /opt/cli.js --session-id ${S} --name Iris-3`), S)?.pid).toBe(7);
  });

  it("doesn't take a shell that only mentions it, or another session, for it", () => {
    expect(
      processOf(
        ps.filter((p) => p.pid !== 101),
        S,
      ),
    ).toBeUndefined();
  });
});

describe("checking a chat that says it's working", () => {
  it('is real while its process runs', () => {
    const c = checkChat(chat({ process: { pid: 4812, args: '' }, lastWrite: at(20_000) }), now);
    expect(c).toMatchObject({ ok: true, text: 'Orbit-2 is working (process 4812, last activity 20 s ago)' });
  });

  it('is real while this window runs it, or it was written just now', () => {
    expect(checkChat(chat({ runsHere: true }), now).ok).toBe(true);
    expect(checkChat(chat({ lastWrite: at(30_000) }), now).ok).toBe(true);
  });

  it('is real while its transcript shows a build running, with no process found', () => {
    expect(checkChat(chat({ busy: true }), now).ok).toBe(true);
  });

  it('is a glitch with no process and nothing written lately: Clean Up marks it done', () => {
    const c = checkChat(chat(), now);
    expect(c.ok).toBe(false);
    expect(c.text).toBe('Orbit-2 shows as working, but no process runs it (its chat was last written at 16:10)');
    expect(c.cleanup).toEqual({ kind: 'chat-done', session: S, gitDirs: ['/g'] });
    expect(c.note).toBe("Check: Orbit-2's chat had ended at 16:10 but showed as working; marked done.");
    expect(c.ask).toBeUndefined();
  });

  it('is stuck when its process runs but writes nothing for long: Clean Up stops it, after asking', () => {
    const c = checkChat(chat({ process: { pid: 4812, args: '' }, lastWrite: at(STUCK_MS + 60_000) }), now);
    expect(c.ok).toBe(false);
    expect(c.cleanup).toMatchObject({ kind: 'stop-process', pid: 4812 });
    expect(c.ask).toContain('Stop its process (4812)?');
  });

  it("isn't stuck while a build runs", () => {
    expect(checkChat(chat({ process: { pid: 4812, args: '' }, lastWrite: at(STUCK_MS + 60_000), busy: true }), now).ok).toBe(true);
  });
});

describe("checking a ticket's review", () => {
  const review = (o: Partial<NonNullable<BacklogItem['review']>>): BacklogItem['review'] => ({
    round: 1,
    reviewer: 'Orbit-2',
    implementer: 'Iris-3',
    state: 'reviewing',
    ...o,
  });

  it('claims nothing when nothing runs', () => {
    expect(checkReview(undefined, { runs: false }, now)).toBeUndefined();
    expect(checkReview(review({ state: 'yours' }), { runs: false }, now)).toBeUndefined();
  });

  it("is real when the loop runs its agent, or the agent's process runs", () => {
    expect(checkReview(review({}), { runs: true }, now)?.ok).toBe(true);
    expect(checkReview(review({}), { runs: false, process: { pid: 9, args: '' } }, now)?.text).toBe('Orbit-2 is reviewing (process 9)');
  });

  it('is a glitch when its reviewer runs nowhere: Review Again offered', () => {
    const c = checkReview(review({}), { runs: false, chat: chat() }, now);
    expect(c).toMatchObject({ ok: false, cleanup: { kind: 'review-lost', phase: 'review' } });
    expect(c?.text).toBe("The ticket says Orbit-2 is reviewing, but it isn't running (its chat was last written at 16:10)");
  });

  it('is a glitch when the implementer runs nowhere', () => {
    expect(checkReview(review({ state: 'revising' }), { runs: false }, now)?.cleanup).toEqual({ kind: 'review-lost', phase: 'work' });
  });

  it("is a glitch when a paused agent's chat is gone", () => {
    const paused = review({ state: 'paused', paused: { phase: 'work', session: S, agent: 'Iris-3', resume: 'working', byUser: 'x' } });
    expect(checkReview(paused, { runs: false, pausedChatExists: true }, now)?.ok).toBe(true);
    expect(checkReview(paused, { runs: false, pausedChatExists: false }, now)?.cleanup).toEqual({ kind: 'paused-gone' });
  });
});

describe('checking a merge in progress', () => {
  const merging = { dir: '/tmp/m', branch: 'feature/x', base: 'main', baseTip: 'abc', state: 'resolving' as const, agent: 'Nova-1', session: S, started: '' };

  it('is real while its agent runs', () => {
    expect(checkMerge(merging, { runs: true, dirExists: true })?.ok).toBe(true);
    expect(checkMerge(merging, { runs: false, dirExists: true, process: { pid: 5, args: '' } })?.ok).toBe(true);
  });

  it('is a glitch when its agent runs nowhere: Resolve with Agent offered', () => {
    expect(checkMerge(merging, { runs: false, dirExists: true })).toMatchObject({ ok: false, cleanup: { kind: 'merge-lost' } });
    // Paused by Pause All (BL-164): it isn't lost.
    expect(checkMerge({ ...merging, paused: 'x' }, { runs: false, dirExists: true })?.ok).toBe(true);
  });

  it('waits for the user when resolved, and is fine without an agent', () => {
    expect(checkMerge({ ...merging, state: 'resolved' }, { runs: false, dirExists: true })?.ok).toBe(true);
  });

  it('is a glitch when its temporary worktree is gone', () => {
    expect(checkMerge({ ...merging, state: 'resolved' }, { runs: false, dirExists: false })?.cleanup).toEqual({ kind: 'merge-gone' });
  });
});

describe('the line a ticket shows when opened', () => {
  it('names the first glitch, and how many more', () => {
    const bad = checkChat(chat(), now);
    expect(glitchLine([{ ok: true, text: 'fine' }])).toBeUndefined();
    expect(glitchLine([bad])).toBe(bad.text);
    expect(glitchLine([bad, { ...bad, key: 'b' }])).toBe(`${bad.text}, and 1 more`);
  });
});

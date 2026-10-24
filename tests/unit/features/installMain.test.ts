import { describe, expect, it } from 'vitest';
import { CANCEL, GO_ON, installMain, noteAction, resumeFromNote, WAIT, type AgentHold, type InstallMainDeps, type InstallNote, type NoteStore } from '../../../src/features/installMain';

const COMMIT = '814b863a17bea13fdad3f27836dc4ec99cbaf033';

function memoryNotes(note?: InstallNote): NoteStore & { note?: InstallNote } {
  const store: NoteStore & { note?: InstallNote } = { note, read: () => store.note, write: (n) => (store.note = n) };
  return store;
}

/** A fake world: agents running, Pause All that pauses them (after `pauseMs`), an installer and a reload. */
function world(o: { running?: string[]; pauseMs?: number; build?: 'ok' | 'fail'; install?: 'ok' | 'fail'; answers?: Array<string | undefined>; hold?: boolean; held?: number } = {}) {
  const log: string[] = [];
  let running = [...(o.running ?? ['Byte-7', 'Nova-2'])];
  const abort = new AbortController();
  const hold: AgentHold = {
    pausedCount: o.held,
    pause: async () => {
      log.push('pause');
      await new Promise((r) => setTimeout(r, o.pauseMs ?? 0));
      const paused = running;
      running = [];
      log.push(`paused ${paused.length}`);
      return { paused, inChats: [] };
    },
    resume: async () => {
      log.push('resume');
      return { resumed: 2, waiting: 0 };
    },
  };
  const answers = [...(o.answers ?? [])];
  const notes = memoryNotes();
  const deps: InstallMainDeps = {
    build: async () => {
      log.push('build');
      return o.build === 'fail' ? undefined : { vsix: '/tmp/x/flotilla.vsix', commit: COMMIT };
    },
    ...(o.hold === false ? {} : { hold }),
    running: () => running,
    install: async () => {
      log.push('install');
      if (o.install === 'fail') throw new Error('no space');
    },
    reload: async () => void log.push('reload'),
    notes,
    step: (t) => log.push(`step: ${t}`),
    ask: async (q) => {
      log.push(`ask: ${q}`);
      return answers.shift();
    },
    signal: abort.signal,
    pauseLimitMs: 20,
    now: () => new Date('2026-10-22T06:00:00Z'),
  };
  return { log, deps, notes, abort };
}

describe('installMain', () => {
  it('builds, then pauses, installs, notes what to resume and reloads', async () => {
    const w = world();
    expect(await installMain(w.deps)).toEqual({ kind: 'reloading', commit: COMMIT, paused: 2 });
    expect(w.log).toEqual([
      'step: Building main…',
      'build',
      'step: Built main (814b863).',
      'step: Pausing 2 agents…',
      'pause',
      'paused 2',
      'step: Installing main (814b863)…',
      'install',
      'step: Reloading…',
      'reload',
    ]);
    expect(w.notes.note).toEqual({ commit: COMMIT, at: '2026-10-22T06:00:00.000Z', paused: 2, resume: true });
  });

  it('pauses and installs nothing when the build fails', async () => {
    const w = world({ build: 'fail' });
    expect(await installMain(w.deps)).toEqual({ kind: 'build-failed' });
    expect(w.log).not.toContain('pause');
    expect(w.log).not.toContain('install');
    expect(w.notes.note).toBeUndefined();
  });

  it('cancelled while building, does nothing more', async () => {
    const w = world();
    w.deps.build = async () => {
      w.abort.abort();
      return undefined;
    };
    expect(await installMain(w.deps)).toEqual({ kind: 'cancelled', resumed: false });
    expect(w.log).not.toContain('pause');
  });

  it('cancelled while pausing, resumes the agents once they have paused, and installs nothing', async () => {
    const w = world({ pauseMs: 30 });
    setTimeout(() => w.abort.abort(), 5);
    expect(await installMain(w.deps)).toEqual({ kind: 'cancelled', resumed: true });
    expect(w.log.slice(-3)).toEqual(['pause', 'paused 2', 'resume']);
    expect(w.log).not.toContain('install');
  });

  it('asks when the agents take longer than the limit to pause: wait goes on waiting', async () => {
    const w = world({ pauseMs: 60, answers: [WAIT, WAIT, WAIT] });
    expect((await installMain(w.deps)).kind).toBe('reloading');
    expect(w.log).toContain("ask: 2 agents haven't paused yet.");
    expect(w.log.indexOf('paused 2')).toBeLessThan(w.log.indexOf('install'));
  });

  it('asked, reloads anyway, or cancels and resumes', async () => {
    const go = world({ pauseMs: 200, answers: [GO_ON] });
    expect((await installMain(go.deps)).kind).toBe('reloading');
    expect(go.log).not.toContain('paused 2');
    const cancel = world({ pauseMs: 60, answers: [CANCEL] });
    expect(await installMain(cancel.deps)).toEqual({ kind: 'cancelled', resumed: true });
    expect(cancel.log).toContain('resume');
    expect(cancel.log).not.toContain('install');
  });

  it('resumes the agents when the install fails', async () => {
    const w = world({ install: 'fail' });
    expect(await installMain(w.deps)).toEqual({ kind: 'failed', error: 'Installing failed: no space', resumed: true });
    expect(w.log.slice(-1)).toEqual(['resume']);
    expect(w.notes.note).toBeUndefined();
  });

  it('with no agents running here, still pauses (other windows run agents too) and lifts that hold after the reload', async () => {
    const idle = world({ running: [] });
    await installMain(idle.deps);
    expect(idle.log).toContain('step: Pausing the agents…');
    expect(idle.notes.note?.resume).toBe(true);
  });

  it("with the user's Pause All already on, or without Pause All, pauses nothing and notes nothing to resume", async () => {
    const held = world({ held: 3 });
    await installMain(held.deps);
    expect(held.log).not.toContain('pause');
    expect(held.notes.note?.resume).toBe(false);
    const without = world({ hold: false });
    await installMain(without.deps);
    expect(without.log).not.toContain('pause');
    expect(without.notes.note?.resume).toBe(false);
  });
});

describe('after the reload', () => {
  const note: InstallNote = { commit: COMMIT, at: '2026-10-22T06:00:00.000Z', paused: 2, resume: true };
  const hold = (log: string[]): AgentHold => ({
    pausedCount: 2,
    pause: async () => ({ paused: [], inChats: [] }),
    resume: async () => (log.push('resume'), { resumed: 2, waiting: 1 }),
  });

  it('the new build resumes the agents and takes the note, so no other window resumes them again', async () => {
    const log: string[] = [];
    const notes = memoryNotes(note);
    expect(await resumeFromNote(notes, COMMIT, hold(log))).toBe('Resumed 2 agents; 1 waits for a slot on the new build (814b863).');
    expect(log).toEqual(['resume']);
    expect(notes.note?.resume).toBe(false);
    expect(await resumeFromNote(notes, COMMIT, hold(log))).toBeUndefined();
    expect(log).toEqual(['resume']);
  });

  it('another build than the one installed says so, and still resumes', async () => {
    const log: string[] = [];
    const said = await resumeFromNote(memoryNotes(note), 'aaaaaaa1111', hold(log));
    expect(said).toContain("isn't the one running: the install may have failed (this is aaaaaaa)");
    expect(log).toEqual(['resume']);
  });

  it('a window started after the install resumes; one started before reloads to run the new build', () => {
    const after = new Date('2026-10-22T06:00:05Z');
    const before = new Date('2026-10-22T05:00:00Z');
    expect(noteAction(note, COMMIT, after)).toEqual({ kind: 'resume', note, expected: true });
    expect(noteAction(note, 'old', before)).toEqual({ kind: 'reload', note });
    expect(noteAction(note, COMMIT, before)).toEqual({ kind: 'resume', note, expected: true });
    expect(noteAction({ ...note, resume: false }, COMMIT, after)).toEqual({ kind: 'none' });
    expect(noteAction(undefined, COMMIT, after)).toEqual({ kind: 'none' });
  });
});

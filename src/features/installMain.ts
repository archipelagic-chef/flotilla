/**
 * "Install Main and Reload" (BL-161): main is built, then the agents are paused (BL-160's Pause All), the build is
 * installed, a note saying what to resume is saved, and the window reloads; the new build resumes the agents from the
 * note when it activates. The steps, with what they act on passed in, so they're tested without VS Code.
 */

/** What Pause All and Resume All do (BL-160's PauseAll). */
export interface AgentHold {
  pause(): Promise<{ paused: readonly unknown[]; inChats: readonly unknown[] }>;
  resume(): Promise<{ resumed: number; waiting: number }>;
}

/** The note saved before the reload (.git/flotilla/install-main.json): the build installed, and whether to resume. */
export interface InstallNote {
  /** The commit the installed build is from. */
  commit: string;
  /** When it was installed (ISO): windows started before it run the old build. */
  at: string;
  /** How many agents Pause All paused for it; the window that takes the note resumes them. */
  paused: number;
  /** Resume All is still to run (the first window to activate takes it). */
  resume: boolean;
}

/** Where the note's kept: read, written, removed. */
export interface NoteStore {
  read(): InstallNote | undefined;
  write(note: InstallNote): void;
}

export interface InstallMainDeps {
  /** Builds main; the .vsix and the commit it's from, or undefined when it failed (its output says why). */
  build(signal: AbortSignal): Promise<{ vsix: string; commit: string } | undefined>;
  /** Pause All, when it's there (BL-160). Without it, running agents are stopped by the reload. */
  hold?: AgentHold;
  /** Names of the agents running now. */
  running(): readonly string[];
  install(vsix: string): Promise<void>;
  reload(): Promise<void>;
  notes: NoteStore;
  /** Says the step the command is on ("Pausing 4 agents…"). */
  step(text: string): void;
  /** Asks, with choices; undefined when dismissed. */
  ask(question: string, choices: readonly string[]): Promise<string | undefined>;
  signal: AbortSignal;
  /** How long Pause All has before the command asks (ms). */
  pauseLimitMs?: number;
  now?(): Date;
}

/** How it ended: reloading, or why not. */
export type InstallMainResult =
  | { kind: 'reloading'; commit: string; paused: number }
  | { kind: 'build-failed' }
  | { kind: 'cancelled'; resumed: boolean }
  | { kind: 'failed'; error: string; resumed: boolean };

export const PAUSE_LIMIT_MS = 120_000;

export const WAIT = 'Wait';
export const GO_ON = 'Reload Anyway';
export const CANCEL = 'Cancel';

/** "1 agent" / "4 agents". */
export function agentsCount(n: number): string {
  return `${n} agent${n === 1 ? '' : 's'}`;
}

/** Builds, pauses, installs, notes and reloads; cancelled before the install, it leaves things as they were. */
export async function installMain(d: InstallMainDeps): Promise<InstallMainResult> {
  d.step('Building main…');
  const built = await d.build(d.signal).catch(() => undefined);
  if (d.signal.aborted) return { kind: 'cancelled', resumed: false };
  if (!built) return { kind: 'build-failed' };
  const short = built.commit.slice(0, 7);
  d.step(`Built main (${short}).`);

  let paused = 0;
  const hold = d.hold;
  const running = d.running().length;
  if (hold && running > 0) {
    d.step(`Pausing ${agentsCount(running)}…`);
    const pausing = hold.pause().then((r) => (paused = r.paused.length));
    const outcome = await settle(pausing, d);
    if (outcome === 'cancel') {
      // Cancelled while they pause: once they have, they go on as they were.
      await pausing.catch(() => undefined);
      await hold.resume().catch(() => undefined);
      return { kind: 'cancelled', resumed: true };
    }
    if (outcome instanceof Error) {
      await hold.resume().catch(() => undefined);
      return { kind: 'failed', error: `Pausing the agents failed: ${outcome.message}`, resumed: true };
    }
  }
  if (d.signal.aborted) {
    if (paused) await hold?.resume().catch(() => undefined);
    return { kind: 'cancelled', resumed: paused > 0 };
  }

  d.step(`Installing main (${short})…`);
  try {
    await d.install(built.vsix);
  } catch (e) {
    if (paused) await hold?.resume().catch(() => undefined);
    return { kind: 'failed', error: `Installing failed: ${e instanceof Error ? e.message : String(e)}`, resumed: paused > 0 };
  }
  // Saved before the reload, with the agents still paused: the window that activates first resumes them.
  d.notes.write({ commit: built.commit, at: (d.now?.() ?? new Date()).toISOString(), paused, resume: !!hold && paused > 0 });
  d.step('Reloading…');
  await d.reload();
  return { kind: 'reloading', commit: built.commit, paused };
}

/**
 * Waits for Pause All to be done, asking when it takes longer than the limit: wait on, reload anyway (agents not yet
 * paused are ended by the reload; their chats are kept), or cancel. 'done', 'go' or 'cancel', or the error it failed with.
 */
async function settle(pausing: Promise<unknown>, d: InstallMainDeps): Promise<'done' | 'go' | 'cancel' | Error> {
  const done = pausing.then(
    () => 'done' as const,
    (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  );
  const aborted = new Promise<'cancel'>((resolve) => {
    if (d.signal.aborted) resolve('cancel');
    d.signal.addEventListener('abort', () => resolve('cancel'), { once: true });
  });
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => (timer = setTimeout(() => resolve('late'), d.pauseLimitMs ?? PAUSE_LIMIT_MS)));
    const first = await Promise.race([done, aborted, late]);
    clearTimeout(timer);
    if (first !== 'late') return first;
    const left = d.running().length;
    const pick = await Promise.race([
      d.ask(`${agentsCount(left)} ${left === 1 ? "hasn't" : "haven't"} paused yet.`, [WAIT, GO_ON, CANCEL]),
      done.then(() => 'done' as const),
    ]);
    if (pick === 'done') return done;
    if (pick === GO_ON) return 'go';
    if (pick !== WAIT) return 'cancel';
  }
}

/** What the window does with the note when it activates. */
export type NoteAction =
  /** Nothing to do: no note, or it's taken. */
  | { kind: 'none' }
  /** Resume the agents (and say whether this is the build expected). */
  | { kind: 'resume'; note: InstallNote; expected: boolean }
  /** The window started before that build was installed: it runs the old one, and reloads. */
  | { kind: 'reload'; note: InstallNote };

/**
 * What a window finds in the note: one started before the install runs the old build and reloads; the first to
 * activate after takes the resume (whatever build it runs: a failed install still resumes the agents).
 */
export function noteAction(note: InstallNote | undefined, commit: string | undefined, startedAt: Date): NoteAction {
  if (!note) return { kind: 'none' };
  if (new Date(note.at) > startedAt && note.commit !== commit) return { kind: 'reload', note };
  if (!note.resume) return { kind: 'none' };
  return { kind: 'resume', note, expected: note.commit === commit };
}

/** Takes the resume from the note (written back without it) and resumes; what to say about it. */
export async function resumeFromNote(notes: NoteStore, commit: string | undefined, hold: AgentHold | undefined): Promise<string | undefined> {
  const note = notes.read();
  if (!note?.resume) return undefined;
  notes.write({ ...note, resume: false });
  const short = note.commit.slice(0, 7);
  const expected = note.commit === commit;
  const r = hold ? await hold.resume() : { resumed: 0, waiting: 0 };
  const agents = `Resumed ${agentsCount(r.resumed)}${r.waiting ? `; ${r.waiting} wait${r.waiting === 1 ? 's' : ''} for a slot` : ''}`;
  return expected
    ? `${agents} on the new build (${short}).`
    : `The new build (${short}) isn't the one running: the install may have failed (this is ${commit?.slice(0, 7) ?? 'a build without a commit'}). ${agents}.`;
}

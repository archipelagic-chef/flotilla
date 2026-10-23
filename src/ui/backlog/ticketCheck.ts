import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGit } from '../../core/git/gitCli';
import type { BacklogData, BacklogItem } from '../../features/backlog/backlog';
import { transcriptBusy } from '../../features/backlog/busy';
import { isMergeDir, removeMergeWorktree } from '../../features/backlog/merge';
import { entryDate, type TicketEntry } from '../../features/backlog/ticket';
import {
  checkChat,
  checkMerge,
  checkOrphan,
  checkQueue,
  checkQueueIds,
  checkReview,
  ORPHAN_MS,
  parsePs,
  processOf,
  type ChatFacts,
  type Claim,
  type ProcessInfo,
} from '../../features/backlog/ticketCheck';
import { markChatDone, readChatRecords, readTranscript, transcriptPath } from '../../features/chats/chats';
import { linkedWorktrees } from './cardMenu';

/** What a Check reads and changes (the review loop and the merger, narrowed to what it uses: tests fake them). */
export interface TicketCheckDeps {
  backlog: {
    read(): Promise<BacklogData>;
    appendActivity(item: Pick<BacklogItem, 'id' | 'title' | 'notes'>, entry: TicketEntry): Promise<void>;
  };
  repository: { current: readonly { worktree: { isMain: boolean; path?: string; branch?: string; adminDir: string } }[] };
  reviews?: {
    runsAgentOf(id: string): boolean;
    stopForCheck(id: string, what: 'lost' | 'paused-gone', reason: string): Promise<boolean>;
  };
  merger?: {
    runsMergeOf(id: string): boolean;
    forCheck(id: string, what: 'lost' | 'gone', reason: string): Promise<boolean>;
    /** Rebuilds the merge queue and train as they should be (BL-166); whether it could. */
    rebuildQueue(): Promise<boolean>;
    /** Whether this window runs any merge task now (one may be in a temporary worktree no ticket names yet). */
    busy(): boolean;
  };
  /** The main worktree: where branch tips and the temporary merge worktrees are read (BL-166). None: neither is checked. */
  mainRoot?: string;
  /** The OS's temp folder, the temporary merge worktrees' (tests point it elsewhere). */
  tmpdir?: string;
  /** Whether this window runs a chat (headless, or in a terminal). */
  runsHere(session: string): boolean;
  /** The processes running now (`ps`). */
  processes?: () => Promise<ProcessInfo[]>;
  /** Stops a stuck process. */
  kill?: (pid: number) => void;
  /** How long a record that says working is believed (flotilla.agentStatusStaleMinutes): older ones show as done. */
  staleMinutes: number;
  claudeHome?: string;
  now?: () => Date;
}

/**
 * A ticket's Check (BL-163): each thing it says is going on, against what's really there; and Clean Up of what isn't,
 * each with a note in its activity. A cleanup checks again first, and leaves alone whatever runs by then.
 */
export class TicketChecker {
  constructor(private readonly deps: TicketCheckDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The claims of a ticket, each ✓ or ✗ (none for one that claims nothing, or isn't there). */
  async check(id: string, ps?: ProcessInfo[]): Promise<Claim[]> {
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    return item ? this.checkItem(item, ps ?? (await this.processes())) : [];
  }

  /** Every ticket's claims, of those that claim something (Check All). */
  async checkAll(): Promise<Map<string, Claim[]>> {
    const ps = await this.processes();
    const found = new Map<string, Claim[]>();
    const data = await this.deps.backlog.read();
    for (const item of data.items) {
      if (item.status === 'done' && !item.merging && !item.review && !inQueue(data, item.id)) continue;
      const claims = await this.checkItem(item, ps);
      if (claims.length) found.set(item.id, claims);
    }
    return found;
  }

  /**
   * Cleans up a ticket's glitches (those named by key, or all): checked again first, so only what's still ✗ is
   * touched. `confirm` is asked before a process is stopped; a no leaves it. Returns the notes it left.
   */
  async cleanUp(id: string, o: { keys?: readonly string[]; confirm: (question: string) => Promise<boolean> }): Promise<string[]> {
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    if (!item) return [];
    const glitches = (await this.checkItem(item, await this.processes())).filter((c) => !c.ok && c.cleanup && (!o.keys || o.keys.includes(c.key)));
    const notes: string[] = [];
    for (const g of glitches) {
      if (g.ask && !(await o.confirm(g.ask))) continue;
      if (await this.apply(id, g)) notes.push(g.note ?? g.text);
    }
    if (notes.length) {
      const fresh = (await this.deps.backlog.read()).items.find((i) => i.id === id) ?? item;
      await this.deps.backlog.appendActivity(fresh, { date: entryDate(this.now()), author: 'Flotilla', body: notes.join('\n\n') });
    }
    return notes;
  }

  /**
   * What no ticket's Check covers (BL-166, for Check All): merge queue and train entries of tickets that don't exist,
   * and temporary merge worktrees no ticket's merge names (left by a merge that ended without removing it).
   */
  async checkRepo(): Promise<Claim[]> {
    const data = await this.deps.backlog.read();
    return [...checkQueueIds(data), ...(await this.orphans(data))];
  }

  /** Cleans up what checkRepo finds (checked again first); asks before removing a worktree with uncommitted changes. */
  async cleanUpRepo(o: { confirm: (question: string) => Promise<boolean> }): Promise<string[]> {
    const notes: string[] = [];
    let rebuilt = false;
    for (const g of await this.checkRepo()) {
      if (g.cleanup?.kind === 'queue-rebuild' && rebuilt) {
        notes.push(g.note ?? g.text);
        continue;
      }
      if (g.ask && !(await o.confirm(g.ask))) continue;
      if (await this.apply('', g)) {
        notes.push(g.note ?? g.text);
        rebuilt ||= g.cleanup?.kind === 'queue-rebuild';
      }
    }
    return notes;
  }

  private async apply(id: string, g: Claim): Promise<boolean> {
    const c = g.cleanup!;
    switch (c.kind) {
      case 'stop-process':
        try {
          (this.deps.kill ?? ((pid) => process.kill(pid, 'SIGTERM')))(c.pid);
        } catch {
          // Ended by itself meanwhile: its chat is marked done all the same.
        }
        return this.markDone(c.gitDirs, c.session);
      case 'chat-done':
        return this.markDone(c.gitDirs, c.session);
      case 'review-lost':
        return !!(await this.deps.reviews?.stopForCheck(id, 'lost', g.text));
      case 'paused-gone':
        return !!(await this.deps.reviews?.stopForCheck(id, 'paused-gone', g.text));
      case 'merge-lost':
        return !!(await this.deps.merger?.forCheck(id, 'lost', `${g.text}. Resolve with Agent again, or cancel the merge.`));
      case 'merge-gone':
        return !!(await this.deps.merger?.forCheck(id, 'gone', g.text));
      case 'queue-rebuild':
        return !!(await this.deps.merger?.rebuildQueue());
      case 'orphan-remove':
        if (!this.deps.mainRoot || !isMergeDir(c.dir, this.tmp())) return false;
        return removeMergeWorktree(this.deps.mainRoot, c.dir).then(
          () => true,
          () => false,
        );
    }
  }

  private async markDone(gitDirs: readonly string[], session: string): Promise<boolean> {
    const done = await Promise.all(gitDirs.map((d) => markChatDone(d, session, this.now())));
    return done.some(Boolean);
  }

  private async checkItem(item: BacklogItem, ps: ProcessInfo[]): Promise<Claim[]> {
    const now = this.now();
    const worktrees = linkedWorktrees(item, this.deps.repository.current);
    const chats = await this.workingChats(worktrees.map((w) => ({ gitDir: w.worktree.adminDir, cwd: w.worktree.path! })), ps, now);
    const claims = chats.map((c) => checkChat(c, now));

    const r = item.review;
    const cwd = worktrees[0]?.worktree.path;
    const session = r?.state === 'reviewing' ? r.reviewerSession : r?.state === 'working' || r?.state === 'revising' ? r.implementerSession : undefined;
    const pausedChatExists = r?.state === 'paused' && r.paused && cwd ? fs.existsSync(transcriptPath(cwd, r.paused.session, this.deps.claudeHome)) : undefined;
    const chat = session ? (chats.find((c) => c.session === session) ?? (cwd ? await this.chatFacts(session, cwd, ps) : undefined)) : undefined;
    const review = checkReview(r, { runs: !!this.deps.reviews?.runsAgentOf(item.id), chat, process: session ? processOf(ps, session) : undefined, pausedChatExists }, now);
    if (review) claims.push(review);

    const m = item.merging;
    const merge = m && checkMerge(m, { runs: !!this.deps.merger?.runsMergeOf(item.id), dirExists: fs.existsSync(m.dir), process: m.session ? processOf(ps, m.session) : undefined });
    if (merge) claims.push(merge);

    const data = await this.deps.backlog.read();
    if (inQueue(data, item.id)) {
      const entry = data.mergeTrain?.entries.find((e) => e.id === item.id);
      const queue = checkQueue(item, data, entry ? await this.tipOf(entry.branch) : undefined);
      if (queue) claims.push(queue);
    }
    return claims;
  }

  /** A branch's tip now, in the main worktree; undefined if it's gone (or there's no main worktree to ask). */
  private async tipOf(branch: string): Promise<string | undefined> {
    if (!this.deps.mainRoot) return undefined;
    const tip = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], { cwd: this.deps.mainRoot }).catch(() => '');
    return tip.trim() || undefined;
  }

  private tmp(): string {
    return this.deps.tmpdir ?? os.tmpdir();
  }

  /**
   * The repository's temporary merge worktrees (its own: `git worktree list`, under mergeRoot()) that no ticket's merge
   * names, and that no merge may be running in: none runs in this window, and each was last changed an hour ago or more.
   */
  private async orphans(data: BacklogData): Promise<Claim[]> {
    const root = this.deps.mainRoot;
    if (!root || this.deps.merger?.busy()) return [];
    const out = await runGit(['worktree', 'list', '--porcelain'], { cwd: root }).catch(() => '');
    const named = new Set(data.items.flatMap((i) => (i.merging ? [path.resolve(i.merging.dir)] : [])));
    const now = this.now();
    const claims: Claim[] = [];
    for (const line of out.split('\n')) {
      const dir = line.startsWith('worktree ') ? line.slice('worktree '.length).trim() : '';
      if (!dir || !isMergeDir(dir, this.tmp()) || named.has(path.resolve(dir))) continue;
      const stat = await fs.promises.stat(dir).catch(() => undefined);
      if (!stat || now.getTime() - stat.mtime.getTime() < ORPHAN_MS) continue;
      const status = await runGit(['status', '--porcelain'], { cwd: dir }).catch(() => '?');
      const dirty = status.split('\n').some((l) => l.trim() && !/^\?\? node_modules\/?$/.test(l));
      claims.push(checkOrphan(dir, { dirty, modified: stat.mtime }, now));
    }
    return claims;
  }

  /**
   * The chats of these worktrees whose records say they're working, and show so: those updated lately (older ones
   * show as done already), and those a process or this window runs.
   */
  private async workingChats(worktrees: readonly { gitDir: string; cwd: string }[], ps: ProcessInfo[], now: Date): Promise<ChatFacts[]> {
    const bySession = new Map<string, ChatFacts>();
    for (const w of worktrees) {
      for (const rec of await readChatRecords(w.gitDir)) {
        if (rec.state !== 'working') continue;
        const known = bySession.get(rec.sessionId);
        if (known) {
          known.gitDirs.push(w.gitDir);
          continue;
        }
        const facts = await this.chatFacts(rec.sessionId, rec.cwd ?? w.cwd, ps, rec.updatedAt);
        const shows = now.getTime() - facts.lastWrite.getTime() < this.deps.staleMinutes * 60_000 || facts.process || facts.runsHere;
        if (shows) bySession.set(rec.sessionId, { ...facts, agent: rec.agent ?? facts.agent, gitDirs: [w.gitDir] });
      }
    }
    return [...bySession.values()];
  }

  private async chatFacts(session: string, cwd: string, ps: ProcessInfo[], recorded?: Date): Promise<ChatFacts> {
    const transcript = await readTranscript(cwd, session, this.deps.claudeHome).catch(() => undefined);
    const writes = [recorded, transcript?.updatedAt].filter((d): d is Date => !!d);
    const lastWrite = writes.length ? new Date(Math.max(...writes.map((d) => d.getTime()))) : new Date(0);
    return {
      session,
      gitDirs: [],
      state: 'working',
      lastWrite,
      process: processOf(ps, session),
      runsHere: this.deps.runsHere(session),
      busy: transcript ? await transcriptBusy(transcriptPath(cwd, session, this.deps.claudeHome)) : false,
    };
  }

  private processes(): Promise<ProcessInfo[]> {
    return this.deps.processes?.() ?? listProcesses();
  }
}

/**
 * The processes running now, with their command lines: `ps`, or PowerShell on Windows. Fails when it can't tell (a
 * Check without them would take every quiet agent for ended).
 */
export function listProcesses(): Promise<ProcessInfo[]> {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }']]
      : ['ps', ['-A', '-ww', '-o', 'pid=,args=']];
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, timeout: 15_000, windowsHide: true }, (err, stdout) =>
      err ? reject(new Error(`Couldn't list the processes running (${cmd}): ${err.message}`)) : resolve(parsePs(stdout)),
    );
  });
}

/** Whether the merge queue or train names a ticket. */
function inQueue(data: Pick<BacklogData, 'mergeQueue' | 'mergeTrain'>, id: string): boolean {
  return !!data.mergeQueue?.includes(id) || !!data.mergeTrain?.entries.some((e) => e.id === id);
}

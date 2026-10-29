import * as vscode from 'vscode';
import {
  agentChatItem,
  agentName,
  type BacklogData,
  type BacklogItem,
  entryAgent,
  sameAgent,
} from '../../features/backlog/backlog';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import { baseLabel } from '../../features/backlog/mainDrift';
import {
  dropCheck,
  editableSister,
  endCheck,
  parseSisterReply,
  setVerdict,
  SISTER_STALE_MS,
  sisterCheckPrompt,
  sisterCheckTools,
  type SisterRef,
  sistersOf,
  type SisterVerdict,
  verdictLine,
} from '../../features/backlog/sisterCheck';
import { entryDate, type Ticket, type TicketEntry } from '../../features/backlog/ticket';
import { trackProgress } from '../progress';
import {
  agentChoice,
  type AgentResult,
  type AgentRun,
  runAgentHeadless,
} from './agentRunner';

export interface SisterChecksDeps {
  backlog: LocalBacklog;
  /** The main worktree: the agent reads the code there. */
  mainRoot: string;
  /** Main's branch ("main"). */
  base: () => Promise<string>;
  output: vscode.OutputChannel;
  /** Whether this window leads: only the leading window runs checks. */
  isLeader: () => boolean;
  /** The names of agents in the repository's chats: a new agent's name is none of them. */
  takenNames: () => string[];
  /** Starts an agent (tests fake it). */
  run?: typeof runAgentHeadless;
  /** How long after a change a check starts (flotilla.sisterCheckDelaySeconds); unset: 3 minutes. */
  delayMs?: () => number | undefined;
  now?: () => Date;
}

const STATUS: Record<BacklogItem['status'], string> = { todo: 'To Do', doing: 'in progress', review: 'in review', done: 'done' };

/**
 * Sister checks (BL-236): a ticket's change (merged, discarded, its description reworked) waits a few minutes on it
 * (`sisterCheck`, see noteChange), then the leading window has an agent check its sisters against it. What the agent
 * finds goes into the tickets: an entry in each sister it updated, covered, found at odds or outdated (those covered or
 * at odds ask in "Needs you"), and one in the changed ticket. A check that fails, or that a window left, releases them.
 */
export class SisterChecks implements vscode.Disposable {
  /** The checks this window runs: their agent, and the sisters' tickets before it (see guard). */
  private readonly runs = new Map<string, { run: AgentRun; agent: string; before: ReadonlyMap<string, Ticket> }>();
  private ticking = false;
  private again = false;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly watcher: vscode.Disposable;

  constructor(private readonly deps: SisterChecksDeps) {
    this.watcher = deps.backlog.watch(() => this.tick());
    this.timer = setInterval(() => this.tick(), 30_000);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.watcher.dispose();
    this.runs.forEach((r) => r.run.stop());
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Starts the checks that are due, ends those you stopped, and releases those a window left running; one tick at a time. */
  tick(): void {
    if (!this.deps.isLeader()) return;
    // A change during a tick (a Stop check, BL-240) is looked at right after it, not on the next timer.
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    this.again = false;
    void this.startDue()
      .catch((e: unknown) => this.deps.output.appendLine(`Sister checks: ${String(e)}`))
      .finally(() => {
        this.ticking = false;
        if (this.again) this.tick();
      });
  }

  private async startDue(): Promise<void> {
    const now = this.now();
    for (const item of (await this.deps.backlog.read()).items) {
      const c = item.sisterCheck;
      if (c?.stop) await this.stopped(item);
      else if (!c || this.runs.has(item.id)) continue;
      else if (c.session) {
        if (now.getTime() - Date.parse(c.started ?? c.due) >= SISTER_STALE_MS)
          await this.release(item, `${c.agent ?? 'Its agent'}'s check of its sisters didn't finish (its window closed)`);
      } else if (Date.parse(c.due) <= now.getTime()) {
        await this.start(item.id);
      }
    }
  }

  /** Ends ticket `id`'s check without its findings: its sisters are released, with an entry saying why. */
  private async release(item: BacklogItem, why: string): Promise<void> {
    const covers = item.sisterCheck?.covers ?? [];
    const next = await this.deps.backlog.change((d) => this.end(d, item.id), { by: 'Flotilla' });
    const again = next.items.find((i) => i.id === item.id)?.sisterCheck;
    await this.say(
      item,
      again
        ? `${why}. It's checked again for what came meanwhile (${again.reasons.join(', ')}): ${covers.join(', ')} ${covers.length === 1 ? 'waits' : 'wait'} for that.`
        : `${why}: ${covers.join(', ')} ${covers.length === 1 ? 'is' : 'are'} released, unchecked.`,
    );
  }

  /**
   * You stopped ticket `item`'s check (BL-240): its agent, if this window runs it, is stopped, and its sisters are
   * released at once, unchecked, with what came meanwhile (a check you stopped isn't run again for it).
   */
  private async stopped(item: BacklogItem): Promise<void> {
    const c = item.sisterCheck!;
    const own = this.runs.get(item.id);
    this.runs.delete(item.id);
    own?.run.stop();
    if (own) await this.guard(own.agent, own.before);
    await this.deps.backlog.change((d) => dropCheck(d, item.id), { by: 'Flotilla' });
    const covers = c.covers;
    const whose = c.session ? `${c.agent ?? 'Its agent'}'s check of its sisters` : 'the check of its sisters before it started';
    await this.say(item, `You stopped ${whose}: ${covers.join(', ')} ${covers.length === 1 ? 'is' : 'are'} released, unchecked.`);
  }

  /** Ends ticket `id`'s check; a merge or discard that came while it ran is checked next (see endCheck). */
  private end(data: BacklogData, id: string): BacklogData {
    return endCheck(data, id, this.now(), this.deps.delayMs?.());
  }

  private async start(id: string): Promise<void> {
    const data = await this.deps.backlog.read();
    const item = data.items.find((i) => i.id === id);
    const check = item?.sisterCheck;
    if (!item || !check || check.session) return;
    // The sisters as they are now: one may have started, or been merged, since the change.
    const descriptions = new Map<string, string>();
    for (const i of data.items) if (!i.discarded && i.status !== 'done') descriptions.set(i.id, (await this.deps.backlog.readTicketCached(i)).description);
    const sisters = sistersOf(data, id, descriptions);
    if (!sisters.length) {
      await this.deps.backlog.change((d) => endCheck(d, id), { by: 'Flotilla' });
      return;
    }
    const agent = agentName(this.deps.takenNames());
    const refs: SisterRef[] = [];
    const before = new Map<string, Ticket>();
    for (const s of sisters) {
      const ticket = await this.deps.backlog.ensureDocument(s);
      const editable = editableSister(s);
      if (editable) before.set(s.id, await this.deps.backlog.readTicket(s));
      const relation = s.parent && s.parent === item.parent ? `a part of ${s.parent} too` : s.parent === id ? 'a part of it' : 'depends on it';
      refs.push({ id: s.id, title: s.title, ticket, editable, status: s.proposed ? 'proposed' : STATUS[s.status], relation });
    }
    const epic = item.parent ? data.items.find((i) => i.id === item.parent) : undefined;
    const run = (this.deps.run ?? runAgentHeadless)({
      cwd: this.deps.mainRoot,
      prompt: sisterCheckPrompt({
        item,
        agent,
        ticket: await this.deps.backlog.ensureDocument(item),
        reasons: check.reasons,
        ...(epic ? { epic: { id: epic.id, ticket: await this.deps.backlog.ensureDocument(epic) } } : {}),
        sisters: refs,
        base: baseLabel(await this.deps.base().catch(() => 'main')),
      }),
      name: `${agent} · checking ${id}'s sisters`,
      track: { ticket: id, agent, role: 'discuss' },
      choice: agentChoice(item),
      output: this.deps.output,
      tools: sisterCheckTools(refs.filter((r) => r.editable).map((r) => r.ticket)),
    });
    this.runs.set(id, { run, agent, before });
    const covers = sisters.map((s) => s.id);
    try {
      await this.deps.backlog.change(
        (d) => ({
          ...d,
          items: d.items.map((i) =>
            i.id === id && i.sisterCheck
              ? { ...i, sisterCheck: { ...i.sisterCheck, covers, agent, session: run.sessionId, started: this.now().toISOString() } }
              : i,
          ),
        }),
        { by: 'Flotilla' },
      );
    } catch (e) {
      this.runs.delete(id);
      run.stop();
      throw e;
    }
    void trackProgress('backlog', `${agent} is checking ${id}'s sisters`, () => run.done);
    void run.done.then((result) => this.finished(id, run, result).catch((e: unknown) => this.deps.output.appendLine(`Sister check of ${id}: ${String(e)}`)));
  }

  /** The check's run is over: its findings go into the tickets, and its sisters are released. */
  private async finished(id: string, run: AgentRun, result: AgentResult): Promise<void> {
    // Stopped (see stopped): what it found isn't used.
    const own = this.runs.get(id);
    if (own?.run !== run) return;
    this.runs.delete(id);
    const { agent, before } = own;
    const data = await this.deps.backlog.read();
    const item = data.items.find((i) => i.id === id);
    if (!item?.sisterCheck) return;
    const covers = item.sisterCheck.covers;
    await this.guard(agent, before);
    const reply = result.reply?.trim();
    if (result.limit || result.error || !reply) {
      const why = result.limit
        ? `stopped on a limit (${result.limit.kind})`
        : result.error
          ? `stopped (${result.error.slice(0, 200)})`
          : 'stopped without a reply';
      await this.release(item, `${agent}'s check of its sisters ${why}`);
      return;
    }
    const parsed = parseSisterReply(reply, covers);
    const date = entryDate(this.now());
    const author = `Agent ${agent}`;
    const lines: string[] = [];
    const verdicts: Array<[string, SisterVerdict]> = [];
    for (const f of parsed.findings) {
      const sister = data.items.find((i) => i.id === f.id);
      if (!sister || f.finding === 'unchanged') continue;
      const editable = before.has(f.id);
      // Only a To Do or proposed sister has its description brought up to date, or asks to be discarded.
      const finding = !editable && f.finding !== 'outdated' ? 'outdated' : editable && f.finding === 'outdated' ? 'updated' : f.finding;
      const lead =
        finding === 'updated'
          ? `Brought its description up to date after ${id}'s change.`
          : finding === 'covered'
            ? `${id}'s change covers this ticket: Discard it, or Keep it as it is.`
            : finding === 'contradicts'
              ? `${id}'s change is at odds with this ticket: Discard it, or Keep it as it is.`
              : `${id} changed: what of this ticket's work may now be outdated.`;
      await this.deps.backlog.appendActivity(sister, { date, author, body: [lead, f.text].filter(Boolean).join('\n\n') });
      if (finding === 'covered' || finding === 'contradicts')
        verdicts.push([f.id, { from: id, kind: finding, line: verdictLine(id, finding, f.text), since: this.now().toISOString() }]);
      lines.push(`- ${f.id}: ${finding === 'contradicts' ? 'at odds with it' : finding}`);
    }
    await this.deps.backlog.change((d) => verdicts.reduce((x, [sid, v]) => setVerdict(x, sid, v), this.end(d, id)), { by: 'Flotilla' });
    // One short entry when nothing changed, not one in each sister.
    const body = lines.length
      ? [parsed.summary || `Checked ${covers.join(', ')} against this change.`, lines.join('\n')].join('\n\n')
      : `Checked ${covers.join(', ')} against this change: nothing to change.${parsed.summary ? `\n\n${parsed.summary}` : ''}`;
    await this.deps.backlog.appendActivity(item, { date, author, body });
  }

  /**
   * Keeps what the agent may not change in the sisters it could edit: their titles, and their activity (entries it
   * wrote there itself are taken out: Flotilla writes them, from its reply).
   */
  private async guard(agent: string, before: ReadonlyMap<string, Ticket>): Promise<void> {
    const data = await this.deps.backlog.read();
    for (const [sid, was] of before) {
      const sister = data.items.find((i) => i.id === sid);
      if (!sister) continue;
      const now = await this.deps.backlog.readTicket(sister);
      const known = new Set(was.activity.map(key));
      const own = (e: TicketEntry) => !known.has(key(e)) && sameAgent(entryAgent(e.author), agent);
      if (now.title === was.title && !now.activity.some(own)) continue;
      await this.deps.backlog.editTicket(sister, (t) => ({ ...t, title: was.title, activity: t.activity.filter((e) => !own(e)) }));
      if (sister.title !== was.title)
        await this.deps.backlog.change((d) => ({ ...d, items: d.items.map((i) => (i.id === sid ? { ...i, title: was.title } : i)) }));
    }
  }

  private async say(item: Pick<BacklogItem, 'id' | 'title' | 'notes'>, body: string): Promise<void> {
    await this.deps.backlog.appendActivity(item, { date: entryDate(this.now()), author: 'Flotilla', body });
  }
}

const key = (e: TicketEntry) => `${e.date}\n${e.author}\n${e.body}`;

/** The names of agents in the repository's chats, for a new agent's name. */
export function chatAgentNames(chats: ReadonlyArray<{ firstPrompt?: string }>): string[] {
  return chats.map((c) => agentChatItem(c.firstPrompt)?.agent ?? '').filter(Boolean);
}

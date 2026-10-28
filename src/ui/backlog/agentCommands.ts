import * as vscode from 'vscode';
import type { BacklogItem } from '../../features/backlog/backlog';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import { heldBy, type ReviewFix } from '../../features/backlog/review';
import { discussable } from '../../features/backlog/shaping';
import { showError, type Commands } from '../commandSet';
import { backlogIdOf } from './cardMenu';
import { checkAllTickets } from './checkAll';
import type { ReviewLoop } from './reviewLoop';
import type { Shaping } from './shaping';
import type { TicketChecker } from './ticketCheck';
import type { TicketPanels } from './ticketPanel';

export interface AgentCommandDeps {
  backlog: LocalBacklog;
  tickets: TicketPanels;
  reviews: ReviewLoop;
  shaping: Shaping;
  checker: TicketChecker;
}

/** The commands on a ticket's agents: run its block, pause, resume or stop them, check, discuss, prioritize, fix a review. */
export function agentCommands(deps: AgentCommandDeps): Commands {
  const { backlog, tickets, reviews, shaping, checker } = deps;
  // Pause, Resume and Stop on a backlog card's menu (its id in the menu's context), or asking which ticket.
  const controlAgent = (action: 'pause' | 'resume' | 'stop') => async (card?: unknown) => {
    let id = backlogIdOf(card);
    if (!id) {
      const data = await backlog.read();
      // An epic in progress has no agent of its own to stop (BL-239): its parts do.
      const epic = (i: BacklogItem) => data.items.some((c) => c.parent === i.id);
      const items = data.items.filter((i) =>
        action === 'resume'
          ? heldBy(i.review) || i.review?.state === 'paused'
          : ['working', 'reviewing', 'revising', 'paused'].includes(i.review?.state ?? '') || (i.status === 'doing' && !epic(i)),
      );
      const title = { pause: 'Pause the agent on…', resume: 'Resume the agent on…', stop: 'Stop the agent on…' }[action];
      id = (
        await vscode.window.showQuickPick(
          items.map((i) => ({ label: i.id, description: i.title })),
          { title },
        )
      )?.label;
    }
    if (id) await tickets.controlAgent(id, action);
  };
  return {
    // A ticket's run block (its Run button names the entry and the block; without one, the ticket's run), after asking.
    'flotilla.runBacklogItem': (id?: unknown, block?: unknown) => {
      if (typeof id !== 'string') return;
      const ref = block as { key?: unknown; index?: unknown; try?: unknown } | undefined;
      return tickets.run(
        id,
        typeof ref?.key === 'string' && typeof ref.index === 'number'
          ? { key: ref.key, index: ref.index, ...(ref.try === true ? { try: true } : {}) }
          : undefined,
      );
    },
    // Back from a diff opened from a ticket's Changes (BL-171), in its title bar and the status bar.
    'flotilla.backToTicket': () => tickets.diffs.back().catch(showError),
    'flotilla.pauseAgent': controlAgent('pause'),
    'flotilla.resumeAgent': controlAgent('resume'),
    'flotilla.stopAgent': controlAgent('stop'),
    // Check (BL-163): what a ticket says is going on, against what runs; Clean Up of what doesn't.
    'flotilla.checkTicket': async (card?: unknown) => {
      const id =
        backlogIdOf(card) ??
        (
          await vscode.window.showQuickPick(
            (await backlog.read()).items.filter((i) => i.status !== 'done').map((i) => ({ label: i.id, description: i.title })),
            { title: 'Check the ticket…' },
          )
        )?.label;
      if (!id) return;
      await tickets.open(id);
      await tickets.check(id).catch(showError);
    },
    'flotilla.checkAll': () => checkAllTickets(checker, tickets).catch(showError),
    // Tickets nobody works on yet are talked through with an agent in a chat (BL-188); Discuss opens that.
    'flotilla.discussBacklogItem': async (id?: unknown) => {
      if (typeof id !== 'string') return;
      const item = (await backlog.read()).items.find((i) => i.id === id);
      if (!item || !discussable(item)) return;
      await tickets.open(id);
      await shaping.discuss(id).catch(showError);
    },
    // Prioritize: a queued start runs now, above the limit, or pauses a running agent to make room (see reviewLoop).
    'flotilla.prioritizeBacklogItem': (id: unknown) => typeof id === 'string' && reviews.prioritize(id).catch(showError),
    // The "Needs you" list's fix for a stopped review (the same fixes as the ticket's and the notification's).
    'flotilla.fixBacklogReview': (id: unknown, fix: unknown) => typeof id === 'string' && reviews.fix(id, fix as ReviewFix).catch(showError),
  };
}

/**
 * What scripts/playground-seed.mjs uses from the app, so the seed writes what the app reads: built to
 * dist/playground-seed-kit.mjs by esbuild.mjs (scripts/seed-kit.mjs has the options).
 */
import { descriptionHash } from './changes';
import { LocalBacklog } from './localBacklog';
import { parseVerdict, saysReadyForReview } from './review';
import type { TicketEntry } from './ticket';

export { entryDate, formatTicket } from './ticket';
export { descriptionHash };

/** The key the review loop gives an activity entry. */
export const entryKey = (id: string, e: TicketEntry): string => LocalBacklog.entryKey(id, e);

/** Whether the review loop acts on an entry: a report that hands work over, or a verdict. */
export const actionable = (e: TicketEntry): boolean => saysReadyForReview(e.body) || parseVerdict(e.body) !== undefined;

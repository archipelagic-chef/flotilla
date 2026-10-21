import type { Handlers } from './context';

/** Shaping and reviewing: discussing the ticket, the review loop, and updating its branch from main. */
export const reviewHandlers: Handlers = {
  discuss: async ({ id, item, panels }) => {
    if (!item.remote) await panels.shaping?.discuss(id, true);
  },
  keepDiscussing: async ({ id, panels }) => {
    await panels.shaping?.keepDiscussing(id);
  },
  startReview: async ({ id, panels }) => {
    await panels.reviews?.start(id, true);
  },
  userReview: async ({ id, panels }, m) => {
    await panels.reviews?.userReview(id, m.verdict, m.text);
  },
  reviewFix: async ({ id, panels }, m) => {
    await panels.reviews?.fix(id, m.fix);
  },
  updateFromMain: async ({ id, panels }) => {
    await panels.mainSync?.update(id);
  },
  prioritize: async ({ id, panels }) => {
    await panels.reviews?.prioritize(id);
  },
  stopReview: async ({ id, panels }) => {
    await panels.reviews?.stop(id);
  },
};

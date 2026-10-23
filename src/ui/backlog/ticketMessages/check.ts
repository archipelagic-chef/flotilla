import type { Handlers } from './context';

/** A ticket's Check (BL-163): what it says is going on, against what runs; and Clean Up of what doesn't. */
export const checkHandlers: Handlers = {
  check: async ({ id, panels }) => {
    await panels.check(id, true);
  },
  checkCleanUp: async ({ id, panels }, m) => {
    await panels.cleanUp(id, m.key);
  },
};

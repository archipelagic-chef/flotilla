/** A ticket tab's messages about its check (BL-163): handled in ./check.ts. Type-only, as ticketProtocol.ts. */
export type CheckMessage =
  /** Check what the ticket says is going on (BL-163); Clean Up its glitches (one, by key, or all). */
  | { type: 'check' }
  | { type: 'checkCleanUp'; key?: string };

/**
 * The shape a ticket's description takes (BL-137): what the work does once it's done first, then why, then the
 * acceptance criteria. The agents' guide, their prompts and the description editor all ask for it.
 */

/** The description's shape, as the guide's template for a new ticket shows it (after its "# Title"). */
export const DESCRIPTION_SHAPE = `**When it's done:** what the user sees and can do, in 1–4 lines.

**Why:** what's wrong today, and its cause, with links to the code (as short as it can be).

Acceptance criteria:
- [ ] …`;

/** That shape, in a sentence, for the prompts that write descriptions. */
export const SHAPE_RULE =
  `A description opens with a line "**When it's done:**" and 1–4 lines on what the user sees and can do once the work is done, then "**Why:**" (what's wrong today, and its cause), then the acceptance criteria as a checklist.`;

/** Keeping the description current covers its "When it's done" lines, not only its criteria. */
export const KEEP_WHEN_DONE = `Keep its "**When it's done:**" lines (at the top) saying what the work does once done as well, not only the acceptance criteria; add them if the description has none.`;

/** The reviewer's check of the description: it asks for the intended behaviour at the top, without holding up a merge. */
export const DESCRIPTION_CHECK = `If the ticket's description doesn't open with what the work does once it's done (a "**When it's done:**" line, then 1–4 lines), ask the implementer to add it; that alone doesn't hold up an approval.`;

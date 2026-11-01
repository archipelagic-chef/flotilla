/** An improvement review's tab (BL-177): the review rendered as a ticket's entries are. */

/** To the tab: the review, rendered (missing: its file isn't there). */
export type ReviewHostMessage = { type: 'review'; day: string; title: string; html: string; missing?: true };

/** From the tab: its links (as a ticket's Rendered sends them), and Edit to open the file. */
export type ReviewWebviewMessage = { type: 'ready' } | { type: 'openHref'; href: string } | { type: 'openFile' };

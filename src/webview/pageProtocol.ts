/** A page tab's messages (BL-260): a Markdown file shown as a ticket's entries are, such as a scheduled task's report. */
export type PageHostMessage = { type: 'page'; html: string };

export type PageWebviewMessage = { type: 'ready' } | { type: 'openHref'; href: string };

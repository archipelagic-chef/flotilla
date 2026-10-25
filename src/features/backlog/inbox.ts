import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { addBranch, addItem, entryAgent, ID_PATTERN, nextId, priorityFromName, updateItem, type BacklogData, type BacklogItem } from './backlog';
import { DESCRIPTION_SHAPE, KEEP_WHEN_DONE } from './descriptionShape';
import { REPORT_FORMAT } from './report';
import { reviewNotes } from './review';
import { entryDate, parseTicket } from './ticket';
import { writeAtomic, type LocalBacklog } from './localBacklog';

/**
 * The backlog's inbox: how agents add tickets. An agent writes a Markdown file into .flotilla/backlog/inbox/ (the
 * ticket's title and description, after optional front matter); Flotilla takes it in, gives it the next id, and
 * writes that id next to it (<name>.added) for the agent to read. Any agent can, not only those Flotilla started.
 */
export const INBOX = 'inbox';
export const GUIDE = 'AGENTS.md';

/** Whether agents' tickets wait for the user to accept them, or join the backlog at once. */
export type AgentTicketMode = 'propose' | 'add';

export interface Proposal {
  /** An existing item the agent starts on (claims), instead of a new one. */
  claim?: string;
  title: string;
  description: string;
  /** The item it's a part of. */
  parent?: string;
  priority?: string;
  /** The agent starts on it now, on branch (its current one). */
  start: boolean;
  branch?: string;
  /** The agent that wrote it ("a3f9"), when it signed. */
  agent?: string;
  /** Small and mechanical: its work runs on the light model (level: light, BL-69). */
  light?: boolean;
}

/** Reads a proposal: "---" front matter (key: value lines), then a ticket ("# Title", description). */
export function parseProposal(text: string): Proposal | { error: string } {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  const fields = new Map<string, string>();
  for (const line of (front?.[1] ?? '').split('\n')) {
    const m = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (m) fields.set(m[1].toLowerCase(), m[2].replace(/^["']|["']$/g, ''));
  }
  const ticket = parseTicket(front ? normalized.slice(front[0].length) : normalized);
  const claim = fields.get('claim')?.toUpperCase();
  if (!claim && !ticket.title.trim()) return { error: 'It has no title: start the ticket with "# Title".' };
  const agent = fields.get('agent');
  return {
    ...(claim ? { claim } : {}),
    title: ticket.title.trim(),
    description: ticket.description,
    ...(fields.get('parent') ? { parent: fields.get('parent')!.toUpperCase() } : {}),
    ...(fields.get('priority') ? { priority: fields.get('priority') } : {}),
    start: !!claim || /^(true|yes|1)$/i.test(fields.get('start') ?? ''),
    ...(fields.get('branch') ? { branch: fields.get('branch') } : {}),
    ...(/^light$/i.test(fields.get('level') ?? '') ? { light: true } : {}),
    ...(agent && entryAgent(`Agent ${agent.replace(/^agent\s+/i, '')}`) ? { agent: entryAgent(`Agent ${agent.replace(/^agent\s+/i, '')}`) } : {}),
  };
}

/** Adds a proposal to the backlog: its item (and what's wrong with it, if it can't be added). */
export function addProposal(
  data: BacklogData,
  p: Proposal,
  opts: { prefix: string; mode: AgentTicketMode; now: Date; taken: readonly string[] },
): { data: BacklogData; item: BacklogItem } | { error: string } {
  if (p.claim) {
    // An agent starts on an existing item: in progress, on its branch.
    const found = data.items.find((i) => i.id.toLowerCase() === p.claim!.toLowerCase());
    if (!found) return { error: `${p.claim} isn't in the backlog.` };
    let next = updateItem(data, found.id, { status: found.status === 'done' || found.status === 'review' ? found.status : 'doing' });
    if (p.branch) next = addBranch(next, found.id, p.branch);
    return { data: next, item: next.items.find((i) => i.id === found.id)! };
  }
  if (p.parent && !data.items.some((i) => i.id.toLowerCase() === p.parent!.toLowerCase())) {
    return { error: `Its parent ${p.parent} isn't in the backlog.` };
  }
  const parent = p.parent && data.items.find((i) => i.id.toLowerCase() === p.parent!.toLowerCase())!.id;
  // Parts get their parent's prefix (BL-1's parts are BL-…).
  const prefix = (parent && ID_PATTERN.exec(parent)?.[1]) || opts.prefix;
  const added = addItem(data, p.title, prefix, opts.now, nextId(data, prefix, opts.taken));
  const priority = priorityFromName(p.priority);
  const item: BacklogItem = {
    ...added.item,
    status: p.start ? 'doing' : 'todo',
    ...(priority ? { priority } : {}),
    ...(parent ? { parent } : {}),
    ...(p.light ? { agent: { light: true } } : {}),
    ...(opts.mode === 'propose' ? { proposed: p.agent ? { by: p.agent } : {} } : {}),
  };
  let next: BacklogData = { ...added.data, items: added.data.items.map((i) => (i.id === item.id ? item : i)) };
  if (p.start && p.branch) next = addBranch(next, item.id, p.branch);
  return { data: next, item: next.items.find((i) => i.id === item.id)! };
}

/**
 * Takes in the inbox's proposals: each becomes an item (with its ticket), its file is removed, and the id is written
 * to <name>.added (or the problem to <name>.error). onStarted: a proposal the agent starts on now, on its branch.
 */
export async function takeInbox(
  store: LocalBacklog,
  opts: { prefix: string; mode: AgentTicketMode; taken: readonly string[]; onStarted?(item: BacklogItem, branch: string): Promise<void> },
): Promise<BacklogItem[]> {
  const dir = path.join(store.dir, INBOX);
  await requeueStaleTaking(dir);
  let names: string[];
  try {
    names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort();
  } catch {
    return [];
  }
  const added: BacklogItem[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const base = path.join(dir, name.slice(0, -'.md'.length));
    // Taken by renaming it: a window that lists the inbox at the same time finds it gone and skips it.
    const taking = `${file}.${process.pid}.${crypto.randomUUID()}.taking`;
    try {
      // A file still being written is taken next time.
      const stat = await fs.promises.stat(file);
      if (Date.now() - stat.mtimeMs < 1000) continue;
      await fs.promises.rename(file, taking);
      // Its time is now the time it was taken: requeueStaleTaking looks at it.
      const now = new Date();
      await fs.promises.utimes(taking, now, now);
    } catch {
      continue;
    }
    // A file that can't be read is answered with the problem, so its agent doesn't wait for an answer that never comes.
    let proposal: ReturnType<typeof parseProposal>;
    try {
      proposal = parseProposal(await fs.promises.readFile(taking, 'utf8'));
    } catch {
      proposal = { error: "It couldn't be read." };
    }
    let item: BacklogItem | undefined;
    let error = 'error' in proposal ? proposal.error : 'Not added.';
    if (!('error' in proposal)) {
      const by = proposal.agent ? `Agent ${proposal.agent}` : 'Agent';
      await store.change(async (d) => {
        // Ids on disk count too: a ticket file whose item isn't in backlog.json keeps its id.
        const r = addProposal(d, proposal, { prefix: opts.prefix, mode: opts.mode, now: new Date(), taken: [...opts.taken, ...(await store.ticketIds())] });
        if ('error' in r) {
          error = r.error;
          return d;
        }
        item = r.item;
        return r.data;
      }, { by });
      if (item) {
        if (proposal.claim) {
          const where = proposal.branch ? ` on branch \`${proposal.branch}\`` : '';
          await store.appendActivity(item, { date: entryDate(new Date()), author: by, body: `Started on this ticket${where}.` });
        } else {
          await store.writeTicket(item.id, {
            title: proposal.title,
            description: proposal.description,
            activity: [{ date: entryDate(new Date()), author: by, body: proposal.start ? 'Added this ticket and started on it.' : 'Proposed this ticket.' }],
          });
        }
        if (proposal.start && proposal.branch) await opts.onStarted?.(item, proposal.branch);
        // Claims aren't new tickets: their ticket says who started, nobody needs telling.
        if (!proposal.claim) added.push(item);
      }
    }
    await fs.promises.rm(taking, { recursive: true, force: true });
    if (item) await writeAtomic(`${base}.added`, `${item.id}\n`);
    else await writeAtomic(`${base}.error`, `${error}\n`);
  }
  // Answers older than a day have been read.
  for (const n of await fs.promises.readdir(dir).catch(() => [] as string[])) {
    if (!/\.(added|error)$/.test(n)) continue;
    const stat = await fs.promises.stat(path.join(dir, n)).catch(() => undefined);
    if (stat && Date.now() - stat.mtimeMs > 86_400_000) await fs.promises.rm(path.join(dir, n), { force: true });
  }
  return added;
}

/** A file taken by a process that died before answering it goes back to the inbox, once it has sat taken for five minutes. */
async function requeueStaleTaking(dir: string): Promise<void> {
  for (const n of await fs.promises.readdir(dir).catch(() => [] as string[])) {
    if (!n.endsWith('.taking')) continue;
    const taking = path.join(dir, n);
    const stat = await fs.promises.stat(taking).catch(() => undefined);
    if (!stat || Date.now() - stat.mtimeMs < 300_000) continue;
    const original = path.join(dir, n.replace(/\.\d+\.[0-9a-f-]{36}\.taking$/, ''));
    if (fs.existsSync(original)) continue;
    await fs.promises.rename(taking, original).catch(() => undefined);
  }
}

/** The guide agents read (AGENTS.md next to the backlog): how to work through the backlog and add to it. */
export function agentGuide(backlogDir: string, mode: AgentTicketMode): string {
  const inbox = path.join(backlogDir, INBOX);
  return `# The backlog (Flotilla)

This repository's work is tracked in a backlog, in ${backlogDir}:

- \`backlog.json\`: the items in priority order, with id, title, status (todo, doing, review, done), priority and
  parent (the item one is part of). Read it; never edit it.
- \`<id>.md\`: each item's ticket: "# Title", the description, then "## Activity" (comments and agents' reports).

## Work through a ticket

Whenever you're asked to change this repository (fix, build, refactor), do it as a ticket. Questions and
explanations that change nothing don't need one.

1. Find the ticket: the one the user names ("BL-3"), or one in \`backlog.json\` whose title and description cover the
   task. If none does, add one with \`start: true\` (see "Adding tickets").
2. Claim it before you start: write an inbox file (below) with \`claim: BL-3\` and your branch. Read its ticket.
3. Start every commit message with its id: \`BL-3: Fix the token refresh\`.
4. Report in its ticket: append entries at the end of "## Activity", each headed
   \`### YYYY-MM-DD HH:MM · Agent <your name>\` (local time): your plan when you start, and what you did when you
   finish. ${REPORT_FORMAT}
5. Keep its description what's to be done: when the user asks for more or for something else (in the chat, or in
   comments and reviews in the ticket), work it into the description (between "# Title" and "## Activity"), usually as
   acceptance criteria. ${KEEP_WHEN_DONE} Edit only the description; leave the activity as it is.
6. When the work is done, end your final report with a line \`Ready for review.\` It's then reviewed: by another
   agent, or by the user. ${reviewNotes({ id: '<id>', backlogDir })}
7. Keep your branch current with main, and tidy it: before you report \`Ready for review.\`, rebase it onto main
   (\`git rebase main\`, the branch work merges into; never merge main into it), resolving any conflicts commit by
   commit. Then tidy its commits into the steps a reviewer would want to read, non-interactively: \`fixup!\` commits
   and \`GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash main\`, or \`git rebase -i main\` with a scripted
   \`GIT_SEQUENCE_EDITOR\`. Each commit is one step that builds and passes on its own where reasonable, its message
   starting with the ticket's id: no "Merge main" and no "fix typo" commits. Say in your report how many commits you
   made from how many, and run the project's checks (build, tests) on the result. When a review asks for changes, make
   them as \`fixup!\` commits (\`git commit --fixup <commit>\`) so the reviewer sees what changed; they're squashed in
   the next tidy-up. The branch is rewritten, so push it only with \`git push --force-with-lease\`; never force-push
   anything else. Rebase only onto main, never onto another ticket's branch. If you need another ticket's work, add a
   line \`Depends on: BL-12\` (its id) to your ticket's description and say so in your report: your ticket then shows
   that it waits for that one to be merged.
   Use \`Depends on:\` only when a ticket builds on another's work or reshapes the same feature, not because both
   change the same files: tickets start from main at once, and overlapping changes are reconciled when they merge.

## Adding tickets

Any agent can add tickets. Do it when:

- the user asks for work that isn't in the backlog yet: add it with \`start: true\` before you start;
- the task you're on turns out to be several pieces of work: add one ticket per piece, with \`parent:\` set to your
  ticket's id;
- you find other work that should be done (a bug, a follow-up), but isn't your task.

When you split work into tickets, a ticket that builds the same part as one of its siblings (the same view, panel or
section) gets a line \`Depends on: <that sibling's id>\` in its description (the id is in that one's \`.added\` file),
so they're built one after the other instead of conflicting. Siblings that touch separate parts run in parallel.

To add one, write a Markdown file into ${inbox}/ (any name ending in .md, e.g. \`${inbox}/split-login-1.md\`):

\`\`\`markdown
---
parent: BL-1        # optional: the item it's part of
priority: high      # optional: urgent, high, medium or low
start: true         # optional: you start on it now...
branch: feature/x   # ...on this branch (your current one: git branch --show-current)
agent: Nova-7       # your agent name
level: light        # optional: only for small, mechanical work (a rename, a setting, a text): a lighter model does it
---
# The behaviour, in a sentence ("Open Chat opens the agent's chat")

${DESCRIPTION_SHAPE}
\`\`\`

To claim an existing ticket, the file needs only front matter:

\`\`\`markdown
---
claim: BL-3
branch: feature/x
agent: Nova-7
---
\`\`\`

Flotilla takes it in within seconds and writes the ticket's id to \`<name>.added\` next to your file (or the problem
to \`<name>.error\`). ${
    mode === 'propose'
      ? 'New tickets are proposals: the user accepts or dismisses them (you can still work on one you started).'
      : 'New tickets join the backlog at once (the user can still remove them).'
  } With \`start: true\`, read the new id from \`<name>.added\` and use it in your commits.

Don't edit the descriptions of tickets you aren't working on, and never change issue trackers (Jira, GitHub Issues) yourself.
`;
}

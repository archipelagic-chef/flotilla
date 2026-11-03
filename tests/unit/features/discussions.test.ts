import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { ASK_ALLOWED } from '../../../src/features/backlog/ask';
import { addItem } from '../../../src/features/backlog/backlog';
import {
  discussArgs,
  discussionTurns,
} from '../../../src/features/backlog/discussChat';
import {
  asksForTickets,
  DISCUSSION_ALLOWED,
  DISCUSSION_DENIED,
  discussionIdsOf,
  DiscussionStore,
  discussionTitle,
  formatDiscussion,
  freeDiscussionPrompt,
  nextDiscussionId,
  parseDiscussion,
  PROPOSE_OFFER,
  proposeDiscussionPrompt,
  proposeTools,
  UNTITLED,
} from '../../../src/features/backlog/discussions';
import {
  parseProposal,
  takeInbox,
} from '../../../src/features/backlog/inbox';
import { LocalBacklog } from '../../../src/features/backlog/localBacklog';
import { TICKET_SHAPE } from '../../../src/features/backlog/notes';
import {
  initRepo,
  removeDir,
} from '../../helpers/gitRepo';

let dir: string;
let store: DiscussionStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussions-'));
  store = new DiscussionStore(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('DiscussionStore (BL-267)', () => {
  it('takes the next id in discussions/, with a session, untitled and not listed until talked in', async () => {
    const a = await store.create(new Date('2026-11-02T10:00:00Z'));
    const b = await store.create();
    expect([a.id, b.id]).toEqual(['DISC-1', 'DISC-2']);
    expect(a.session).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.session).not.toBe(b.session);
    expect(fs.existsSync(path.join(dir, 'discussions', 'DISC-1.md'))).toBe(true);
    expect(await store.read('DISC-1')).toEqual({ ...a, title: UNTITLED });
    expect(await store.list()).toEqual([]);
  });

  it('is titled by its first message, keeps its session, and lists newest (last talked in) first', async () => {
    const a = await store.create();
    const b = await store.create();
    await store.talked(a.id, "I need to improve the tickets' version control\nbut I'm not sure how", new Date('2026-11-02T10:00:00Z'));
    await store.talked(b.id, 'Should demos be MP4?', new Date('2026-11-02T11:00:00Z'));
    await store.talked(a.id, 'And the merges?', new Date('2026-11-02T12:00:00Z'));
    const list = await store.list();
    expect(list.map((d) => [d.id, d.title, d.talked])).toEqual([
      ['DISC-1', "I need to improve the tickets' version control", '2026-11-02T12:00:00.000Z'],
      ['DISC-2', 'Should demos be MP4?', '2026-11-02T11:00:00.000Z'],
    ]);
    expect(list[0].session).toBe(a.session);
  });

  it('renames (a later first message no longer titles it) and deletes', async () => {
    const a = await store.create();
    await store.rename(a.id, '  Version   control ');
    await store.talked(a.id, 'Hello');
    expect((await store.read(a.id))?.title).toBe('Version control');
    await store.delete(a.id);
    expect(await store.read(a.id)).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it('reads its file back as it wrote it, and refuses ids that are not discussions', () => {
    const d = { title: 'T', created: '2026-11-02T10:00:00.000Z', talked: '2026-11-02T11:00:00.000Z', session: 's', renamed: true };
    expect(parseDiscussion('DISC-3', formatDiscussion(d))).toEqual({ id: 'DISC-3', ...d });
    expect(() => store.file('../BL-1')).toThrow();
    expect(nextDiscussionId(['DISC-2.md', 'DISC-10.md', 'NOTE-40.md'])).toBe('DISC-11');
    expect(discussionTitle('x'.repeat(100))).toHaveLength(80);
  });
});

describe('a free discussion agent (BL-267)', () => {
  const SESSION = '11111111-2222-3333-4444-555555555555';
  const args = (resume: boolean) =>
    discussArgs({
      choice: [],
      instructions: freeDiscussionPrompt({ backlogDir: '/r/.flotilla/backlog' }),
      plugins: [],
      session: SESSION,
      resume,
      tools: DISCUSSION_ALLOWED,
      denied: DISCUSSION_DENIED,
    });

  it('is told it is a free discussion that proposes no tickets and changes nothing', () => {
    const a = args(false);
    const prompt = a[a.indexOf('--append-system-prompt') + 1];
    expect(prompt).toContain('free discussion');
    expect(prompt).toContain('/r/.flotilla/backlog');
    expect(prompt).toContain("don't propose tickets");
    expect(prompt).toContain('You change nothing');
  });

  it("has the Ask pane's read-only tools, git's writing options refused", () => {
    const a = args(false);
    expect(DISCUSSION_ALLOWED).toEqual(ASK_ALLOWED);
    expect(a[a.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Bash');
    expect(a.slice(a.indexOf('--allowedTools') + 1)).toEqual([...ASK_ALLOWED]);
    expect(a.slice(a.indexOf('--disallowedTools') + 1, a.indexOf('--tools'))).toEqual([...DISCUSSION_DENIED]);
    expect(a.some((t) => /^(Edit|Write)/.test(t))).toBe(false);
  });

  it('starts its session, then resumes it', () => {
    expect(args(false).slice(args(false).indexOf('--session-id'), args(false).indexOf('--session-id') + 2)).toEqual(['--session-id', SESSION]);
    const r = args(true);
    expect(r[r.indexOf('--resume') + 1]).toBe(SESSION);
  });

  it('reads its chat back with the first message shown (it has no opener)', () => {
    const jsonl = [
      { type: 'user', message: { content: 'What do tickets keep?' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Markdown files.' }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');
    expect(discussionTurns(jsonl, { opener: false })).toEqual([{ question: 'What do tickets keep?', answer: 'Markdown files.', state: 'done' }]);
    expect(discussionTurns(jsonl)[0].opener).toBe(true);
  });
});

describe('a discussion that proposes tickets when asked (BL-268)', () => {
  const BACKLOG = '/r/.flotilla/backlog';
  const args = () =>
    discussArgs({
      choice: [],
      instructions: proposeDiscussionPrompt({ id: 'DISC-3', agent: 'Vega-2', backlogDir: BACKLOG }),
      plugins: [],
      session: '11111111-2222-3333-4444-555555555555',
      resume: true,
      tools: proposeTools(BACKLOG),
      offer: PROPOSE_OFFER,
      denied: DISCUSSION_DENIED,
    });

  it('may write into the inbox only: Write offered, allowed by its one Edit rule; no Bash', () => {
    const a = args();
    expect(a[a.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Edit,Write');
    expect(a.slice(a.indexOf('--allowedTools') + 1)).toEqual(['Read', 'Grep', 'Glob', 'Edit(//r/.flotilla/backlog/inbox/**)']);
  });

  it("is told the note agents' ticket shape, the discussion: field, and that it can't change existing tickets", () => {
    const a = args();
    const prompt = a[a.indexOf('--append-system-prompt') + 1];
    expect(prompt).toContain(TICKET_SHAPE);
    expect(prompt).toContain('`discussion: DISC-3`');
    expect(prompt).toContain('`agent: Vega-2`');
    expect(prompt).toContain('/r/.flotilla/backlog/inbox/');
    expect(prompt).toContain("You can't change existing tickets: when part of it belongs in one, say so in your reply");
  });

  it('the free discussion points to Propose Tickets', () => {
    expect(freeDiscussionPrompt({ backlogDir: BACKLOG })).toContain('Propose Tickets');
  });

  it('takes a message asking for tickets as asking, and one saying not to as not', () => {
    for (const t of ['Make tickets of this', 'can you propose a ticket for that?', 'Turn this into tickets.', 'tickets from this, please'])
      expect(asksForTickets(t), t).toBe(true);
    for (const t of ['No tickets yet, just thinking.', "Don't make a ticket of it", 'How are tickets kept?', 'What does the ticket view show?'])
      expect(asksForTickets(t), t).toBe(false);
  });

  it("reads the inbox's discussion field", () => {
    expect(discussionIdsOf('disc-3, DISC-4, DISC-3')).toEqual(['DISC-3', 'DISC-4']);
    expect(parseProposal('---\ndiscussion: DISC-3\n---\n# T\n')).toMatchObject({ discussions: ['DISC-3'] });
    expect(parseProposal('---\nagent: Vega-2\n---\n# T\n')).not.toHaveProperty('discussions');
  });

  it('records what it became, once each, in its file', async () => {
    const d = await store.create();
    await store.talked(d.id, 'Versions');
    await store.recordBecame([d.id, 'DISC-99', 'NOTE-1'], 'BL-301');
    await store.recordBecame([d.id], 'BL-302');
    await store.recordBecame([d.id], 'BL-301');
    expect((await store.read(d.id))?.became).toEqual(['BL-301', 'BL-302']);
    expect(fs.readFileSync(store.file(d.id), 'utf8')).toContain('- Became: BL-301, BL-302');
    expect(fs.existsSync(store.file('DISC-99'))).toBe(false);
  });

  it('links the proposal back to its discussion, and records it there', async () => {
    const repo = initRepo();
    try {
      const backlog = new LocalBacklog(repo, path.join(repo, '.git'));
      await backlog.change((d) => addItem(d, 'SSO', 'BL', new Date()).data);
      const discussions = new DiscussionStore(backlog.dir);
      const d = await discussions.create();
      await discussions.talked(d.id, 'Versions of tickets');
      const inbox = path.join(backlog.dir, 'inbox');
      fs.mkdirSync(inbox, { recursive: true });
      fs.writeFileSync(
        path.join(inbox, 'v.md'),
        `---\ndiscussion: ${d.id}\nagent: Vega-2\n---\n# Keep ticket history in git\n\n**When it's done:** it's kept.\n`,
      );
      const old = new Date(Date.now() - 5000);
      fs.utimesSync(path.join(inbox, 'v.md'), old, old);
      await takeInbox(backlog, {
        prefix: 'BL',
        mode: 'propose',
        taken: [],
        onFromDiscussions: (ids, item) => discussions.recordBecame(ids, item.id),
      });
      const ticket = await backlog.readTicket({ id: 'BL-2', title: '' });
      expect(ticket.description).toBe("**When it's done:** it's kept.\n\nFrom [DISC-1](discussions/DISC-1.md).");
      expect((await discussions.read(d.id))?.became).toEqual(['BL-2']);
      expect(fs.readFileSync(path.join(inbox, 'v.added'), 'utf8').trim()).toBe('BL-2');
    } finally {
      removeDir(repo);
    }
  });
});

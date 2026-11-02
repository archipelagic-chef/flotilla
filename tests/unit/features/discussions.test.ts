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
import {
  discussArgs,
  discussionTurns,
} from '../../../src/features/backlog/discussChat';
import {
  DISCUSSION_ALLOWED,
  DISCUSSION_DENIED,
  DiscussionStore,
  discussionTitle,
  formatDiscussion,
  freeDiscussionPrompt,
  nextDiscussionId,
  parseDiscussion,
  UNTITLED,
} from '../../../src/features/backlog/discussions';

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

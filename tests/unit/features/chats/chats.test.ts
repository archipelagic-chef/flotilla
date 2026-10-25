import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  type ChatRecord,
  encodeProjectDir,
  finishChatRecords,
  homedElsewhere,
  linkChat,
  mergeChats,
  mostUrgent,
  parseChatRecord,
  parseTranscript,
  readChatRecords,
  readTranscript,
  readTranscripts,
  readUnlinked,
  tagTranscriptTitle,
  titleAgent,
  type TranscriptInfo,
  transcriptPath,
  unlinkChat,
} from '../../../../src/features/chats/chats';
import { makeTempDir, removeDir } from '../../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));
const now = new Date('2026-10-10T12:00:00Z');
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
const rec = (o: Partial<ChatRecord> & { sessionId: string }): ChatRecord => ({
  source: 'claude-code',
  state: 'done',
  linkedBy: 'cwd',
  linkedDirs: [],
  updatedAt: ago(1),
  ...o,
});
const opts = { now, openHours: 8, staleMinutes: 10 };

describe('chat records', () => {
  it('parses valid records and rejects invalid ones', () => {
    expect(parseChatRecord('{"sessionId":"a","state":"working","updatedAt":"2026-10-10T11:00:00Z","linkedBy":"edit","cwd":"/r"}')).toMatchObject({
      sessionId: 'a',
      state: 'working',
      linkedBy: 'edit',
      cwd: '/r',
    });
    expect(parseChatRecord('{"sessionId":"a","state":"bogus","updatedAt":"2026-10-10T11:00:00Z"}')).toBeUndefined();
    expect(parseChatRecord('not json')).toBeUndefined();
  });

  it('links a chat to another worktree, which becomes its home, and unlinks it back', async () => {
    const owner = makeTempDir();
    const target = makeTempDir();
    cleanup.push(owner, target);
    await linkChat({ sessionId: 's1', ownerGitDir: owner, cwd: '/r', targetGitDir: target, title: 'Fix login' });
    const [mine] = await readChatRecords(owner);
    expect(mine).toMatchObject({ sessionId: 's1', home: target, linkedDirs: [target], firstPrompt: 'Fix login' });
    expect(homedElsewhere([mine], owner)).toEqual(new Set(['s1']));
    expect(homedElsewhere([mine], target)).toEqual(new Set());
    expect(await readChatRecords(target)).toMatchObject([{ sessionId: 's1', linkedBy: 'manual', cwd: '/r', firstPrompt: 'Fix login' }]);

    await unlinkChat(target, 's1', owner);
    expect(await readChatRecords(target)).toEqual([]);
    expect(await readUnlinked(target)).toEqual(new Set(['s1']));
    const [back] = await readChatRecords(owner);
    expect(back.home).toBeUndefined();
    expect(back.linkedDirs).toEqual([]);

    // Linking again clears the unlinked mark.
    await linkChat({ sessionId: 's1', ownerGitDir: owner, cwd: '/r', targetGitDir: target });
    expect(await readUnlinked(target)).toEqual(new Set());
  });

  it('keeps fields the hook wrote when linking', async () => {
    const owner = makeTempDir();
    const target = makeTempDir();
    cleanup.push(owner, target);
    fs.mkdirSync(path.join(owner, 'flotilla', 'chats'), { recursive: true });
    fs.writeFileSync(
      path.join(owner, 'flotilla', 'chats', 's2.json'),
      JSON.stringify({
        sessionId: 's2',
        state: 'working',
        linkedBy: 'cwd',
        cwd: '/r',
        firstPrompt: 'Original',
        linkedDirs: ['/x/.git'],
        updatedAt: now.toISOString(),
      }),
    );
    await linkChat({ sessionId: 's2', ownerGitDir: owner, cwd: '/r', targetGitDir: target, title: 'Ignored' });
    expect((await readChatRecords(owner))[0]).toMatchObject({ state: 'working', firstPrompt: 'Original', linkedDirs: ['/x/.git', target] });
    expect((await readChatRecords(target))[0]).toMatchObject({ state: 'working', linkedBy: 'manual' });
  });
});

describe('transcripts', () => {
  it('encodes project folders like Claude Code', () => {
    expect(encodeProjectDir('/workspaces/repo/.worktrees/feature-login')).toBe('-workspaces-repo--worktrees-feature-login');
    expect(encodeProjectDir('C:\\Users\\me\\repo')).toBe('C--Users-me-repo');
  });

  it('reads the latest title, the first real prompt and the start time', () => {
    const lines = [
      { type: 'queue-operation', timestamp: '2026-10-10T09:00:00Z' },
      { type: 'user', isMeta: true, message: { content: 'meta' }, timestamp: '2026-10-10T09:00:01Z' },
      { type: 'user', message: { content: [{ type: 'text', text: 'Add retries to the client' }] }, timestamp: '2026-10-10T09:00:02Z' },
      { type: 'ai-title', aiTitle: 'Retries' },
      { type: 'ai-title', aiTitle: 'Add retry with backoff' },
    ].map((l) => JSON.stringify(l));
    expect(parseTranscript('s', lines.join('\n') + '\n', now)).toEqual({
      sessionId: 's',
      title: 'Add retry with backoff',
      firstPrompt: 'Add retries to the client',
      startedAt: new Date('2026-10-10T09:00:00Z'),
      updatedAt: now,
    });
  });

  it('lists the transcripts of a worktree directory', async () => {
    const home = makeTempDir();
    cleanup.push(home);
    const project = path.join(home, 'projects', encodeProjectDir('/r/.worktrees/a'));
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'abc.jsonl'), `${JSON.stringify({ type: 'ai-title', aiTitle: 'Hello' })}\n`);
    fs.writeFileSync(path.join(project, 'notes.txt'), 'x');
    expect(await readTranscripts('/r/.worktrees/a', home)).toMatchObject([{ sessionId: 'abc', title: 'Hello' }]);
    expect(await readTranscripts('/r/.worktrees/none', home)).toEqual([]);
  });
});

describe('mergeChats', () => {
  it('combines records and transcripts, orders open chats by urgency, and hides unlinked ones', () => {
    const chats = mergeChats(
      [
        rec({ sessionId: 'done', state: 'done', updatedAt: ago(2) }),
        rec({ sessionId: 'wait', state: 'waiting-for-input', message: 'Approve?', firstPrompt: 'Migrate', updatedAt: ago(30) }),
        rec({ sessionId: 'work', state: 'working', updatedAt: ago(1), linkedBy: 'edit', cwd: '/r' }),
        rec({ sessionId: 'gone', state: 'done' }),
      ],
      [
        { sessionId: 'wait', title: 'DB migration', updatedAt: ago(29) },
        { sessionId: 'old', firstPrompt: 'Set up CI', updatedAt: ago(3 * 24 * 60) },
        { sessionId: 'hidden', updatedAt: ago(5) },
      ],
      new Set(['gone', 'hidden']),
      opts,
    );
    expect(chats.map((c) => [c.id, c.state, c.open])).toEqual([
      ['wait', 'waiting-for-input', true],
      ['work', 'working', true],
      ['done', 'done', true],
      ['old', 'ended', false],
    ]);
    expect(chats[0]).toMatchObject({ title: 'DB migration', message: 'Approve?' });
    expect(chats[1]).toMatchObject({ linkedBy: 'edit', cwd: '/r' });
    expect(chats[3].title).toBe('Set up CI');
    expect(mostUrgent(chats)?.id).toBe('wait');
  });

  it('treats old working reports as done and old chats as closed', () => {
    const chats = mergeChats(
      [rec({ sessionId: 'stuck', state: 'working', updatedAt: ago(30) }), rec({ sessionId: 'yesterday', state: 'done', updatedAt: ago(20 * 60) })],
      [],
      new Set(),
      opts,
    );
    expect(chats.find((c) => c.id === 'stuck')).toMatchObject({ state: 'done', open: true, stalled: ago(30) });
    expect(chats.find((c) => c.id === 'yesterday')).toMatchObject({ open: false });
    expect(mostUrgent([])).toBeUndefined();
  });
});

describe('a chat that went quiet (BL-131)', () => {
  it('shows a stale working record as stalled since its last activity, unless its transcript is still written', () => {
    const chats = mergeChats(
      [rec({ sessionId: 'quiet', state: 'working', updatedAt: ago(2 * 24 * 60) }), rec({ sessionId: 'long-command', state: 'working', updatedAt: ago(30) })],
      [
        { sessionId: 'quiet', updatedAt: ago(2 * 24 * 60 - 1) },
        { sessionId: 'long-command', updatedAt: ago(2) },
      ],
      new Set(),
      opts,
    );
    expect(chats.find((c) => c.id === 'quiet')).toMatchObject({ state: 'done', stalled: ago(2 * 24 * 60 - 1) });
    const busy = chats.find((c) => c.id === 'long-command');
    expect(busy?.state).toBe('working');
    expect(busy?.stalled).toBeUndefined();
  });

  it("takes a chat's agent from the title Flotilla gave it, over the hook's name", () => {
    const [chat] = mergeChats(
      [rec({ sessionId: 's', agent: 'Astro-4' })],
      [{ sessionId: 's', title: 'Orbit-2 · review BL-132', updatedAt: ago(1) }],
      new Set(),
      opts,
    );
    expect(chat.agent).toBe('Orbit-2');
    expect(
      mergeChats([rec({ sessionId: 's', agent: 'Astro-4' })], [{ sessionId: 's', title: 'Fix the login', updatedAt: ago(1) }], new Set(), opts)[0].agent,
    ).toBe('Astro-4');
    expect(titleAgent('Fix CI · feature/x')).toBeUndefined();
  });

  it('marks every record of a finished headless run done, leaving ended and other chats alone', async () => {
    const common = makeTempDir();
    cleanup.push(common);
    const write = (dir: string, id: string, data: object) => {
      fs.mkdirSync(path.join(dir, 'flotilla', 'chats'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'flotilla', 'chats', `${id}.json`), JSON.stringify({ sessionId: id, ...data }));
    };
    const wt = path.join(common, 'worktrees', 'feature-x');
    write(common, 'run', { state: 'working', message: 'x', updatedAt: ago(5).toISOString() });
    write(wt, 'run', { state: 'waiting-for-input', updatedAt: ago(5).toISOString() });
    write(wt, 'other', { state: 'working', updatedAt: ago(5).toISOString() });
    write(path.join(common, 'worktrees', 'ended'), 'run', { state: 'ended', updatedAt: ago(5).toISOString() });
    expect((await finishChatRecords(common, 'run', now)).sort()).toEqual([common, wt].sort());
    const read = (dir: string, id: string) => parseChatRecord(fs.readFileSync(path.join(dir, 'flotilla', 'chats', `${id}.json`), 'utf8'));
    expect(read(common, 'run')).toMatchObject({ state: 'done', updatedAt: now });
    expect(read(common, 'run')?.message).toBeUndefined();
    expect(read(wt, 'run')?.state).toBe('done');
    expect(read(wt, 'other')?.state).toBe('working');
    expect(read(path.join(common, 'worktrees', 'ended'), 'run')?.state).toBe('ended');
    expect(await finishChatRecords(common, '../x', now)).toEqual([]);
  });
});

describe('tagTranscriptTitle', () => {
  it('adds a custom title from the AI title once, and never replaces a custom title', async () => {
    const dir = makeTempDir();
    cleanup.push(dir);
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n`);
    expect(await tagTranscriptTitle(file, 's', 'feature/login')).toBe('noTitleYet');
    fs.appendFileSync(file, `${JSON.stringify({ type: 'ai-title', aiTitle: 'Add validation' })}\n`);
    expect(await tagTranscriptTitle(file, 's', 'feature/login')).toBe('tagged');
    const last = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').pop()!);
    expect(last).toEqual({ type: 'custom-title', sessionId: 's', customTitle: 'feature/login: Add validation' });
    expect(await tagTranscriptTitle(file, 's', 'feature/login')).toBe('hasCustomTitle');
    // Flotilla shows its own tag without the worktree; a title the user chose wins.
    expect(parseTranscript('s', fs.readFileSync(file, 'utf8'), now).title).toBe('Add validation');
    expect(
      parseTranscript('s', `${JSON.stringify({ type: 'ai-title', aiTitle: 'A' })}\n${JSON.stringify({ type: 'custom-title', customTitle: 'Mine' })}\n`, now)
        .title,
    ).toBe('Mine');
    expect(await tagTranscriptTitle(path.join(dir, 'none.jsonl'), 'x', 'y')).toBe('missing');
  });
});

describe('removeChatCopies', () => {
  /** What opening a chat from worktree a in a window on /r did before BL-121: a copy in /r's project, linked by hand. */
  async function copied(home: string, gits: { main: string; a: string }, entrypoint: string) {
    const { transcriptPath } = await import('../../../../src/features/chats/chats');
    const lines = [
      { type: 'user', entrypoint, message: { content: 'Fix it' } },
      { type: 'assistant', entrypoint, message: { content: [{ type: 'text', text: 'Fixed.' }] } },
    ];
    const original = transcriptPath('/r/.worktrees/a', 's1', home);
    fs.mkdirSync(path.dirname(original), { recursive: true });
    fs.writeFileSync(original, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const copy = transcriptPath('/r', 's1', home);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, `${fs.readFileSync(original, 'utf8')}${JSON.stringify({ type: 'custom-title', customTitle: 'a: Fix it' })}\n`);
    await linkChat({ sessionId: 's1', ownerGitDir: gits.main, cwd: '/r', targetGitDir: gits.a, title: 'Fix it' });
    return { original, copy };
  }

  it("removes an unchanged copy, and points the worktree's record back at the original", async () => {
    const { removeChatCopies } = await import('../../../../src/features/chats/chats');
    const home = makeTempDir();
    const gits = { main: makeTempDir(), a: makeTempDir() };
    cleanup.push(home, gits.main, gits.a);
    const { original, copy } = await copied(home, gits, 'sdk-cli');
    const worktrees = [
      { root: '/r', gitDir: gits.main },
      { root: '/r/.worktrees/a', gitDir: gits.a },
    ];

    expect(await removeChatCopies({ root: '/r', gitDir: gits.main, worktrees, home })).toEqual(['s1']);
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.existsSync(original)).toBe(true);
    expect(await readChatRecords(gits.main)).toEqual([]);
    const [record] = await readChatRecords(gits.a);
    expect(record).toMatchObject({ sessionId: 's1', linkedBy: 'cwd', cwd: '/r/.worktrees/a', linkedDirs: [] });
    expect(record!.home).toBeUndefined();
    expect(record!.firstPrompt).toBeUndefined();
    // Done once: there's nothing left to put back.
    expect(await removeChatCopies({ root: '/r', gitDir: gits.main, worktrees, home })).toEqual([]);
  });

  it('keeps a copy that was continued, and a chat started here for the worktree', async () => {
    const { removeChatCopies } = await import('../../../../src/features/chats/chats');
    const home = makeTempDir();
    const gits = { main: makeTempDir(), a: makeTempDir() };
    cleanup.push(home, gits.main, gits.a);
    const { original, copy } = await copied(home, gits, 'claude-vscode');
    fs.appendFileSync(copy, `${JSON.stringify({ type: 'user', message: { content: 'And the tests' } })}\n`);
    const worktrees = [
      { root: '/r', gitDir: gits.main },
      { root: '/r/.worktrees/a', gitDir: gits.a },
    ];
    expect(await removeChatCopies({ root: '/r', gitDir: gits.main, worktrees, home })).toEqual([]);
    expect(fs.existsSync(copy)).toBe(true);
    fs.rmSync(original);
    expect(await removeChatCopies({ root: '/r', gitDir: gits.main, worktrees, home })).toEqual([]);
    expect((await readChatRecords(gits.a))[0]).toMatchObject({ linkedBy: 'manual', cwd: '/r' });
  });
});

describe("an agent's chat", () => {
  it('is known by its entrypoint, and reads as Markdown with its tool calls folded', async () => {
    const { isHeadless } = await import('../../../../src/features/chats/chats');
    const { transcriptMarkdown } = await import('../../../../src/features/chats/transcriptMarkdown');
    const raw = [
      { type: 'user', entrypoint: 'sdk-cli', message: { content: 'You are agent Nova-7' } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'hm' },
            { type: 'text', text: 'Looking.' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls <dir>' } },
          ],
        },
      },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.ts\n```x```' }] } },
      { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'A subagent' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');
    expect(isHeadless(parseTranscript('s', raw, now))).toBe(true);
    expect(isHeadless(parseTranscript('s', raw.replace('sdk-cli', 'claude-vscode'), now))).toBe(false);
    const md = transcriptMarkdown(raw, 'Nova-7 · BL-1');
    expect(md).toContain('# Nova-7 · BL-1');
    expect(md).toContain('## You\n\n> You are agent Nova-7');
    expect(md).toContain('<details><summary>Bash: ls &lt;dir&gt;</summary>');
    expect(md).toContain('````\na.ts\n```x```\n````');
    expect(md).not.toContain('subagent');
    expect(md).not.toContain('hm');
    // One heading for Claude's whole turn, its tool results included.
    expect(md.match(/## Claude/g)).toHaveLength(1);
  });
});

describe('session id validation', () => {
  it('ignores records and transcripts whose id is not a plain session id', async () => {
    const { isSessionId, transcriptPath } = await import('../../../../src/features/chats/chats');
    expect(isSessionId('7d3f2c1e-5a4b-4c3d-9e8f-0a1b2c3d4e5f')).toBe(true);
    for (const bad of ['../x', 'a/b', '..', '', '-rf', 'a b', 'x'.repeat(200)]) expect(isSessionId(bad)).toBe(false);
    expect(parseChatRecord(JSON.stringify({ sessionId: '../../evil', state: 'done', updatedAt: now.toISOString() }))).toBeUndefined();
    expect(() => transcriptPath('/r', '../../.bashrc')).toThrow(/session id/);
    const home = makeTempDir();
    cleanup.push(home);
    const project = path.join(home, 'projects', encodeProjectDir('/r'));
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'good-1.jsonl'), '');
    fs.writeFileSync(path.join(project, '..weird.jsonl'), '');
    expect((await readTranscripts('/r', home)).map((t) => t.sessionId)).toEqual(['good-1']);
  });
});

describe('the model and effort of a chat', () => {
  it("are its last reply's, not a subagent's", async () => {
    const { parseTranscript } = await import('../../../../src/features/chats/chats');
    const line = (o: object) => JSON.stringify(o);
    const raw = [
      line({ type: 'user', timestamp: '2026-10-11T08:00:00Z', message: { content: 'Fix it' } }),
      line({ type: 'assistant', effort: 'medium', message: { model: 'claude-sonnet-5-5' } }),
      line({ type: 'assistant', effort: 'high', message: { model: 'claude-opus-5-5' } }),
      line({ type: 'assistant', isSidechain: true, effort: 'low', message: { model: 'claude-haiku-5-5' } }),
      '',
    ].join('\n');
    expect(parseTranscript('s', raw, new Date())).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
  });
});

describe('reading only what is new in a growing transcript', () => {
  const sid = '7d3f2c1e-5a4b-4c3d-9e8f-0a1b2c3d4e5f';
  const line = (o: object) => `${JSON.stringify(o)}\n`;
  const facts = (i?: TranscriptInfo) => ({ title: i?.title, firstPrompt: i?.firstPrompt, startedAt: i?.startedAt, model: i?.model, effort: i?.effort });
  /** What a whole-file parse of `raw` says: the reference for what an incremental read must say. */
  const whole = (raw: string) => facts(parseTranscript(sid, raw, now));
  function setup(): { home: string; file: string } {
    const home = makeTempDir();
    cleanup.push(home);
    const file = transcriptPath('/r', sid, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return { home, file };
  }
  const reply = (model: string, effort?: string) => line({ type: 'assistant', effort, message: { model } });

  it('reads appended lines and keeps what it had read', async () => {
    const { home, file } = setup();
    let raw = line({ type: 'user', timestamp: '2026-10-10T09:00:00Z', message: { content: 'Fix login' } }) + reply('claude-sonnet-5-5', 'medium');
    fs.writeFileSync(file, raw);
    expect(facts(await readTranscript('/r', sid, home))).toEqual(whole(raw));
    const added = reply('claude-opus-5-5', 'high') + line({ type: 'ai-title', aiTitle: 'Login fix' });
    raw += added;
    fs.appendFileSync(file, added);
    expect(facts(await readTranscript('/r', sid, home))).toEqual(whole(raw));
    expect(await readTranscript('/r', sid, home)).toMatchObject({ title: 'Login fix', model: 'claude-opus-5-5', effort: 'high' });
  });

  it('waits for a partial last line until its newline is written', async () => {
    const { home, file } = setup();
    const first = line({ type: 'user', timestamp: '2026-10-10T09:00:00Z', message: { content: 'Migrate the db' } });
    const second = line({ type: 'ai-title', aiTitle: 'DB migration' });
    fs.writeFileSync(file, first + second.slice(0, 20));
    expect(facts(await readTranscript('/r', sid, home))).toEqual(whole(first));
    fs.appendFileSync(file, second.slice(20, -1));
    expect(facts(await readTranscript('/r', sid, home))).toEqual(whole(first));
    fs.appendFileSync(file, '\n');
    expect(facts(await readTranscript('/r', sid, home))).toEqual(whole(first + second));
    expect((await readTranscript('/r', sid, home))?.title).toBe('DB migration');
  });

  it('reads the file again when it was rewritten or shrank', async () => {
    const { home, file } = setup();
    const a = line({ type: 'user', timestamp: '2026-10-10T09:00:00Z', message: { content: 'Old chat about CI' } }) + reply('claude-haiku-5-5');
    fs.writeFileSync(file, a);
    expect((await readTranscript('/r', sid, home))?.firstPrompt).toBe('Old chat about CI');
    const b = line({ type: 'user', timestamp: '2026-10-11T09:00:00Z', message: { content: 'A new chat' } });
    fs.writeFileSync(file, b);
    expect(facts(await readTranscript('/r', sid, home))).toEqual(whole(b));
    fs.writeFileSync(file, b + reply('claude-opus-5-5', 'low'));
    expect(facts(await readTranscript('/r', sid, home))).toEqual(whole(b + reply('claude-opus-5-5', 'low')));
  });

  it('gives the same answer as a whole-file parse for a large transcript with long lines and multi-byte text', async () => {
    const { home, file } = setup();
    const parts: string[] = [line({ type: 'user', timestamp: '2026-10-10T09:00:00Z', message: { content: 'Größe — 漢字 test' } })];
    // Mostly ~2.5 KB lines, and one line of about 360 KB, so reads cross chunk boundaries inside lines and characters.
    for (let n = 0; n < 2200; n++) {
      const content = n === 5 ? 'é漢🙂'.repeat(40_000) : `${'é漢🙂'.repeat(30)}${'x'.repeat(2000)}`;
      parts.push(line({ type: 'user', message: { content: [{ type: 'tool_result', content }] } }), reply('claude-opus-5-5', 'high'));
    }
    const raw = parts.join('');
    expect(Buffer.byteLength(raw)).toBeGreaterThan(5 * 1024 * 1024);
    fs.writeFileSync(file, raw);
    expect(facts(await readTranscript('/r', sid, home))).toEqual(whole(raw));
  });

  it('gives the same answer however the file is cut into appends', async () => {
    const { home, file } = setup();
    const lines = [
      line({ type: 'queue-operation', timestamp: '2026-10-10T09:00:00Z' }),
      line({ type: 'user', isMeta: true, message: { content: 'meta' } }),
      line({ type: 'user', timestamp: '2026-10-10T09:00:02Z', message: { content: 'Ünïcode prompt' } }),
      line({ type: 'assistant', isSidechain: true, effort: 'low', message: { model: 'claude-haiku-5-5' } }),
      reply('claude-sonnet-5-5', 'medium'),
      reply('<synthetic>'),
      line({ type: 'custom-title', customTitle: 'feature/x: Mine' }),
      line({ type: 'ai-title', aiTitle: 'Something' }),
      reply('claude-opus-5-5'),
    ];
    const raw = lines.join('');
    fs.writeFileSync(file, '');
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    let done = '';
    for (let at = 0; at < raw.length;) {
      const size = 1 + rnd(40);
      const piece = Buffer.from(raw).subarray(at, at + size);
      fs.appendFileSync(file, piece);
      at += size;
      done = Buffer.from(raw).subarray(0, at).toString('utf8');
      const complete = done.slice(0, done.lastIndexOf('\n') + 1);
      expect(facts(await readTranscript('/r', sid, home))).toEqual(whole(complete));
    }
    expect(done).toBe(raw);
    // The custom title wins over the AI title. The last reply has a model and no effort, so the chat has no effort either.
    expect(await readTranscript('/r', sid, home)).toMatchObject({ title: 'feature/x: Mine', model: 'claude-opus-5-5' });
  });
});

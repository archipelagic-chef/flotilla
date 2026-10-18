import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeProjectDir,
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
  transcriptPath,
  unlinkChat,
  type ChatRecord,
  type TranscriptInfo,
} from '../../../../src/features/chats/chats';
import { makeTempDir, removeDir } from '../../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));
const now = new Date('2026-10-10T12:00:00Z');
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
const rec = (o: Partial<ChatRecord> & { sessionId: string }): ChatRecord => ({ source: 'claude-code', state: 'done', linkedBy: 'cwd', linkedDirs: [], updatedAt: ago(1), ...o });
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
      JSON.stringify({ sessionId: 's2', state: 'working', linkedBy: 'cwd', cwd: '/r', firstPrompt: 'Original', linkedDirs: ['/x/.git'], updatedAt: now.toISOString() }),
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
    expect(chats.find((c) => c.id === 'stuck')).toMatchObject({ state: 'done', open: true });
    expect(chats.find((c) => c.id === 'yesterday')).toMatchObject({ open: false });
    expect(mostUrgent([])).toBeUndefined();
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
    expect(parseTranscript('s', `${JSON.stringify({ type: 'ai-title', aiTitle: 'A' })}\n${JSON.stringify({ type: 'custom-title', customTitle: 'Mine' })}\n`, now).title).toBe('Mine');
    expect(await tagTranscriptTitle(path.join(dir, 'none.jsonl'), 'x', 'y')).toBe('missing');
  });
});

describe('importTranscript', () => {
  it('copies a transcript and its folder into another project, once', async () => {
    const { importTranscript, transcriptPath } = await import('../../../../src/features/chats/chats');
    const home = makeTempDir();
    cleanup.push(home);
    const src = transcriptPath('/r/.worktrees/a', 's1', home);
    fs.mkdirSync(path.join(path.dirname(src), 's1', 'subagents'), { recursive: true });
    fs.writeFileSync(src, 'original\n');
    fs.writeFileSync(path.join(path.dirname(src), 's1', 'subagents', 'x.jsonl'), 'sub\n');

    expect(await importTranscript('/r/.worktrees/a', '/r', 's1', home)).toBe('copied');
    const dest = transcriptPath('/r', 's1', home);
    expect(fs.readFileSync(dest, 'utf8')).toBe('original\n');
    expect(fs.existsSync(path.join(path.dirname(dest), 's1', 'subagents', 'x.jsonl'))).toBe(true);
    fs.writeFileSync(dest, 'continued here\n');
    expect(await importTranscript('/r/.worktrees/a', '/r', 's1', home)).toBe('exists');
    expect(fs.readFileSync(dest, 'utf8')).toBe('continued here\n');
    expect(await importTranscript('/r/.worktrees/a', '/r', 'nope', home)).toBe('missing');
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
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
    let done = '';
    for (let at = 0; at < raw.length; ) {
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

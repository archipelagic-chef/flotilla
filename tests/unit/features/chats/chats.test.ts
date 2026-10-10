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
  readTranscripts,
  readUnlinked,
  tagTranscriptTitle,
  unlinkChat,
  type ChatRecord,
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

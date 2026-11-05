import {
  describe,
  expect,
  it,
} from 'vitest';
import type {
  ChatView,
  WorkstreamView,
} from '../../../src/webview/protocol';
import {
  chatList,
  listState,
} from '../../../src/webview/ui/chatList';

/** BL-286: the Chats view is one list of every chat, newest first. */
const chat = (id: string, at: number, over: Partial<ChatView> = {}): ChatView =>
  ({ id, title: id, state: 'done', open: true, linkedBy: 'cwd', age: '1m', at, ...over }) as ChatView;
const ws = (key: string, label: string, chats: ChatView[]): WorkstreamView => ({ key, label, branch: key, chats }) as unknown as WorkstreamView;

describe('the Chats list', () => {
  it('lists every worktree’s chats together, newest first', () => {
    const list = chatList([ws('main', 'main', [chat('a', 10), chat('b', 30)]), ws('f', 'BL-7', [chat('c', 20)])]);
    expect(list.map((c) => c.chat.id)).toEqual(['b', 'c', 'a']);
  });

  it('shows a chat linked into another worktree once, where it runs', () => {
    const linked = chat('a', 10, { linkedBy: 'edit', runsIn: 'f' });
    const list = chatList([ws('main', 'main', [linked]), ws('f', 'BL-7', [chat('a', 10)])]);
    expect(list).toHaveLength(1);
    expect(list[0].ws.key).toBe('f');
    expect(list[0].runsIn.key).toBe('f');
  });

  it('shows the newer copy of a chat that two worktrees list as their own', () => {
    const list = chatList([ws('a', 'BL-1', [chat('x', 10, { state: 'ended', open: false })]), ws('b', 'BL-2', [chat('x', 20)])]);
    expect(list.map((c) => c.runsIn.key)).toEqual(['b']);
  });

  it("names the ticket: the agent's, else the worktree's", () => {
    const agent = chat('a', 10, { detached: true, agent: { name: 'Nova-7', item: 'BL-9' } });
    const list = chatList([ws('f', 'BL-7', [agent, chat('b', 5)]), ws('main', 'main', [chat('c', 1)])]);
    expect(list.map((c) => c.ticket)).toEqual(['BL-9', 'BL-7', undefined]);
  });

  it("leaves out Flotilla's agents when they're hidden", () => {
    const list = chatList([ws('main', 'main', [chat('a', 10, { detached: true }), chat('b', 5)])], { hideDetached: true });
    expect(list.map((c) => c.chat.id)).toEqual(['b']);
  });

  it('says each state in a word', () => {
    expect(listState(chat('a', 1, { unseen: true }))).toBe('unseen');
    expect(listState(chat('a', 1))).toBe('done');
    expect(listState(chat('a', 1, { state: 'waiting-for-input', unseen: true }))).toBe('waiting');
    expect(listState(chat('a', 1, { state: 'working', stalled: true }))).toBe('stopped');
    expect(listState(chat('a', 1, { open: false }))).toBe('ended');
  });
});

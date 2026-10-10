import { describe, expect, it } from 'vitest';
import { PENDING_LINK_TTL_MS, PendingLinks } from '../../../../src/features/chats/pendingLinks';

describe('PendingLinks', () => {
  it('links the first unknown session to the oldest request, one session per request', () => {
    const links = new PendingLinks();
    links.add('/r/.git/worktrees/a', ['old'], 0);
    links.add('/r/.git/worktrees/b', ['old'], 10);
    expect(links.match(['old'], 20)).toEqual([]);
    expect(links.match(['old', 'new1'], 30)).toEqual([{ targetGitDir: '/r/.git/worktrees/a', sessionId: 'new1' }]);
    expect(links.size).toBe(1);
    // new1 was claimed by a; only a further session matches b.
    expect(links.match(['old', 'new1'], 40)).toEqual([]);
    expect(links.match(['old', 'new1', 'new2'], 50)).toEqual([{ targetGitDir: '/r/.git/worktrees/b', sessionId: 'new2' }]);
  });

  it('matches two new sessions to two requests at once', () => {
    const links = new PendingLinks();
    links.add('A', [], 0);
    links.add('B', [], 0);
    expect(links.match(['s1', 's2'], 1)).toEqual([
      { targetGitDir: 'A', sessionId: 's1' },
      { targetGitDir: 'B', sessionId: 's2' },
    ]);
  });

  it('drops requests nobody acted on', () => {
    const links = new PendingLinks();
    links.add('A', [], 0);
    expect(links.match(['s1'], PENDING_LINK_TTL_MS + 1)).toEqual([]);
    expect(links.size).toBe(0);
  });
});

import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ Uri: {}, window: {}, workspace: {}, commands: {}, EventEmitter: class {} }));

describe('images in tickets', () => {
  it('replaces the sources it can, and keeps the others', async () => {
    const { replaceImages } = await import('../../../src/ui/backlog/ticketPanel');
    const html = '<p><img src="a.png" alt="a"> <img alt="b" src="https://x/b.png"> <img src="a.png"></p>';
    const out = await replaceImages(html, async (src) => (src === 'a.png' ? 'data:image/png;base64,AAA' : undefined));
    expect(out).toBe('<p><img src="data:image/png;base64,AAA" alt="a"> <img alt="b" src="https://x/b.png"> <img src="data:image/png;base64,AAA"></p>');
  });

  it('fetches Jira\'s own images with the login, and only those', async () => {
    const { JiraSource } = await import('../../../src/features/backlog/sources/jira');
    const seen: Array<{ url: string; auth?: string }> = [];
    const fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url, auth: init?.headers?.Authorization });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({}),
        text: async () => '',
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        headers: { get: () => 'image/png' },
      };
    };
    const jira = new JiraSource({ id: 'jira:1', kind: 'jira', site: 'https://acme.atlassian.net', email: 'a@b.c', jql: '', prefix: 'OPS' } as never, 'token', fetch);
    expect(await jira.image('/rest/api/2/attachment/content/10001')).toEqual({ type: 'image/png', data: Buffer.from([1, 2, 3]) });
    expect(seen[0].url).toBe('https://acme.atlassian.net/rest/api/2/attachment/content/10001');
    expect(seen[0].auth).toMatch(/^Basic /);
    expect(await jira.image('https://evil.example/x.png')).toBeUndefined();
    expect(seen).toHaveLength(1);
  });
});

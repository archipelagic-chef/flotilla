import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY_BACKLOG, addItem, acceptItem, childrenOf } from '../../../src/features/backlog/backlog';
import { addProposal, parseProposal, takeInbox } from '../../../src/features/backlog/inbox';
import { LocalBacklog } from '../../../src/features/backlog/localBacklog';
import { initRepo, removeDir } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

const PROPOSAL = `---
parent: bl-1
priority: High
start: yes
branch: feature/BL-1-logout
agent: Nova-7
---
# Log out of the IdP too

When signing out, end the IdP session.

- [ ] SAML single logout
`;

describe('backlog inbox', () => {
  it('reads a proposal: front matter, title and description', () => {
    expect(parseProposal(PROPOSAL)).toEqual({
      title: 'Log out of the IdP too',
      description: 'When signing out, end the IdP session.\n\n- [ ] SAML single logout',
      parent: 'BL-1',
      priority: 'High',
      start: true,
      branch: 'feature/BL-1-logout',
      agent: 'Nova-7',
    });
    expect(parseProposal('# Just a title')).toMatchObject({ title: 'Just a title', start: false });
    expect(parseProposal('No heading here')).toEqual({ error: expect.stringMatching(/no title/) });
  });

  it('adds a proposal as a proposed item, part of its parent, on its branch', () => {
    const data = addItem(EMPTY_BACKLOG, 'SSO', 'BL', new Date()).data;
    const p = parseProposal(PROPOSAL);
    if ('error' in p) throw new Error(p.error);
    const r = addProposal(data, p, { prefix: 'BL', mode: 'propose', now: new Date(), taken: [] });
    if ('error' in r) throw new Error(r.error);
    expect(r.item).toMatchObject({ id: 'BL-2', parent: 'BL-1', priority: 'high', status: 'doing', branches: ['feature/BL-1-logout'], proposed: { by: 'Nova-7' } });
    expect(childrenOf(r.data, 'BL-1').map((i) => i.id)).toEqual(['BL-2']);
    expect(acceptItem(r.data, 'BL-2').items.find((i) => i.id === 'BL-2')!.proposed).toBeUndefined();
    // Added at once in 'add' mode; a missing parent is refused.
    expect(addProposal(data, { ...p, start: false }, { prefix: 'OPS', mode: 'propose', now: new Date(), taken: [] })).toMatchObject({ item: { id: 'BL-2' } });
    const direct = addProposal(data, { title: 'X', description: '', start: false }, { prefix: 'BL', mode: 'add', now: new Date(), taken: [] });
    expect('item' in direct && direct.item.proposed).toBeUndefined();
    expect(addProposal(data, { title: 'X', description: '', start: false, parent: 'BL-9' }, { prefix: 'BL', mode: 'add', now: new Date(), taken: [] })).toEqual({
      error: expect.stringMatching(/BL-9/),
    });
  });

  it('takes files from the inbox, answering with the id or the problem', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const store = new LocalBacklog(repo, path.join(repo, '.git'));
    await store.change((d) => addItem(d, 'SSO', 'BL', new Date()).data);
    const inbox = path.join(store.dir, 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    const old = new Date(Date.now() - 5000);
    for (const [name, text] of [
      ['a.md', PROPOSAL],
      ['b.md', 'no title'],
    ]) {
      fs.writeFileSync(path.join(inbox, name), text);
      fs.utimesSync(path.join(inbox, name), old, old);
    }
    const started: string[] = [];
    const added = await takeInbox(store, { prefix: 'BL', mode: 'propose', taken: [], onStarted: async (item, branch) => void started.push(`${item.id} ${branch}`) });
    expect(added.map((i) => i.id)).toEqual(['BL-2']);
    expect(started).toEqual(['BL-2 feature/BL-1-logout']);
    expect(fs.readFileSync(path.join(inbox, 'a.added'), 'utf8').trim()).toBe('BL-2');
    expect(fs.readFileSync(path.join(inbox, 'b.error'), 'utf8')).toMatch(/no title/);
    expect(fs.existsSync(path.join(inbox, 'a.md'))).toBe(false);
    const ticket = await store.readTicket({ id: 'BL-2', title: '' });
    expect(ticket).toMatchObject({ title: 'Log out of the IdP too', activity: [{ author: 'Agent Nova-7', body: 'Added this ticket and started on it.' }] });
  });
});

describe('claims', () => {
  it('starts an agent on an existing item, on its branch', () => {
    const data = addItem(EMPTY_BACKLOG, 'SSO', 'BL', new Date()).data;
    const p = parseProposal('---\nclaim: bl-1\nbranch: fix/sso\nagent: Nova-7\n---\n');
    expect(p).toMatchObject({ claim: 'BL-1', start: true, branch: 'fix/sso', agent: 'Nova-7' });
    if ('error' in p) throw new Error(p.error);
    const r = addProposal(data, p, { prefix: 'BL', mode: 'propose', now: new Date(), taken: [] });
    expect(r).toMatchObject({ item: { id: 'BL-1', status: 'doing', branches: ['fix/sso'] } });
    expect('item' in r && r.item.proposed).toBeUndefined();
    expect(addProposal(data, { ...p, claim: 'BL-9' }, { prefix: 'BL', mode: 'propose', now: new Date(), taken: [] })).toEqual({ error: expect.stringMatching(/BL-9/) });
  });
});

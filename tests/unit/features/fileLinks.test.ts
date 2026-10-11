import { describe, expect, it } from 'vitest';
import { agentGuide } from '../../../src/features/backlog/inbox';
import { reviewNotes, userRevisionPrompt } from '../../../src/features/backlog/review';
import { parseFileLink } from '../../../src/features/backlog/ticket';

describe('links to files in tickets', () => {
  it('reads the path and the lines', () => {
    expect(parseFileLink('src/api/limit.ts#L42')).toEqual({ path: 'src/api/limit.ts', start: 42 });
    expect(parseFileLink('src/api/limit.ts#L42-L60')).toEqual({ path: 'src/api/limit.ts', start: 42, end: 60 });
    expect(parseFileLink('./src/a%20b.ts:7')).toEqual({ path: 'src/a b.ts', start: 7 });
    expect(parseFileLink('src/a.ts')).toEqual({ path: 'src/a.ts' });
    expect(parseFileLink('BL-2/flow.svg')).toEqual({ path: 'BL-2/flow.svg' });
    expect(parseFileLink('/abs/x.ts#heading')).toEqual({ path: '/abs/x.ts' });
    expect(parseFileLink('C:\\repo\\x.ts')).toEqual({ path: 'C:\\repo\\x.ts' });
  });
});

describe('review notes', () => {
  it('ask reports handed over for review to say what to look at, with file links and pictures', () => {
    const notes = reviewNotes({ id: 'BL-2', backlogDir: '/r/.flotilla/backlog' });
    expect(notes).toMatch(/#### How to review/);
    expect(notes).toMatch(/\[src\/api\/limit\.ts:42\]\(src\/api\/limit\.ts#L42\)/);
    expect(notes).toMatch(/\/r\/\.flotilla\/backlog\/BL-2\//);
    expect(notes).toMatch(/!\[What it shows\]\(BL-2\/name\.svg\)/);
    expect(userRevisionPrompt({ item: { id: 'BL-2' }, ticket: '/r/.flotilla/backlog/BL-2.md', feedback: 'x' })).toContain(notes);
    expect(agentGuide('/r/.flotilla/backlog', 'add')).toMatch(/How to review/);
  });
});

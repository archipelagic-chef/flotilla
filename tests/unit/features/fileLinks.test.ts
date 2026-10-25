import { describe, expect, it } from 'vitest';
import { agentGuide } from '../../../src/features/backlog/inbox';
import {
  reviewerPrompt,
  reviewNotes,
  showNotes,
  userRevisionPrompt,
} from '../../../src/features/backlog/review';
import { REPORT_FORMAT } from '../../../src/features/backlog/report';
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

  it('ask agents to show what has a shape, next to its text: diagrams, screenshots, GIFs and videos', () => {
    const show = showNotes({ id: 'BL-2', backlogDir: '/r/.flotilla/backlog' });
    expect(show).toMatch(/^Show rather than tell/);
    expect(show).toContain('next to the text it explains (not at the end)');
    expect(show).toContain('```mermaid block');
    expect(show).toContain('two screenshots');
    expect(show).toContain('demo GIF or video (MP4 or WebM)');
    expect(show).toContain('/r/.flotilla/backlog/BL-2/');
    expect(show).toContain('images and GIFs at most 2 MB, videos at most 10 MB');
    // In the guide, every prompt that asks for a report to review, and the report format.
    expect(reviewNotes({ id: 'BL-2', backlogDir: '/r/.flotilla/backlog' })).toContain(show);
    expect(agentGuide('/r/.flotilla/backlog', 'add')).toContain('Show rather than tell');
    expect(REPORT_FORMAT).toContain('```mermaid block');
  });

  it('have the reviewer ask for something to see when a UI change has none', () => {
    for (const round of [1, 2]) {
      const prompt = reviewerPrompt({ item: { id: 'BL-2', title: 'x' }, reviewer: 'Vega-2', ticket: '/t/BL-2.md', branch: 'b', base: 'main', round });
      expect(prompt).toContain('If the work changes what the user sees (the UI), the report must show it');
      expect(prompt).toContain('request one in your checklist');
    }
  });
});

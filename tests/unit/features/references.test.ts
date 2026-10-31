import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  findReferences,
  linkReferences,
  mentionsIn,
  parseReferenceLink,
  resolveEntry,
} from '../../../src/features/backlog/references';
import { parseTicket } from '../../../src/features/backlog/ticket';

const ids = new Set(['BL-1', 'BL-102', 'PROJ-12']);
const known = (id: string) => ids.has(id);
const found = (text: string) => findReferences(text, known).map((r) => (r.anchor ? `${r.id}#${r.anchor}` : r.id));
const lookup = (id: string) => (ids.has(id) ? { id: id === 'PROJ-12' ? 'BL-1' : id, title: `Title <${id}>`, status: 'In Progress' } : undefined);

describe('finding references (BL-130)', () => {
  it('finds ticket ids and linked issues’ keys at word boundaries', () => {
    expect(found('See BL-102, and PROJ-12. (BL-1)')).toEqual(['BL-102', 'PROJ-12', 'BL-1']);
    expect(found('XBL-102 BL-1020 BL-102a src/BL-102.ts BL-102-x')).toEqual([]);
  });

  it('leaves unknown ids as text', () => {
    expect(found('BL-7 and UTF-8 and BL-1')).toEqual(['BL-1']);
  });

  it('finds a comment’s reference', () => {
    expect(found('As BL-102#2026-10-20-1604-you said.')).toEqual(['BL-102#2026-10-20-1604-you']);
  });

  it('skips code spans and code blocks', () => {
    expect(found('`BL-1` and ``x BL-102 x`` but BL-102')).toEqual(['BL-102']);
    expect(found('```\nBL-1\n```\nBL-102\n~~~ts\nPROJ-12\n~~~')).toEqual(['BL-102']);
  });
});

describe('linking references in html', () => {
  it('links text, with the title and status on hover', () => {
    expect(linkReferences('<p>See BL-102#2026-10-20-1604-you.</p>', lookup)).toBe(
      '<p>See <a class="ticket-ref" href="flotilla-ref:BL-102#2026-10-20-1604-you" title="BL-102: Title &lt;BL-102&gt; · In Progress\nA comment in it">BL-102#2026-10-20-1604-you</a>.</p>',
    );
  });

  it('opens the local ticket a linked issue’s key belongs to', () => {
    expect(linkReferences('<p>PROJ-12</p>', lookup)).toContain('href="flotilla-ref:BL-1"');
  });

  it('leaves code, links, attributes and unknown ids alone', () => {
    const html = '<p><code>BL-1</code> <pre><code>BL-102</code></pre> <a href="x" title="BL-1">BL-1</a> <img alt="BL-1"> BL-9</p>';
    expect(linkReferences(html, lookup)).toBe(html);
  });
});

describe('reference links', () => {
  it('are a ticket and an entry', () => {
    expect(parseReferenceLink('flotilla-ref:BL-102#a-b', 'BL-1')).toEqual({ id: 'BL-102', anchor: 'a-b' });
    expect(parseReferenceLink('BL-102.md#a', 'BL-1')).toEqual({ id: 'BL-102', anchor: 'a' });
    expect(parseReferenceLink('../backlog/BL-102.md', 'BL-1')).toEqual({ id: 'BL-102' });
    expect(parseReferenceLink('BL-102', 'BL-1')).toEqual({ id: 'BL-102' });
    expect(parseReferenceLink('#2026-10-20-1604-you', 'BL-1')).toEqual({ id: 'BL-1', anchor: '2026-10-20-1604-you' });
  });

  it('aren’t other files or links', () => {
    expect(parseReferenceLink('src/BL-102', 'BL-1')).toBeUndefined();
    expect(parseReferenceLink('src/a.ts#L10', 'BL-1')).toBeUndefined();
    expect(parseReferenceLink('https://x/BL-1', 'BL-1')).toBeUndefined();
  });
});

const TICKET = parseTicket(
  [
    '# Two',
    '',
    'Depends on: BL-1',
    '',
    '## Activity',
    '',
    '### 2026-10-20 16:04 · You',
    'Like BL-102 and BL-102#x; not BL-2 (this one).',
    '',
    '### 2026-10-20 16:04 · You',
    '↩ [Reply to You, 2026-10-20 16:04](#2026-10-20-1604-you)',
    'Nothing.',
    '',
    '### 2026-10-20 16:05 · Flotilla',
    'It waits for BL-102.',
    '',
  ].join('\n'),
);

describe('mentions', () => {
  it('are the entries and the description that refer to other tickets, not Flotilla’s notes', () => {
    const m = mentionsIn('BL-2', TICKET, (id) => ['BL-1', 'BL-2', 'BL-102'].includes(id));
    expect([...m.keys()]).toEqual(['BL-1', 'BL-102']);
    expect(m.get('BL-1')).toEqual([{ from: 'BL-2', author: '', date: '' }]);
    expect(m.get('BL-102')).toEqual([
      { from: 'BL-2', anchor: '2026-10-20-1604-you', author: 'You', date: '2026-10-20 16:04', text: 'Like BL-102 and BL-102#x; not BL-2 (this one).' },
    ]);
  });
});

describe('resolving a comment’s reference', () => {
  it('finds the entry, also the second of a minute', () => {
    expect(resolveEntry(TICKET, '2026-10-20-1604-you')).toBe(0);
    expect(resolveEntry(TICKET, '2026-10-20-1604-you-2')).toBe(1);
  });

  it('is undefined for one that’s gone', () => {
    expect(resolveEntry(TICKET, '2026-10-20-1604-you-3')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import type { BacklogData, BacklogItem } from '../../../src/features/backlog/backlog';
import {
  checkingOf,
  dueChecks,
  endCheck,
  noteChange,
  parseSisterReply,
  reworked,
  SISTER_DEBOUNCE_MS,
  sisterCheckPrompt,
  sisterCheckTools,
  sistersOf,
  verdictLine,
} from '../../../src/features/backlog/sisterCheck';

const it_ = (id: string, over: Partial<BacklogItem> = {}): BacklogItem => ({ id, title: `Title ${id}`, status: 'todo', created: '', ...over });
const data = (...items: BacklogItem[]): BacklogData => ({ items }) as BacklogData;
const none = new Map<string, string>();
const now = new Date('2026-10-28T12:00:00Z');

describe('sistersOf', () => {
  const backlog = data(
    it_('BL-1'),
    it_('BL-2', { parent: 'BL-1' }),
    it_('BL-3', { parent: 'BL-1', status: 'doing' }),
    it_('BL-4', { parent: 'BL-1', status: 'done' }),
    it_('BL-5', { parent: 'BL-1', discarded: { at: '' } }),
    it_('BL-6'),
    it_('BL-7', { proposed: {} }),
  );

  it("is the epic's other open parts", () => {
    expect(sistersOf(backlog, 'BL-2', none).map((i) => i.id)).toEqual(['BL-3']);
  });

  it('takes in the open tickets that depend on it', () => {
    const d = new Map([
      ['BL-6', 'Depends on: BL-2'],
      ['BL-7', 'Depends on: BL-2'],
    ]);
    expect(sistersOf(backlog, 'BL-2', d).map((i) => i.id)).toEqual(['BL-3', 'BL-6', 'BL-7']);
  });

  it("is an epic's open parts, for the epic", () => {
    expect(sistersOf(backlog, 'BL-1', none).map((i) => i.id)).toEqual(['BL-2', 'BL-3']);
  });

  it('is none for a ticket without a parent, parts or dependents', () => {
    expect(sistersOf(backlog, 'BL-6', none)).toEqual([]);
  });
});

describe('reworked', () => {
  const before = "**When it's done:** a thing.\n\nWhy.\n\n- [ ] One\n- [ ] Two";
  it('is a change of "When it\'s done"', () => {
    expect(reworked(before, before.replace('a thing', 'another thing'))).toBe(true);
  });
  it('is a change of the acceptance criteria', () => {
    expect(reworked(before, `${before}\n- [ ] Three`)).toBe(true);
  });
  it("isn't ticking a box", () => {
    expect(reworked(before, before.replace('- [ ] One', '- [x] One'))).toBe(false);
  });
  it('is more than a few lines, not a few', () => {
    expect(reworked(before, before.replace('Why.', 'Why, said better.'))).toBe(false);
    expect(reworked(before, before.replace('Why.', 'A\nB\nC\nD'))).toBe(true);
  });
});

describe('noteChange', () => {
  const backlog = data(it_('BL-1'), it_('BL-2', { parent: 'BL-1' }), it_('BL-3', { parent: 'BL-1' }), it_('BL-6'));

  it('sets a check due a few minutes on, covering the sisters', () => {
    const next = noteChange(backlog, 'BL-2', 'merged', none, now);
    expect(next.items[1].sisterCheck).toEqual({
      reasons: ['merged'],
      due: new Date(now.getTime() + SISTER_DEBOUNCE_MS).toISOString(),
      covers: ['BL-3'],
    });
    expect(checkingOf(next, 'BL-3')).toBe('BL-2');
  });

  it('waits again on a change close after: one check, both reasons', () => {
    const later = new Date(now.getTime() + 60_000);
    const next = noteChange(noteChange(backlog, 'BL-2', 'described', none, now), 'BL-2', 'merged', none, later);
    expect(next.items[1].sisterCheck?.reasons).toEqual(['described', 'merged']);
    expect(next.items[1].sisterCheck?.due).toBe(new Date(later.getTime() + SISTER_DEBOUNCE_MS).toISOString());
    expect(dueChecks(next, new Date(later.getTime() + SISTER_DEBOUNCE_MS - 1))).toEqual([]);
    expect(dueChecks(next, new Date(later.getTime() + SISTER_DEBOUNCE_MS)).map((i) => i.id)).toEqual(['BL-2']);
  });

  it('is nothing for a ticket without a parent or dependents', () => {
    expect(noteChange(backlog, 'BL-6', 'merged', none, now)).toBe(backlog);
  });

  it('leaves a running check as it is, and an edit of a ticket being checked to that check', () => {
    const running = noteChange(backlog, 'BL-2', 'merged', none, now);
    running.items[1].sisterCheck!.session = 's';
    expect(noteChange(running, 'BL-2', 'described', none, now)).toBe(running);
    expect(noteChange(running, 'BL-3', 'described', none, now)).toBe(running);
    expect(noteChange(running, 'BL-3', 'merged', none, now).items[2].sisterCheck?.covers).toEqual(['BL-2']);
  });

  it('releases the sisters when it ends', () => {
    const next = endCheck(noteChange(backlog, 'BL-2', 'merged', none, now), 'BL-2');
    expect(next.items[1].sisterCheck).toBeUndefined();
    expect(checkingOf(next, 'BL-3')).toBeUndefined();
  });
});

describe('the prompt and tools', () => {
  it('may edit only the editable sisters', () => {
    expect(sisterCheckTools(['/b/BL-3.md'])).toEqual(['Read', 'Grep', 'Glob', 'Edit(//b/BL-3.md)']);
  });

  it('names the change, the sisters and the reply’s shape', () => {
    const p = sisterCheckPrompt({
      item: { id: 'BL-2', title: 'Two' },
      agent: 'Nova-1',
      ticket: '/b/BL-2.md',
      reasons: ['described', 'merged'],
      epic: { id: 'BL-1', ticket: '/b/BL-1.md' },
      sisters: [
        { id: 'BL-3', title: 'Three', ticket: '/b/BL-3.md', editable: true, status: 'To Do', relation: 'a part of BL-1 too' },
        { id: 'BL-4', title: 'Four', ticket: '/b/BL-4.md', editable: false, status: 'in progress', relation: 'depends on it' },
      ],
      base: 'main',
    });
    expect(p.startsWith('You are agent Nova-1, working on backlog item BL-2: "Two".')).toBe(true);
    expect(p).toContain('BL-2 had its description reworked, and was merged to main');
    expect(p).toContain('- BL-3 "Three" (To Do; a part of BL-1 too): /b/BL-3.md\n');
    expect(p).toContain('/b/BL-4.md (read only)');
    expect(p).toContain('"## <id> · <finding>"');
  });
});

describe('parseSisterReply', () => {
  it('reads the summary and each finding', () => {
    const reply = [
      'Checked BL-3 and BL-4 against the merge.',
      '',
      '## BL-3 · updated',
      'Took out the button: BL-2 built it.',
      '## BL-4 · **covered**',
      'All of it is on main.',
      '## BL-9 · updated',
      'Not one of its sisters.',
      '## BL-5 · unchanged',
    ].join('\n');
    expect(parseSisterReply(reply, ['BL-3', 'BL-4', 'BL-5'])).toEqual({
      summary: 'Checked BL-3 and BL-4 against the merge.',
      findings: [
        { id: 'BL-3', finding: 'updated', text: 'Took out the button: BL-2 built it.' },
        { id: 'BL-4', finding: 'covered', text: 'All of it is on main.' },
        { id: 'BL-5', finding: 'unchanged', text: '' },
      ],
    });
  });

  it('says why a sister needs you, in a line', () => {
    expect(verdictLine('BL-2', 'covered', 'All of it is on main.\nMore.')).toBe('Covered by BL-2: All of it is on main.');
    expect(verdictLine('BL-2', 'contradicts', '')).toBe("At odds with BL-2's change");
  });
});

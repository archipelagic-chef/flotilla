import { describe, expect, it } from 'vitest';
import {
  discussable,
  followUpPrompt,
  readyToStart,
  saysReadyToStart,
  shapingPrompt,
  shapingTools,
} from '../../../src/features/backlog/shaping';
import type { TicketEntry } from '../../../src/features/backlog/ticket';

const entry = (author: string, body: string): TicketEntry => ({ date: '2026-10-12 10:00', author, body });

describe('shaping', () => {
  it('notices "Ready to start." as the last line of a reply', () => {
    expect(saysReadyToStart('Agreed on the scope.\n\nReady to start.')).toBe(true);
    expect(saysReadyToStart('**Ready to start**\n')).toBe(true);
    expect(saysReadyToStart('Ready to start. Two questions remain.')).toBe(false);
    expect(saysReadyToStart('Ready for review.')).toBe(false);
    expect(saysReadyToStart('Ready to start.\n\nWhat about the title?')).toBe(false);
  });

  it('is ready when the newest reply of its agent says so, and nobody has written since', () => {
    expect(readyToStart([entry('You', 'Add a filter.'), entry('Agent Nova-7', 'Shall it match case?\n\nReady to start.')], 'Nova-7')).toBe(true);
    // A comment after the reply: not settled yet.
    expect(readyToStart([entry('Agent Nova-7', 'Ready to start.'), entry('You', 'Wait, also tags.')], 'Nova-7')).toBe(false);
    // Flotilla's notes don't count as a comment; another agent's reply doesn't count as this one's.
    expect(readyToStart([entry('Agent Nova-7', 'Ready to start.'), entry('Flotilla', 'Edited the description.')], 'Nova-7')).toBe(true);
    expect(readyToStart([entry('Agent Ada-2', 'Ready to start.')], 'Nova-7')).toBe(false);
    expect(readyToStart([entry('Agent Nova-7', 'Still asking.')], 'Nova-7')).toBe(false);
  });

  it('discusses proposals and To Do tickets only', () => {
    expect(discussable({ status: 'todo', proposed: { by: 'Ada-2' } })).toBe(true);
    expect(discussable({ status: 'todo' })).toBe(true);
    expect(discussable({ status: 'doing' })).toBe(false);
    expect(discussable({ status: 'review' })).toBe(false);
    expect(discussable({ status: 'done' })).toBe(false);
  });

  it('lets the agent edit its ticket and read the code, and nothing else', () => {
    expect(shapingTools('/work/repo/.flotilla/backlog/BL-45.md')).toEqual([
      'Read',
      'Grep',
      'Glob',
      'Edit(//work/repo/.flotilla/backlog/BL-45.md)',
    ]);
  });

  it('tells a new discussion what it is for and how it talks in the ticket', () => {
    const prompt = shapingPrompt({ item: { id: 'BL-45', title: 'Shape a ticket' }, agent: 'Nova-7', ticket: '/t/BL-45.md', now: '2026-10-12 21:50' });
    expect(prompt.startsWith('You are agent Nova-7, working on backlog item BL-45: "Shape a ticket".')).toBe(true);
    expect(prompt).toContain('You change no code');
    expect(prompt).toContain('"### 2026-10-12 21:50 · Agent Nova-7"');
    expect(prompt).toContain('never above an entry');
    expect(prompt).toContain('"Ready to start."');
    expect(prompt).toContain('Edit the ticket with the Edit tool');
  });

  it('tells a resumed discussion what changed, or that it was opened without a comment', () => {
    const comment = followUpPrompt({ agent: 'Nova-7', ticket: '/t/BL-45.md', opened: false, now: '2026-10-12 21:50' });
    expect(comment).toContain('wrote in the ticket since your last reply');
    const opened = followUpPrompt({ agent: 'Nova-7', ticket: '/t/BL-45.md', opened: true, now: '2026-10-12 21:50' });
    expect(opened).toContain('without a comment yet');
    expect(opened).toContain('"### 2026-10-12 21:50 · Agent Nova-7"');
  });
});

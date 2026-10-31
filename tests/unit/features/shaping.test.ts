import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  discussable,
  discussionLead,
  discussionPrompt,
  findDiscussionChat,
  followUpPrompt,
  isDiscussionChat,
  readyToStart,
  saysReadyToStart,
  shapingPrompt,
  shapingTools,
  summarizedSince,
} from '../../../src/features/backlog/shaping';
import type { TicketEntry } from '../../../src/features/backlog/ticket';
import {
  acceptItem,
  agentChatItem,
  agentLead,
} from '../../../src/features/backlog/backlog';

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
    expect(shapingTools('/work/repo/.flotilla/backlog/BL-45.md')).toEqual(['Read', 'Grep', 'Glob', 'Edit(//work/repo/.flotilla/backlog/BL-45.md)']);
  });

  it('tells a new discussion what it is for, that its reply is its final message, and how it writes the ticket', () => {
    const prompt = shapingPrompt({ item: { id: 'BL-45', title: 'Shape a ticket' }, agent: 'Nova-7', ticket: '/t/BL-45.md' });
    expect(prompt.startsWith('You are agent Nova-7, working on backlog item BL-45: "Shape a ticket".')).toBe(true);
    expect(prompt).toContain('You change no code');
    expect(prompt).toContain('Your reply is your final message');
    expect(prompt).toContain("Flotilla adds it to the end of the ticket's Activity");
    expect(prompt).toContain("Don't write in the Activity yourself");
    expect(prompt).toContain('"Ready to start."');
    expect(prompt).toContain('Edit the ticket with the Edit tool');
  });

  it('has the description show what has a shape, as a Mermaid diagram next to its text', () => {
    for (const prompt of [
      shapingPrompt({ item: { id: 'BL-45', title: 'Shape a ticket' }, agent: 'Nova-7', ticket: '/t/BL-45.md' }),
      followUpPrompt({ ticket: '/t/BL-45.md', opened: false }),
    ]) {
      expect(prompt).toContain('show it with a ```mermaid diagram next to the text it explains');
    }
  });

  it('tells a resumed discussion what changed, or that it was opened without a comment', () => {
    const comment = followUpPrompt({ ticket: '/t/BL-45.md', opened: false });
    expect(comment).toContain('wrote in the ticket since your last reply');
    expect(comment).toContain('answer them in your final message');
    const opened = followUpPrompt({ ticket: '/t/BL-45.md', opened: true });
    expect(opened).toContain('without a comment yet');
    expect(opened).toContain('Your reply is your final message');
  });

  it('ends the discussion of an accepted proposal, so the autopilot may take it', () => {
    const at = '2026-10-12T00:00:00Z';
    const data = {
      version: 1 as const,
      next: 2,
      items: [{ id: 'BL-1', title: 'T', status: 'todo' as const, created: at, proposed: { by: 'Ada-2' }, shaping: { agent: 'Nova-7', session: 's' } }],
    };
    const accepted = acceptItem(data, 'BL-1').items[0];
    expect(accepted.shaping).toBeUndefined();
    expect(accepted.proposed).toBeUndefined();
  });
});

describe('a discussion in a chat (BL-188)', () => {
  const item = { id: 'BL-7', title: 'Sort the list' };

  it("names the ticket in its first line, as agent chats do, and tells it from a working agent's", () => {
    const prompt = discussionPrompt({ item, agent: 'Iris-7', ticket: '/b/BL-7.md' });
    expect(prompt.startsWith(discussionLead(item, 'Iris-7'))).toBe(true);
    expect(agentChatItem(prompt)).toEqual({ agent: 'Iris-7', item: 'BL-7' });
    // Flotilla reads the first 200 characters of a chat's first message.
    expect(isDiscussionChat(prompt.slice(0, 200))).toBe(true);
    expect(isDiscussionChat(agentLead(item, 'Iris-7'))).toBe(false);
  });

  it('finds its chat by its session, or before that by its first line (the newest)', () => {
    const lead = discussionLead(item, 'Iris-7');
    const chats = [
      { id: 'old', firstPrompt: lead, open: false, updatedAt: new Date(1) },
      { id: 'new', firstPrompt: lead, open: true, updatedAt: new Date(2) },
      { id: 'work', firstPrompt: agentLead(item, 'Iris-7'), open: true, updatedAt: new Date(3) },
    ];
    expect(findDiscussionChat(chats, { id: 'BL-7', agent: 'iris-7' })?.id).toBe('new');
    expect(findDiscussionChat(chats, { id: 'BL-7', agent: 'Iris-7', session: 'old' })?.id).toBe('old');
    expect(findDiscussionChat(chats, { id: 'BL-8', agent: 'Iris-7' })).toBeUndefined();
  });

  it('tells whether the agent wrote its summary since the discussion opened', () => {
    const entries = [{ date: '2026-10-24 07:00', author: 'Agent Iris-7', body: 'Earlier.' }];
    expect(summarizedSince(entries, 'Iris-7', '2026-10-24 07:01')).toBe(false);
    expect(summarizedSince([...entries, { date: '2026-10-24 07:30', author: 'Agent Iris-7', body: 'Discussed with you.' }], 'Iris-7', '2026-10-24 07:01')).toBe(
      true,
    );
  });
});

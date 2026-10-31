import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  DESCRIPTION_CHECK,
  DESCRIPTION_SHAPE,
  KEEP_WHEN_DONE,
  SHAPE_RULE,
} from '../../../src/features/backlog/descriptionShape';
import { agentGuide } from '../../../src/features/backlog/inbox';
import {
  reviewerPrompt,
  userRevisionPrompt,
} from '../../../src/features/backlog/review';
import {
  discussionPrompt,
  shapingPrompt,
} from '../../../src/features/backlog/shaping';
import {
  cardSummaryOf,
  whenItsDone,
} from '../../../src/features/backlog/ticket';

describe('the description shape (BL-137)', () => {
  it("the agents' guide shows it as the new ticket's template, and keeps the When it's done lines current", () => {
    const guide = agentGuide('/b', 'propose');
    expect(guide).toContain(DESCRIPTION_SHAPE);
    expect(guide).not.toContain("What and why, and how to tell it's done");
    expect(guide).toContain(KEEP_WHEN_DONE);
  });

  it('the prompts that write or review descriptions ask for it', () => {
    const item = { id: 'BL-1', title: 'SSO' };
    expect(userRevisionPrompt({ item, ticket: '/t/BL-1.md', feedback: '' })).toContain(KEEP_WHEN_DONE);
    expect(shapingPrompt({ item, agent: 'Nova-7', ticket: '/t/BL-1.md' })).toContain(SHAPE_RULE);
    expect(discussionPrompt({ item, agent: 'Nova-7', ticket: '/t/BL-1.md' })).toMatch(/When it's done/);
    const review = reviewerPrompt({
      item,
      reviewer: 'Vega-2',
      ticket: '/t/BL-1.md',
      branch: 'feature/BL-1',
      base: 'main',
      round: 1,
    });
    expect(review).toContain(DESCRIPTION_CHECK);
    expect(DESCRIPTION_CHECK).toMatch(/doesn't hold up an approval/);
  });

  it("reads the When it's done lines, to the first blank line", () => {
    const description =
      "**When it's done:** Open Chat opens the chat.\nIt shows the latest reply.\n\n**Why:** it opens nothing.\n\nAcceptance criteria:\n- [ ] It opens";
    expect(whenItsDone(description)).toBe('Open Chat opens the chat.\nIt shows the latest reply.');
    expect(whenItsDone("Intro.\n\n**When it's done**: it works.")).toBe('it works.');
    expect(whenItsDone('**Why:** broken.\n- [ ] Fix it')).toBeUndefined();
    // The editor's empty skeleton has none yet.
    expect(whenItsDone("**When it's done:** \n\n**Why:** \n")).toBeUndefined();
  });

  it("the card's hover shows them on one line, or else the first line", () => {
    expect(cardSummaryOf("**When it's done:** Open Chat opens the chat.\nIt shows the reply.\n\n**Why:** x")).toBe(
      'Open Chat opens the chat. It shows the reply.',
    );
    expect(cardSummaryOf('The login breaks.\n\n- [ ] Fix it')).toBe('The login breaks.');
  });
});

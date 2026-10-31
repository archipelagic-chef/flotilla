import {
  describe,
  expect,
  it,
} from 'vitest';
import type { BacklogItem } from '../../../src/features/backlog/backlog';
import {
  DESIGN_CHECK,
  designOf,
  hasMockups,
  mockupsRule,
  pickedMockup,
  withDesign,
} from '../../../src/features/backlog/design';
import { agentGuide } from '../../../src/features/backlog/inbox';
import { needOf } from '../../../src/features/backlog/needs';
import {
  answerFromText,
  parseQuestion,
  parseReport,
  picksPicture,
} from '../../../src/features/backlog/report';
import { reviewerPrompt } from '../../../src/features/backlog/review';
import { discussionPrompt } from '../../../src/features/backlog/shaping';

const asks = [
  'Two ways to show Expand.',
  '',
  'Needs from you: pick a design',
  '',
  '```question',
  'Which should I build?',
  '- ![A: Expand in the card’s header](BL-7/mockup-a.svg) A (recommended)',
  '- ![B: Expand under the summary](BL-7/mockup-b.svg) B',
  '```',
].join('\n');

const description = [
  "**When it's done:** Expand opens the card.",
  '',
  '**Mockups** (pick one in the activity):',
  '',
  '![A: Expand in the card’s header](BL-7/mockup-a.svg) ![B: Expand under the summary](BL-7/mockup-b.svg)',
  '',
  'Acceptance criteria:',
  '- [ ] It expands.',
].join('\n');

describe('a choice with a picture', () => {
  it('takes the picture out of the choice’s text, which stays what the answer says', () => {
    const q = parseQuestion('Which?\n- ![A: in the header](BL-7/mockup-a.svg) A (recommended)\n- ![B: below](BL-7/mockup-b.svg)\n- Neither way')!;
    expect(q.options).toEqual([
      { text: 'A', recommended: true, image: 'BL-7/mockup-a.svg' },
      { text: 'B: below', recommended: false, image: 'BL-7/mockup-b.svg' },
      { text: 'Neither way', recommended: false },
    ]);
    expect(picksPicture(q)).toBe(true);
    expect(answerFromText(q, 'B: below')).toEqual({ picked: [1], other: '' });
  });

  it('leaves plain choices without a picture', () => {
    const q = parseQuestion('Which?\n- Redis\n- In memory')!;
    expect(q.options.every((o) => !('image' in o))).toBe(true);
    expect(picksPicture(q)).toBe(false);
  });

  it('is read from a report’s question block', () => {
    expect(parseReport(asks).questions[0].options.map((o) => o.image)).toEqual(['BL-7/mockup-a.svg', 'BL-7/mockup-b.svg']);
  });
});

describe('Mockups becoming Design', () => {
  it('replaces the Mockups section with the picked picture, and keeps the rest', () => {
    const design = withDesign(description, { text: 'B', image: 'BL-7/mockup-b.svg' })!;
    expect(design).toBe(
      [
        "**When it's done:** Expand opens the card.",
        '',
        '**Design** (you picked B; build and review against it):',
        '',
        '![B](BL-7/mockup-b.svg)',
        '',
        'Acceptance criteria:',
        '- [ ] It expands.',
      ].join('\n'),
    );
    expect(hasMockups(design)).toBe(false);
    expect(hasMockups(description)).toBe(true);
  });

  it('is what the folded description shows: the Mockups, then the Design', () => {
    expect(designOf(description)).toBe(description.split('\n').slice(2, 5).join('\n'));
    const design = withDesign(description, { text: 'A', image: 'BL-7/mockup-a.svg' }, 'but smaller')!;
    expect(designOf(design)).toBe('**Design** (you picked A; build and review against it):\n\n![A](BL-7/mockup-a.svg)\n\nYou said: but smaller');
    expect(designOf("**When it's done:** x")).toBeUndefined();
  });

  it('adds what you said with it', () => {
    expect(withDesign(description, { text: 'A', image: 'BL-7/mockup-a.svg' }, 'but smaller')).toContain('![A](BL-7/mockup-a.svg)\n\nYou said: but smaller');
  });

  it('changes nothing in a description without Mockups', () => {
    expect(withDesign("**When it's done:** x", { text: 'A', image: 'a.svg' })).toBeUndefined();
  });

  it('knows the picture your answer picks, and the others, past Flotilla’s notes', () => {
    const before = [
      { author: 'Agent Nova-7', body: asks },
      { author: 'Flotilla', body: 'The autopilot waits for your answer.' },
    ];
    expect(pickedMockup(before, 'B')).toEqual({
      choice: { text: 'B', recommended: false, image: 'BL-7/mockup-b.svg' },
      others: [{ text: 'A', recommended: true, image: 'BL-7/mockup-a.svg' }],
    });
  });

  it('picks nothing for "None of these", or a question already answered', () => {
    expect(pickedMockup([{ author: 'Agent Nova-7', body: asks }], 'Something with a dropdown instead')).toBeUndefined();
    expect(
      pickedMockup(
        [
          { author: 'Agent Nova-7', body: asks },
          { author: 'You', body: 'A' },
        ],
        'B',
      ),
    ).toBeUndefined();
  });
});

describe('the agents are told', () => {
  const item: Pick<BacklogItem, 'id' | 'title' | 'parent'> = { id: 'BL-7', title: 'Expand' };

  it('to draw mockups first for work that changes the UI, in the guide and in Discuss', () => {
    const guide = agentGuide('/b', 'propose');
    expect(guide).toContain(mockupsRule('<id>', '/b/<id>/'));
    expect(guide).toMatch(/draw 2–3 mockups/);
    expect(guide).toMatch(/Text-only, internal or test-only work skips this/);
    const discuss = discussionPrompt({ item, agent: 'Nova-7', ticket: '/b/BL-7.md' });
    expect(discuss).toMatch(/draw 2–3 small mockups \(SVG, in \/b\/BL-7\//);
    expect(discuss).toContain('**Design**');
  });

  it('the reviewer checks the work against the Design', () => {
    const review = reviewerPrompt({ item, reviewer: 'Vega-2', ticket: '/b/BL-7.md', branch: 'feature/BL-7', base: 'main', round: 1 });
    expect(review).toContain(DESIGN_CHECK);
    expect(DESIGN_CHECK).toMatch(/doesn't look like what the user picked is a change you request/);
  });
});

describe('Needs you', () => {
  it('lists a ticket waiting on its mockup choice as "Pick a design"', () => {
    const it_: BacklogItem = {
      id: 'BL-7',
      title: 'Expand',
      status: 'doing',
      created: '2026-10-01T10:00:00.000Z',
      review: { round: 1, state: 'asking', reviewer: 'Ada-1', implementer: 'Nova-7', since: '2026-10-12T10:00:00.000Z' },
    };
    expect(needOf(it_, [{ date: '2026-10-12 10:00', author: 'Agent Nova-7', body: asks }])).toEqual({
      kind: 'asking',
      since: '2026-10-12T10:00:00.000Z',
      line: 'Pick a design',
    });
  });
});

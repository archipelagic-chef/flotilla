import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  answerComment,
  answerFromText,
  answerOf,
  answersIn,
  choose,
  defaultAnswer,
  parseQuestion,
  parseReport,
  type Question,
  reportAnswer,
  takeMedia,
} from '../../../src/features/backlog/report';

describe('reading a report', () => {
  it('takes the summary before the Needs line, and folds the rest as details', () => {
    const parts = parseReport(
      ['Built the cache.', 'Tests pass.', '', 'Needs from you: nothing', '', '#### How to review', '- [src/a.ts:4](src/a.ts#L4)', '', 'Ready for review.'].join(
        '\n',
      ),
    );
    expect(parts).toMatchObject({ summary: 'Built the cache.\nTests pass.', needs: 'nothing', asks: false, questions: [], waiting: false });
    expect(parts.details.startsWith('#### How to review')).toBe(true);
    expect(parts.details.endsWith('Ready for review.')).toBe(true);
  });

  it('reads the questions of a report that needs the user, and takes them out of the details', () => {
    const parts = parseReport(
      [
        'Two things to decide.',
        '',
        'Needs from you: the cache.',
        '',
        '```question',
        'Which storage should the cache use?',
        '- Redis (recommended)',
        '- In memory',
        '```',
        '',
        '```question',
        'Keep old entries?',
        'choose: yes/no',
        '- Yes (recommended)',
        '- No',
        '```',
        '',
        '#### Details',
        'Nothing done yet.',
      ].join('\n'),
    );
    expect(parts.summary).toBe('Two things to decide.');
    expect(parts.needs).toBe('the cache.');
    expect(parts.asks).toBe(true);
    expect(parts.waiting).toBe(true);
    expect(parts.questions).toEqual([
      {
        text: 'Which storage should the cache use?',
        kind: 'one',
        options: [
          { text: 'Redis', recommended: true },
          { text: 'In memory', recommended: false },
        ],
      },
      {
        text: 'Keep old entries?',
        kind: 'yesno',
        options: [
          { text: 'Yes', recommended: true },
          { text: 'No', recommended: false },
        ],
      },
    ]);
    expect(parts.details).toBe('#### Details\nNothing done yet.');
  });

  it('asks with a text only, when the Needs line has no choices', () => {
    expect(parseReport('Stuck.\n\nNeeds from you: should old entries be kept?')).toMatchObject({
      summary: 'Stuck.',
      needs: 'should old entries be kept?',
      asks: true,
      questions: [],
      waiting: true,
    });
    expect(parseReport('Stuck.\n\n**Needs from you:** Nothing.')).toMatchObject({ needs: 'Nothing.', asks: false, waiting: false });
    expect(parseReport('Stuck.\n\nNeeds from you:')).toMatchObject({ asks: false, waiting: false });
  });

  it('reads the Needs line in bold, as agents write Markdown', () => {
    expect(parseReport('Done.\n\n**Needs from you**: nothing')).toMatchObject({ summary: 'Done.', needs: 'nothing', asks: false });
  });

  it('reads a verdict that starts a review: its first paragraph is the summary', () => {
    const parts = parseReport(
      ['Verdict: changes requested', '- The cache never expires entries.', '- No test for restarts.', '', '- [ ] expire entries', '- [ ] add the test'].join(
        '\n',
      ),
    );
    expect(parts.summary).toBe(
      'Verdict: changes requested\n- The cache never expires entries.\n- No test for restarts.\n\n- [ ] expire entries\n- [ ] add the test',
    );
    expect(parts.details).toBe('');
    expect(parts.asks).toBe(false);
  });

  it("shows a verdict's checklist with its summary, and folds the rest", () => {
    const body = [
      'Verdict: changes requested',
      'Close.',
      '',
      '### What must change',
      '- [ ] expire entries',
      '  after an hour',
      '- [x] add the test',
      '',
      'Ran `npm test`: 2 failed.',
    ].join('\n');
    const parts = parseReport(body);
    expect(parts.summary).toBe('Verdict: changes requested\nClose.\n\n- [ ] expire entries\n  after an hour\n- [x] add the test');
    expect(parts.details).toBe('### What must change\n\nRan `npm test`: 2 failed.');
  });

  it('shows an older report whole: no summary', () => {
    const body = 'Did X.\n\nReady for review.';
    expect(parseReport(body)).toEqual({ asks: false, questions: [], details: body, media: [], waiting: false });
    expect(parseReport('Should it be per key?\n\nWaiting for you.')).toMatchObject({ waiting: true });
    expect(parseReport('Should it be per key?\n\nWaiting for you.').summary).toBeUndefined();
    expect(parseReport('Waiting for you to decide, but I went ahead.\n\nReady for review.')).toMatchObject({ waiting: false });
  });

  it('leaves a question block that has no question as it is', () => {
    const body = 'Done.\n\nNeeds from you: nothing\n\n```question\n- Yes\n```';
    const parts = parseReport(body);
    expect(parts.questions).toEqual([]);
    expect(parts.details).toBe('```question\n- Yes\n```');
  });

  it('takes tilde fences too, and Windows line endings', () => {
    const parts = parseReport('Hi.\r\n\r\nNeeds from you: a choice\r\n\r\n~~~question\r\nPick one\r\n- A\r\n- B (recommended)\r\n~~~\r\n');
    expect(parts.questions).toEqual([
      {
        text: 'Pick one',
        kind: 'one',
        options: [
          { text: 'A', recommended: false },
          { text: 'B', recommended: true },
        ],
      },
    ]);
  });
});

describe('reading a question', () => {
  it('is one choice by default, several with "choose: several"', () => {
    expect(parseQuestion('Which?\n- A\n- B')?.kind).toBe('one');
    expect(parseQuestion('Which?\nchoose: several\n- A\n- B')?.kind).toBe('several');
  });

  it('is a free answer without choices, and yes or no only when asked for', () => {
    expect(parseQuestion('Why?')).toEqual({ text: 'Why?', kind: 'text', options: [] });
    expect(parseQuestion('Why?\n- A')?.kind).toBe('one');
    expect(parseQuestion('Ship it?\nchoose: yes/no')).toEqual({
      text: 'Ship it?',
      kind: 'yesno',
      options: [
        { text: 'Yes', recommended: false },
        { text: 'No', recommended: false },
      ],
    });
    expect(parseQuestion('Which?\nchoose: one')?.kind).toBe('text');
  });

  it('reads an answer back from the comment that gave it', () => {
    const one: Question = {
      text: 'Which?',
      kind: 'one',
      options: [
        { text: 'Redis', recommended: true },
        { text: 'In memory', recommended: false },
      ],
    };
    const several: Question = {
      text: 'Checks?',
      kind: 'several',
      options: [
        { text: 'Unit', recommended: false },
        { text: 'E2E', recommended: false },
      ],
    };
    const text: Question = { text: 'Why?', kind: 'text', options: [] };
    expect(answerFromText(one, 'Redis')).toEqual({ picked: [0], other: '' });
    expect(answerFromText(one, 'Postgres')).toEqual({ picked: [2], other: 'Postgres' });
    expect(answerFromText(several, 'Unit, E2E')).toEqual({ picked: [0, 1], other: '' });
    expect(answerFromText(text, 'Because.')).toEqual({ picked: [0], other: 'Because.' });
    expect(answersIn([one], 'Redis')).toEqual(['Redis']);
    expect(answersIn([one, several], '**Which?** Redis\n\n**Checks?** Unit')).toEqual(['Redis', 'Unit']);
    expect(answersIn([one, several], 'Something else')).toEqual(['', '']);
  });

  it('takes the first comment of the user after a report as its answer', () => {
    expect(
      reportAnswer([
        { author: 'Flotilla', body: 'Note.' },
        { author: 'You', body: ' Redis ' },
        { author: 'You', body: 'More.' },
      ]),
    ).toBe('Redis');
    expect(reportAnswer([{ author: 'Flotilla', body: 'Note.' }])).toBeUndefined();
  });

  it('needs a question', () => {
    expect(parseQuestion('- A\n- B')).toBeUndefined();
  });
});

describe('answering a question', () => {
  const one: Question = {
    text: 'Which storage?',
    kind: 'one',
    options: [
      { text: 'Redis', recommended: true },
      { text: 'In memory', recommended: false },
    ],
  };
  const several: Question = {
    text: 'Which checks?',
    kind: 'several',
    options: [
      { text: 'Unit', recommended: true },
      { text: 'E2E', recommended: true },
      { text: 'Load', recommended: false },
    ],
  };

  it('starts with the recommended choices preselected', () => {
    expect(defaultAnswer(one)).toEqual({ picked: [0], other: '' });
    expect(defaultAnswer(several)).toEqual({ picked: [0, 1], other: '' });
    expect(answerOf(one, defaultAnswer(one))).toBe('Redis');
    expect(answerOf(one, defaultAnswer({ ...one, options: [{ text: 'A', recommended: false }] }))).toBe('');
  });

  it('chooses one (replacing) or toggles several', () => {
    expect(choose(one, { picked: [0], other: '' }, 1).picked).toEqual([1]);
    expect(choose(several, { picked: [0, 1], other: '' }, 0).picked).toEqual([1]);
    expect(choose(several, { picked: [1], other: '' }, 2).picked).toEqual([1, 2]);
  });

  it('gives the answer as the chosen options, or what was written for Other', () => {
    expect(answerOf(several, { picked: [0, 2], other: '' })).toBe('Unit, Load');
    expect(answerOf(one, { picked: [2], other: 'Postgres' })).toBe('Postgres');
  });

  it('is incomplete while Other is chosen without text, or nothing is chosen', () => {
    expect(answerOf(one, { picked: [2], other: '  ' })).toBe('');
    expect(answerOf(one, { picked: [], other: '' })).toBe('');
    expect(answerOf({ text: 'Why?', kind: 'one', options: [] }, defaultAnswer({ text: 'Why?', kind: 'one', options: [] }))).toBe('');
  });

  it('posts one answer as it is, and several as each question with its answer', () => {
    expect(answerComment([{ question: one, answer: 'Redis' }])).toBe('Redis');
    expect(
      answerComment([
        { question: one, answer: 'Redis' },
        { question: several, answer: 'Unit' },
      ]),
    ).toBe('**Which storage?** Redis\n\n**Which checks?** Unit');
  });
});

describe("a report's media (BL-114)", () => {
  const report = [
    'Added the strip.',
    'Needs from you: nothing',
    '',
    '#### How to review',
    'The strip, folded:',
    '',
    '![The demo](BL-1/demo.gif)',
    '',
    '![Before](BL-1/before.png) ![After](BL-1/after.png)',
    '',
    'A flow:',
    '```mermaid',
    'flowchart LR',
    '  A --> B',
    '```',
    '',
    'Ready for review.',
  ].join('\n');

  it('takes the pictures (each apart) and diagrams out of the details, in order; their text stays there', () => {
    const parts = parseReport(report);
    expect(parts.summary).toBe('Added the strip.');
    expect(parts.media).toEqual([
      '![The demo](BL-1/demo.gif)',
      '![Before](BL-1/before.png)',
      '![After](BL-1/after.png)',
      '```mermaid\nflowchart LR\n  A --> B\n```',
    ]);
    expect(parts.details).toBe('#### How to review\nThe strip, folded:\n\nA flow:\n\nReady for review.');
  });

  it('leaves a picture in a sentence, a list or another code block, and other blocks, where they are', () => {
    const text = ['See ![x](a.png) here.', '- ![y](b.png)', '```markdown', '![z](c.png)', '```', '```run', 'npm test', '```'].join('\n');
    expect(takeMedia(text)).toEqual({ media: [], text });
  });

  it("takes a verdict's media too; a report with none has none, and an older report keeps them in its text", () => {
    expect(parseReport('Verdict: approved\nGood.\n\n![Run](BL-1/run.png)\n\nRan the tests.')).toMatchObject({
      media: ['![Run](BL-1/run.png)'],
      details: 'Ran the tests.',
    });
    expect(parseReport('Done.\nNeeds from you: nothing\n\nRan the tests.').media).toEqual([]);
    expect(parseReport('Did X.\n\n![Run](BL-1/run.png)')).toMatchObject({ media: [], details: 'Did X.\n\n![Run](BL-1/run.png)' });
  });
});

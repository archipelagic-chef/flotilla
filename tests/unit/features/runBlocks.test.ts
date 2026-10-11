import { describe, expect, it } from 'vitest';
import { activityRuns, runBlocks, ticketRun } from '../../../src/features/backlog/runBlocks';
import { reviewNotes } from '../../../src/features/backlog/review';
import type { TicketEntry } from '../../../src/features/backlog/ticket';

const entry = (author: string, body: string): TicketEntry => ({ date: '2026-10-11 10:00', author, body });

describe('run blocks', () => {
  it('reads shell blocks: the default kind, the title, the commands in order', () => {
    const [block] = runBlocks(['Ready for review.', '', '```run Build and open a test window', 'npm run build', '  code --new-window  ', '```'].join('\n'));
    expect(block).toEqual({ kind: 'shell', title: 'Build and open a test window', lines: ['npm run build', 'code --new-window'] });
  });

  it('reads the kinds, with the title after the kind', () => {
    expect(runBlocks('```run launch Run Extension\n```')).toEqual([{ kind: 'launch', title: 'Run Extension', lines: ['Run Extension'] }]);
    expect(runBlocks('```run task build\n```')).toEqual([{ kind: 'task', title: 'build', lines: ['build'] }]);
    expect(runBlocks('```run open\nhttp://localhost:5173\n```')).toEqual([{ kind: 'open', title: '', lines: ['http://localhost:5173'] }]);
    expect(runBlocks('```run open Docs\nREADME.md\n```')).toEqual([{ kind: 'open', title: 'Docs', lines: ['README.md'] }]);
  });

  it('reads a first word of launch, task or open as the kind, even in a shell title (the notes ask agents not to write one)', () => {
    expect(runBlocks('```run launch the dev server\nnpm start\n```')).toEqual([{ kind: 'launch', title: 'the dev server', lines: ['npm start'] }]);
    expect(runBlocks('```run Launch the dev server\nnpm start\n```')).toEqual([{ kind: 'shell', title: 'Launch the dev server', lines: ['npm start'] }]);
  });

  it('reads a block with no title and no body', () => {
    expect(runBlocks('```run\n```')).toEqual([{ kind: 'shell', title: '', lines: [] }]);
  });

  it('reads tilde fences, and only closes them with tildes', () => {
    expect(runBlocks('~~~run Test\nnpm test\n~~~')).toEqual([{ kind: 'shell', title: 'Test', lines: ['npm test'] }]);
    expect(runBlocks('~~~run Test\nnpm test\n```\nmore\n~~~')).toEqual([{ kind: 'shell', title: 'Test', lines: ['npm test', '```', 'more'] }]);
  });

  it('finds several blocks, in order', () => {
    const text = '```run one\na\n```\n\ntext\n\n```run two\nb\n```';
    expect(runBlocks(text).map((b) => b.title)).toEqual(['one', 'two']);
  });

  it('ignores other fences, and run blocks inside them (examples)', () => {
    const text = [
      '````markdown',
      '```run Example',
      'npm run build',
      '```',
      '````',
      '',
      '```ts',
      'const run = 1;',
      '```',
    ].join('\n');
    expect(runBlocks(text)).toEqual([]);
  });

  it('ignores an unclosed block, and everything after it', () => {
    expect(runBlocks('```run Build\nnpm run build')).toEqual([]);
    expect(runBlocks('```run One\na\n```\n```run Two\nb')).toEqual([{ kind: 'shell', title: 'One', lines: ['a'] }]);
  });

  it('ignores a closing fence with a different length or character, and fences that are not run blocks', () => {
    expect(runBlocks('````run Build\nnpm run build\n```\n````')).toEqual([{ kind: 'shell', title: 'Build', lines: ['npm run build', '```'] }]);
    expect(runBlocks('```runner\nx\n```')).toEqual([]);
    expect(runBlocks('`run inline` and ```run not a fence```')).toEqual([]);
  });

  it('reads the blocks of agents and Flotilla only, and the last one reported is the ticket\'s run', () => {
    const activity = [
      entry('Agent Nova-7', '```run First\nnpm test\n```'),
      entry('You', '```run Mine\nrm -rf x\n```'),
      entry('Jira', '```run Jira\nx\n```'),
      entry('Flotilla', '```run Flotilla\nx\n```'),
      entry('Agent Vega-2', 'Done.\n\n```run Second\nnpm run build\n```\n\n```run Last\nnpm start\n```'),
      entry('You', '```run Late comment\nx\n```'),
    ];
    expect(activityRuns(activity).map((b) => b.title)).toEqual(['First', 'Flotilla', 'Second', 'Last']);
    expect(ticketRun(activity)).toEqual({ kind: 'shell', title: 'Last', lines: ['npm start'] });
    expect(ticketRun([entry('You', '```run Mine\nx\n```')])).toBeUndefined();
  });

  it('asks agents for run blocks in the "How to review" notes', () => {
    expect(reviewNotes({ id: 'BL-19', backlogDir: '/r/.flotilla/backlog' })).toMatch(/run block/);
  });
});

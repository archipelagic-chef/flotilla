import { describe, expect, it } from 'vitest';
import { demoLength, gifSeconds, staleNote, ticketDemo, wantsDemo } from '../../../src/features/backlog/demo';

const report = (key: string, date: string, body: string) => ({ key, date, author: 'Agent Iris-3', body });
const flotilla = (key: string, date: string, body: string) => ({ key, date, author: 'Flotilla', body });
const demoBlock = (name: string) => ['```run demo ' + name, `npm run demo -- play ${name}`, '```'].join('\n');

describe('ticketDemo', () => {
  const entries = [
    report('e1', '2026-10-20 07:00', `Ready for review.\n\n\`\`\`run\nnpm test\n\`\`\`\n${demoBlock('first')}`),
    flotilla('e2', '2026-10-20 07:10', 'Review round 1: opened a chat for agent Flux-3 (opus).'),
    report('e3', '2026-10-20 08:00', 'Changes requested.'),
    report('e4', '2026-10-20 09:00', `Ready for review.\n\n${demoBlock('second')}`),
  ];
  const latest = { demo: true, date: '2026-10-20 09:00', entryKey: 'e4', src: 'BL-1/demo.mp4' };
  const older = { demo: true, date: '2026-10-20 07:00', entryKey: 'e1', src: 'BL-1/demo.gif' };
  const shot = { demo: false, date: '2026-10-20 09:30', entryKey: 'e4', src: 'BL-1/shot.png' };

  it('picks the latest demo, its round and its run block; the earlier ones under it', () => {
    const demo = ticketDemo([shot, latest, older], entries, []);
    expect(demo).toEqual({ latest, earlier: [older], round: 2, run: { key: 'e4', index: 0, name: 'second' }, since: 0 });
  });

  it('finds the run block among the entry’s others, and round 1 before any review', () => {
    expect(ticketDemo([older], entries, [])).toMatchObject({ round: 1, run: { key: 'e1', index: 1, name: 'first' } });
  });

  it('plays the activity’s latest demo block when its entry has none; a folder’s file has no round', () => {
    const file = { demo: true, date: '2026-10-20 10:00', src: 'BL-1/demo.gif' };
    const demo = ticketDemo([file], entries, []);
    expect(demo?.round).toBeUndefined();
    expect(demo?.run).toEqual({ key: 'e4', index: 0, name: 'second' });
  });

  it('counts the commits made after it, but not merges of the base or those in its minute', () => {
    const at = (h: number, m: number) => new Date(2026, 9, 20, h, m, 30).toISOString();
    const commits = [
      { date: at(9, 30), subject: 'BL-1: Fix the label' },
      { date: at(9, 20), subject: 'BL-1: Merge main' },
      { date: at(9, 10), subject: 'BL-1: Tidy up' },
      { date: at(9, 0), subject: 'BL-1: The demo' },
      { date: at(8, 0), subject: 'BL-1: Before' },
    ];
    expect(ticketDemo([latest], entries, commits)?.since).toBe(2);
  });

  it('is undefined without a demo', () => {
    expect(ticketDemo([shot], entries, [])).toBeUndefined();
  });
});

describe('wantsDemo', () => {
  it('when an agent speaks of a demo, a screenshot or the UI, outside code', () => {
    expect(wantsDemo([report('a', '', 'The UI changed: the button is blue.')])).toBe(true);
    expect(wantsDemo([report('a', '', 'Request: a screenshot of the panel.')])).toBe(true);
    expect(wantsDemo([report('a', '', 'Fixed the parser.\n```\ndemo\n```')])).toBe(false);
    expect(wantsDemo([{ author: 'Andreas', body: 'Where is the demo?' }])).toBe(false);
  });

  it("not when it says there's none to see", () => {
    for (const body of [
      'Verdict: approved\nNo UI change, no screenshot needed.',
      "Fixed the parser. It doesn't change the UI.",
      'Done without a demo: nothing to demo here.',
      'The UI is unchanged.',
      'A screenshot is not needed.',
    ])
      expect(wantsDemo([report('a', '', body)]), body).toBe(false);
  });

  it('when a negation is about something else', () => {
    expect(wantsDemo([report('a', '', 'No crash any more. The UI shows the error.')])).toBe(true);
    expect(wantsDemo([report('a', '', 'No UI change in the parser; a GIF of the new button is above.')])).toBe(true);
  });

  it('reads only the latest report and the latest verdict', () => {
    const plan = report('a', '', 'Plan: I may show the UI.');
    const done = report('a', '', 'Fixed the parser.\nReady for review.');
    const verdict = report('b', '', 'Verdict: approved\nNo UI change.');
    expect(wantsDemo([plan, done, verdict])).toBe(false);
    expect(wantsDemo([plan, verdict])).toBe(true);
    expect(wantsDemo([done, report('b', '', 'Verdict: changes requested\nAdd a screenshot.'), done])).toBe(true);
  });
});

describe('the labels', () => {
  it('reads as the section says them', () => {
    expect(staleNote(1)).toBe('Recorded before the last commit');
    expect(staleNote(2)).toBe('Recorded before the last 2 commits');
    expect(demoLength(12.4)).toBe('0:12');
    expect(demoLength(65)).toBe('1:05');
  });
});

describe('gifSeconds', () => {
  it("isn't a GIF's length for other bytes", () => {
    expect(gifSeconds(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});

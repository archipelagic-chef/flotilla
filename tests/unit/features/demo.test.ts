import { describe, expect, it } from 'vitest';
import { demoLength, demoRunFor, gifSeconds, staleNote, ticketDemo, wantsDemo, withDemoUnits } from '../../../src/features/backlog/demo';
import { parseRunBlocks, withRunButtons } from '../../../src/features/backlog/runBlocks';

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

describe('demoRunFor (BL-111)', () => {
  const entries = [
    report('a', '2026-10-20 07:00', '```run demo open-ticket\nnpm run demo -- play open-ticket\n```'),
    report('b', '2026-10-20 08:00', '```run demo try-demo\nnpm run demo -- play try-demo\n```'),
  ];

  it('pairs a recording with the block of the demo it was recorded from, wherever the report put them', () => {
    expect(demoRunFor({ demo: true, entryKey: 'b', recorded: 'open-ticket' }, entries)).toEqual({ key: 'a', index: 0, name: 'open-ticket' });
  });

  it("else with its entry's block, else the latest", () => {
    expect(demoRunFor({ demo: true, entryKey: 'a' }, entries)?.name).toBe('open-ticket');
    expect(demoRunFor({ demo: true, recorded: 'gone' }, entries)?.name).toBe('try-demo');
  });
});

describe('withDemoUnits (BL-111)', () => {
  const html = (body: string, md: string) => withRunButtons(body, parseRunBlocks(md), 'k');
  const block = '<pre><code class="language-run demo try-demo">npm run demo -- play try-demo\n</code></pre>';
  const md = '```run demo try-demo\nnpm run demo -- play try-demo\n```';
  const gif = '<p><img src="vs://BL-1/demo.gif" alt="Trying"></p>';

  it("puts the demo's buttons on its recording, as one unit, and doesn't show the block again", () => {
    const out = withDemoUnits(html(`<p>Done.</p>${gif}${block}`, md), (src) => (src.endsWith('demo.gif') ? { name: 'try-demo', seconds: 12 } : undefined));
    expect(out).toContain('<figure class="demo-unit demo-inline" data-demo="try-demo">');
    expect(out).toContain('Recorded demo · 0:12');
    expect(out).toContain('Try it yourself');
    expect(out).toContain('data-run-try="1"');
    expect(out).toContain('Watch it live');
    expect(out).toContain('<img src="vs://BL-1/demo.gif" alt="Trying">');
    expect(out).not.toContain('run-block');
    expect(out).not.toContain('<p><img');
  });

  it("pairs a recording that doesn't name its demo with the entry's only block", () => {
    expect(withDemoUnits(html(`${block}${gif}`, md), () => ({}))).toContain('demo-inline');
    // As VS Code's renderer gives it: its paragraphs have their lines.
    const vscode = `<p data-line="30" class="code-line" dir="auto"><img src="vs://BL-1/demo.gif" alt="Trying" data-line="30"></p>`;
    expect(withDemoUnits(html(`${vscode}${block}`, md), () => ({}))).not.toContain('<p data-line');
  });

  it("leaves the block, with its buttons, when its recording isn't there or is another demo's", () => {
    const out = withDemoUnits(html(`${gif}${block}`, md), () => ({ name: 'other' }));
    expect(out).not.toContain('demo-inline');
    expect(out).toContain('class="run-block demo-run"');
    expect(out).toContain('Try it yourself');
    expect(withDemoUnits(html(`${gif}${block}`, md), () => undefined)).not.toContain('demo-inline');
  });

  it('plays a video as a GIF plays: muted, looping', () => {
    const video = '<p><video class="media" src="vs://BL-1/demo.mp4" controls preload="metadata"></video></p>';
    expect(withDemoUnits(html(`${video}${block}`, md), () => ({ name: 'try-demo' }))).toContain('<video autoplay muted loop playsinline class="media"');
  });
});

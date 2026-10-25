import { describe, expect, it } from 'vitest';
import {
  attachmentKey,
  diagramRefs,
  gatherAttachments,
  mediaRefs,
} from '../../../src/features/backlog/attachments';

describe('mediaRefs', () => {
  it('finds Markdown images and html images and videos, in order, but not in code', () => {
    const md = [
      '![The panel](BL-1/panel.png "a title")',
      '<video src="BL-1/clip.webm"></video>',
      '`![not](BL-1/inline.png)`',
      '```md',
      '![not](BL-1/fenced.png)',
      '```',
      '<img alt="Diagram" src=\'BL-1/flow.svg\'>',
      '![](data:image/png;base64,AAAA)',
      '![](<BL-1/with space.gif>)',
    ].join('\n');
    expect(mediaRefs(md)).toEqual([
      { src: 'BL-1/panel.png', alt: 'The panel', kind: 'image' },
      { src: 'BL-1/clip.webm', kind: 'video' },
      { src: 'BL-1/flow.svg', alt: 'Diagram', kind: 'image' },
      { src: 'BL-1/with space.gif', kind: 'image' },
    ]);
  });
});

describe('attachmentKey', () => {
  it('makes one key of the ways a local path is written', () => {
    expect(attachmentKey('./BL-1/a%20b.png')).toBe('BL-1/a b.png');
    expect(attachmentKey('BL-1\\x\\..\\a b.png?raw')).toBe('BL-1/a b.png');
    expect(attachmentKey('https://x/a.png?raw=1')).toBe('https://x/a.png?raw=1');
  });
});

describe('diagramRefs', () => {
  it('finds the Mermaid blocks, with the line before each as its caption, and reads no other code', () => {
    const text = [
      '#### The flow:',
      '```mermaid',
      'flowchart LR',
      '  A --> B',
      '```',
      '',
      '```ts',
      "const x = '![not this](BL-1/code.png)';",
      '```',
      '',
      '~~~~ Mermaid',
      'sequenceDiagram',
      '~~~~',
      '',
      '```mermaid',
      '```',
    ].join('\n');
    expect(diagramRefs(text)).toEqual([
      { code: 'flowchart LR\n  A --> B', alt: 'The flow' },
      // After a blank line, no caption; an empty block isn't a diagram.
      { code: 'sequenceDiagram' },
    ]);
    expect(mediaRefs(text)).toEqual([]);
  });
});

describe('gatherAttachments', () => {
  const entries = [
    { date: '2026-10-01 10:00', author: 'Agent Nova-7', body: 'Before: ![before](BL-1/before.png)\n\n![The panel](BL-1/panel.png)' },
    { date: '2026-10-02 09:00', author: 'You', body: 'Again: ![again](./BL-1/panel.png)' },
    {
      date: '2026-10-03 12:00',
      author: 'Agent Nova-7',
      body: '![It working](BL-1/walk.gif)\n\n```run demo panel\nnpm run demo -- play panel\n```\n\n![After](BL-1/after.png)',
    },
  ];

  it('lists each referenced file once, as its first reference added it, newest first', () => {
    const found = gatherAttachments('The idea: ![sketch](BL-1/sketch.svg)', entries);
    expect(found.map((a) => [a.name, a.author, a.date, a.entry, a.from])).toEqual([
      ['walk.gif', 'Agent Nova-7', '2026-10-03 12:00', 2, 'activity'],
      ['after.png', 'Agent Nova-7', '2026-10-03 12:00', 2, 'activity'],
      ['before.png', 'Agent Nova-7', '2026-10-01 10:00', 0, 'activity'],
      ['panel.png', 'Agent Nova-7', '2026-10-01 10:00', 0, 'activity'],
      ['sketch.svg', undefined, undefined, undefined, 'description'],
    ]);
    expect(found.find((a) => a.name === 'panel.png')?.alt).toBe('The panel');
  });

  it('adds the folder files nothing references, by their time', () => {
    const found = gatherAttachments('', entries, [
      { path: 'BL-1/panel.png', date: '2026-10-05 08:00' },
      { path: 'BL-1/pasted.png', date: '2026-10-02 10:00' },
      { path: 'BL-1/notes.txt', date: '2026-10-06 10:00' },
    ]);
    expect(found.map((a) => a.name)).toEqual(['walk.gif', 'after.png', 'pasted.png', 'before.png', 'panel.png']);
    expect(found.find((a) => a.name === 'pasted.png')).toMatchObject({ from: 'folder', kind: 'image' });
  });

  it('marks demos: demo.gif and demo.mp4, and the GIFs and videos of an entry that plays a demo', () => {
    const found = gatherAttachments('', entries, [{ path: 'BL-1/demo.mp4', date: '2026-10-04 08:00' }]);
    expect(found.filter((a) => a.demo).map((a) => a.name)).toEqual(['demo.mp4', 'walk.gif']);
    expect(found.find((a) => a.name === 'demo.mp4')?.kind).toBe('video');
  });

  it('lists the Mermaid diagrams of a report as diagrams, at their place in the entry; not an image in a code block', () => {
    const report = 'Plan:\n```mermaid\nflowchart LR\n  A --> B\n```\n\n```md\n![example](BL-1/example.png)\n```\n\nThen:\n```mermaid\npie\n```';
    const found = gatherAttachments('```mermaid\ngraph TD\n```', [{ date: '2026-10-04 08:00', author: 'Agent Nova-7', body: report }]);
    expect(found.map((a) => [a.kind, a.src, a.alt, a.diagram, a.entry, a.from, a.code])).toEqual([
      ['diagram', 'diagram:0:0', 'Plan', 0, 0, 'activity', 'flowchart LR\n  A --> B'],
      ['diagram', 'diagram:0:1', 'Then', 1, 0, 'activity', 'pie'],
      ['diagram', 'diagram:description:0', undefined, 0, undefined, 'description', 'graph TD'],
    ]);
    expect(found[0]).toMatchObject({ author: 'Agent Nova-7', date: '2026-10-04 08:00', demo: false });
  });

  it('has none for a ticket that shows nothing', () => {
    expect(gatherAttachments('Just text.', [{ date: '2026-10-01 10:00', author: 'You', body: 'A comment.' }])).toEqual([]);
  });
});

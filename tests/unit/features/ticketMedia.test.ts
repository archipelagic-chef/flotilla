import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { makeTempDir, removeDir } from '../../helpers/gitRepo';
import {
  fileKind,
  MEDIA_LIMITS,
  mediaType,
  tooLarge,
  tooLargeNote,
} from '../../../src/features/backlog/media';

// The renderer gives back the text as it is: the tests write the html it would make.
vi.mock('vscode', () => ({
  Uri: { file: (fsPath: string) => ({ fsPath }), parse: (s: string) => ({ fsPath: s.replace(/^file:\/\//, '') }) },
  commands: { executeCommand: async (_command: string, text: string) => text },
  window: {},
  workspace: {},
  EventEmitter: class {},
}));
const { mediaThumbs, renderMarkdown, replaceMedia, stripStyles } = await import('../../../src/ui/backlog/ticketPanel');

const webview = { asWebviewUri: (u: { fsPath: string }) => ({ toString: () => `webview:${u.fsPath.replace(/\\/g, '/')}` }) } as never;

describe('media kinds and limits', () => {
  it('knows images, GIFs and videos by their extension, a URL query aside', () => {
    expect(mediaType('BL-1/demo.GIF')).toEqual({ kind: 'image', type: 'image/gif' });
    expect(mediaType('BL-1/demo.webm')).toEqual({ kind: 'video', type: 'video/webm' });
    expect(mediaType('https://x/clip.mp4?raw=1')).toEqual({ kind: 'video', type: 'video/mp4' });
    expect(mediaType('notes.txt')).toBeUndefined();
    expect(mediaType('README')).toBeUndefined();
  });

  it('takes pasted files by their type, or by their name when the type is missing', () => {
    expect(fileKind({ type: 'image/png', name: '' })).toBe('image');
    expect(fileKind({ type: 'video/webm', name: 'a.webm' })).toBe('video');
    expect(fileKind({ type: 'video/quicktime', name: 'a.mov' })).toBeUndefined();
    expect(fileKind({ type: '', name: 'a.mp4' })).toBe('video');
  });

  it('allows images up to 2 MB and videos up to 10 MB, and says why a larger one is refused', () => {
    expect(tooLarge('image', MEDIA_LIMITS.image)).toBe(false);
    expect(tooLarge('image', MEDIA_LIMITS.image + 1)).toBe(true);
    expect(tooLarge('video', 9 * 1024 * 1024)).toBe(false);
    expect(tooLarge('video', 11 * 1024 * 1024)).toBe(true);
    expect(tooLargeNote('demo.gif', 'image', 3.4 * 1024 * 1024)).toBe('demo.gif is 3.4 MB: images and GIFs can be at most 2 MB. Make it smaller to show it.');
    expect(tooLargeNote('demo.mp4', 'video', 12 * 1024 * 1024)).toMatch(/^demo\.mp4 is 12 MB: videos can be at most 10 MB\./);
  });
});

describe('media in a ticket', () => {
  const root = makeTempDir();
  const backlog = path.join(root, 'backlog');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(backlog, 'BL-1'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  const write = (file: string, bytes: number) => fs.writeFileSync(file, Buffer.alloc(bytes));
  write(path.join(backlog, 'BL-1', 'shot.png'), 10);
  write(path.join(backlog, 'BL-1', 'demo.gif'), 10);
  write(path.join(backlog, 'BL-1', 'big.gif'), MEDIA_LIMITS.image + 1);
  write(path.join(backlog, 'BL-1', 'demo.webm'), 10);
  write(path.join(backlog, 'BL-1', 'huge.mp4'), MEDIA_LIMITS.video + 1);
  write(path.join(repo, 'docs', 'flow.png'), 10);
  write(path.join(repo, 'docs', 'big.png'), MEDIA_LIMITS.image + 1);
  write(path.join(repo, 'docs', 'clip.mp4'), 10);
  afterAll(() => removeDir(root));

  const render = (html: string) => renderMarkdown(html, webview, backlog, [repo]);

  it('shows images and GIFs next to the ticket through the webview', async () => {
    const html = await render('<p><img src="BL-1/shot.png" alt="Shot"> <img src="BL-1/demo.gif" alt="Demo"></p>');
    expect(html).toContain('<img src="webview:');
    expect(html).toMatch(/src="webview:[^"]*BL-1\/shot\.png" alt="Shot"/);
    expect(html).toMatch(/src="webview:[^"]*BL-1\/demo\.gif" alt="Demo"/);
  });

  it("plays videos next to the ticket in a player with controls, which doesn't start by itself", async () => {
    const html = await render('<p><img src="BL-1/demo.webm" alt="The demo"></p>');
    expect(html).toMatch(
      /<video class="media" src="webview:[^"]*BL-1\/demo\.webm" controls muted playsinline preload="metadata" title="The demo" aria-label="The demo"><\/video>/,
    );
    expect(html).not.toMatch(/autoplay/);
  });

  it('refuses files over their limit with a note, next to the ticket and in the repository', async () => {
    const html = await render('<p><img src="BL-1/big.gif" alt="Big"> <img src="BL-1/huge.mp4" alt="Huge"> <img src="docs/big.png" alt="Big too"></p>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<video');
    expect(html).toContain('big.gif is 2.1 MB: images and GIFs can be at most 2 MB.');
    expect(html).toContain('huge.mp4 is 10.1 MB: videos can be at most 10 MB.');
    expect(html).toContain('big.png is 2.1 MB: images and GIFs can be at most 2 MB.');
    expect(html.match(/class="media-note"/g)).toHaveLength(3);
  });

  it("embeds images from the repository, and says videos play only from the ticket's folder", async () => {
    const html = await render('<p><img src="docs/flow.png" alt="Flow"> <img src="docs/clip.mp4" alt="Clip"></p>');
    expect(html).toContain('<img src="data:image/png;base64,');
    expect(html).toContain("clip.mp4 isn't next to the ticket: videos play from the ticket's folder");
    expect(html).not.toContain('<video');
  });

  it('plays remote videos, and leaves remote images and missing files as they are', async () => {
    const html = await render('<p><img src="https://x/clip.mp4" alt="Clip"> <img src="https://x/a.png" alt="A"> <img src="BL-1/gone.png" alt="Gone"></p>');
    expect(html).toContain('<video class="media" src="https://x/clip.mp4" controls');
    expect(html).toContain('<img src="https://x/a.png" alt="A">');
    expect(html).toContain('<img src="BL-1/gone.png" alt="Gone">');
  });

  it('escapes what it writes into the html', async () => {
    const html = await replaceMedia('<img src="a" alt="x">', async () => ({ note: 'a <b>"note"</b>' }));
    expect(html).toContain('a &lt;b&gt;&quot;note&quot;&lt;/b&gt;');
    const video = await replaceMedia('<img src="a.mp4">', async () => ({ src: 'https://x/a.mp4?a=1&b="2"', kind: 'video' }));
    expect(video).toBe('<video class="media" src="https://x/a.mp4?a=1&amp;b=&quot;2&quot;" controls muted playsinline preload="metadata"></video>');
  });
});

describe('styles in rendered html', () => {
  it('are stripped from what a ticket renders: inline styles are for diagrams the webview draws only', async () => {
    const html = await renderMarkdown(
      '<p style="position:fixed;inset:0">Over all</p><style>.rendered { display: none }</style><a href="https://x" STYLE=\'opacity:0\' title="a>b">x</a>',
      webview,
      '/nonexistent',
    );
    expect(html).toBe('<p>Over all</p><a href="https://x" title="a>b">x</a>');
  });

  it('keep other attributes, and text that only mentions a style', () => {
    expect(stripStyles('<p class="a" data-style="b" style=color:red>style="x" stays</p>')).toBe('<p class="a" data-style="b">style="x" stays</p>');
    expect(stripStyles('<svg><style>*{}</style><g style="fill:red" id="g"/></svg>')).toBe('<svg><g id="g"/></svg>');
    expect(stripStyles('<STYLE type="text/css">x</STYLE>after <style>unclosed')).toBe('after unclosed');
  });
});

describe("a folded report's thumbnails (BL-114)", () => {
  it('gives each picture its resolved source and kind, a diagram its code, and none to one over its limit', async () => {
    const resolve = async (src: string) =>
      src === 'BL-1/big.gif' ? { note: 'big.gif is 3 MB' } : src === 'https://x/a.png' ? undefined : { src: `webview:${src}`, kind: mediaType(src)!.kind };
    const thumbs = await mediaThumbs(
      [
        '![The demo](BL-1/demo.mp4)',
        '![](BL-1/big.gif)',
        '![Shot](<BL-1/a shot.png> "title")',
        '![](https://x/a.png)',
        '```mermaid\nflowchart LR\n  A --> B\n```',
      ],
      resolve,
    );
    expect(thumbs).toEqual([
      { kind: 'video', src: 'webview:BL-1/demo.mp4', alt: 'The demo' },
      { kind: 'image', src: 'webview:BL-1/a shot.png', alt: 'Shot' },
      { kind: 'image', src: 'https://x/a.png' },
      { kind: 'diagram', code: 'flowchart LR\n  A --> B' },
    ]);
  });
});

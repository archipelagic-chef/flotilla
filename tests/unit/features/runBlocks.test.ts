import { describe, expect, it } from 'vitest';
import { demoCommand, demoPath, isReport, latestRun, parseRunBlocks, pickRunBlock, placedRunBlocks, runLabel, withRunButtons } from '../../../src/features/backlog/runBlocks';

describe('run blocks', () => {
  it('reads each kind, with its title or name', () => {
    const blocks = parseRunBlocks(
      [
        '```run Build and open a test window',
        'npm run build',
        'code --new-window',
        '```',
        '',
        '```run launch Run Extension',
        '```',
        '',
        '```run task build',
        '```',
        '',
        '```run open Dev server',
        'http://localhost:5173',
        '```',
        '',
        '```run shell',
        'npm test',
        '```',
      ].join('\n'),
    );
    expect(blocks).toEqual([
      { kind: 'shell', title: 'Build and open a test window', lines: ['npm run build', 'code --new-window'] },
      { kind: 'launch', title: 'Run Extension', lines: [] },
      { kind: 'task', title: 'build', lines: [] },
      { kind: 'open', title: 'Dev server', lines: ['http://localhost:5173'] },
      { kind: 'shell', title: undefined, lines: ['npm test'] },
    ]);
  });

  it('takes a bare run block as shell commands, and a kind without a title as no title', () => {
    expect(parseRunBlocks('```run\nnpm test\n```')).toEqual([{ kind: 'shell', title: undefined, lines: ['npm test'] }]);
    expect(parseRunBlocks('```run open http://localhost:3000\n```')).toEqual([{ kind: 'open', title: 'http://localhost:3000', lines: [] }]);
  });

  it('ignores other fences and text that only mentions run', () => {
    const text = ['```ts', '```run not a block', '```', '', '```runner', 'x', '```', '', 'run it with `npm test`'].join('\n');
    expect(parseRunBlocks(text)).toEqual([]);
  });

  it('counts every block, in order', () => {
    const text = '```run first\na\n```\n\ntext\n\n```run second\nb\n```';
    expect(parseRunBlocks(text).map((b) => b.title)).toEqual(['first', 'second']);
  });

  it('takes ~~~ fences, and a ``` line inside one is only text', () => {
    const text = '~~~run tilde\n```\nnpm test\n~~~';
    expect(parseRunBlocks(text)).toEqual([{ kind: 'shell', title: 'tilde', lines: ['```', 'npm test'] }]);
  });

  it('closes a fence only with the same character and at least as many', () => {
    const text = '````run four\n```\nnpm test\n```\n````';
    expect(parseRunBlocks(text)).toEqual([{ kind: 'shell', title: 'four', lines: ['```', 'npm test', '```'] }]);
  });

  it('counts an unclosed block up to the end, as Markdown renders it', () => {
    expect(parseRunBlocks('```run open\nhttp://localhost:5173\n\nmore text')).toEqual([
      { kind: 'open', title: undefined, lines: ['http://localhost:5173', 'more text'] },
    ]);
  });

  it('only takes reports from agents and Flotilla', () => {
    expect(isReport('Agent Nova-7')).toBe(true);
    expect(isReport('agent')).toBe(true);
    expect(isReport('Flotilla')).toBe(true);
    expect(isReport('You')).toBe(false);
    expect(isReport('')).toBe(false);
  });

  it('finds the latest run: the last block of the last report that has one', () => {
    const entries = [
      { date: '2026-10-11 09:00', author: 'Agent Nova-7', body: '```run old\nnpm test\n```' },
      { date: '2026-10-11 10:00', author: 'Agent Nova-7', body: '```run new\nnpm run build\n```\n```run newest\nnpm start\n```' },
      { date: '2026-10-11 11:00', author: 'You', body: '```run mine\nrm -rf x\n```' },
      { date: '2026-10-11 12:00', author: 'Agent Nova-7', body: 'No run block here.' },
    ];
    expect(latestRun(entries, (e) => e.date)).toEqual({ key: '2026-10-11 10:00', index: 1, kind: 'shell', title: 'newest' });
    expect(latestRun(entries.slice(2), (e) => e.date)).toBeUndefined();
  });

  it('puts a Run button on each block of rendered code, and leaves the html alone when they don\'t match', () => {
    const html = '<p>Try:</p><pre><code class="language-run">npm test\n</code></pre><pre><code class="language-ts">x</code></pre>';
    const blocks = parseRunBlocks('```run Tests\nnpm test\n```\n```ts\nx\n```');
    expect(blocks).toHaveLength(1);
    const out = withRunButtons(html, blocks, 'abc123');
    expect(out).toContain('<div class="run-block"><div class="run-head"><span class="run-label">commands · Tests</span>');
    expect(out).toContain('data-run-key="abc123" data-run-index="0"');
    expect(out).toContain('<pre><code>npm test\n</code></pre></div>');
    expect(out).toContain('<pre><code class="language-ts">x</code></pre>');

    const mismatch = '<pre><code class="language-run">npm test\n</code></pre>';
    expect(withRunButtons(mismatch, parseRunBlocks('```run a\nx\n```\n```run b\ny\n```'), 'k')).toBe(mismatch);
  });

  it('shows a launch block with no commands as its kind and name only', () => {
    const html = '<pre><code class="language-run"></code></pre>';
    const out = withRunButtons(html, parseRunBlocks('```run launch Run Extension\n```'), 'k');
    expect(out).toContain('launch · Run Extension');
    expect(out).not.toContain('<pre>');
  });

  it('matches the renderer\'s attributes on the pre and the code (VS Code adds data-line, class and dir)', () => {
    const html = '<pre class="hljs code-line" dir="auto" data-line="3"><code class="hljs language-run">npm test\n</code></pre>';
    const out = withRunButtons(html, parseRunBlocks('```run T\nnpm test\n```'), 'k');
    expect(out).toContain('data-run-index="0"');
    expect(out).toContain('<pre><code>npm test\n</code></pre>');
  });

  it('looks a block up by its entry and index: a stale reference finds nothing', () => {
    const entries = [
      { date: '2026-10-11 09:00', author: 'Agent Nova-7', body: '```run one\nnpm test\n```\n```run two\nnpm run build\n```' },
      { date: '2026-10-11 10:00', author: 'You', body: '```run mine\nrm -rf x\n```' },
    ];
    const blocks = placedRunBlocks(entries, (e) => e.date);
    expect(blocks.map((b) => [b.key, b.index])).toEqual([
      ['2026-10-11 09:00', 0],
      ['2026-10-11 09:00', 1],
    ]);
    expect(pickRunBlock(blocks, { key: '2026-10-11 09:00', index: 0 })?.block.title).toBe('one');
    expect(pickRunBlock(blocks)?.block.title).toBe('two');
    expect(pickRunBlock(blocks, { key: '2026-10-11 09:00', index: 2 })).toBeUndefined();
    expect(pickRunBlock(blocks, { key: '2026-10-11 08:00', index: 0 })).toBeUndefined();
    expect(pickRunBlock(blocks, { key: '2026-10-11 10:00', index: 0 })).toBeUndefined();
    expect(pickRunBlock([], undefined)).toBeUndefined();
  });
});

describe('the label of a run', () => {
  it('says what each kind runs', () => {
    expect(runLabel({ kind: 'shell', title: 'Build and open a test window', lines: ['npm run build'] })).toBe('Run Build and open a test window');
    expect(runLabel({ kind: 'shell', lines: ['npm run build', 'code --new-window'] })).toBe('Run npm run build');
    expect(runLabel({ kind: 'launch', title: 'Run Extension', lines: [] })).toBe('Launch Run Extension');
    expect(runLabel({ kind: 'task', title: 'build', lines: [] })).toBe('Run task build');
    expect(runLabel({ kind: 'open', lines: ['http://localhost:5173'] })).toBe('Open http://localhost:5173');
    expect(runLabel({ kind: 'demo', title: 'open-ticket', lines: [] })).toBe('Play the demo open-ticket');
  });

  it('says something when the block has no title or lines', () => {
    expect(runLabel({ kind: 'shell', lines: [] })).toBe('Run its commands');
    expect(runLabel({ kind: 'launch', lines: [] })).toBe('Launch its debug configuration');
    expect(runLabel({ kind: 'open', lines: [] })).toBe('Open its link');
  });
});

describe('demo blocks', () => {
  it("reads demo as a kind, with the demo's name", () => {
    expect(parseRunBlocks('```run demo open-ticket\n```')).toEqual([{ kind: 'demo', title: 'open-ticket', lines: [] }]);
  });

  it("plays the worktree's demos/<name>.json with its player, and a name is never a path", () => {
    expect(demoPath('open-ticket')).toBe('demos/open-ticket.json');
    expect(demoPath('../../etc/passwd')).toBeUndefined();
    expect(demoPath('a b')).toBeUndefined();
    expect(demoPath(undefined)).toBeUndefined();
    expect(demoCommand('open-ticket')).toBe('npm run demo -- play open-ticket');
  });
});

import { describe, expect, it } from 'vitest';
import { highlightHunks, highlightLines, languageOf } from '../../../src/features/diffs/highlight';
import type { DiffHunk, DiffToken } from '../../../src/webview/ticketProtocol';

const kinds = (tokens: DiffToken[] | undefined) => tokens?.filter((t) => t.kind).map((t) => `${t.kind}:${t.text}`);

describe('languageOf', () => {
  it('picks the language from the extension, and none for others', () => {
    expect(languageOf('src/a.tsx')).toBe('typescript');
    expect(languageOf('a.JSON')).toBe('json');
    expect(languageOf('docs/page.html')).toBe('xml');
    expect(languageOf('scripts/run.sh')).toBe('bash');
    expect(languageOf('.github/ci.yml')).toBe('yaml');
    expect(languageOf('Makefile')).toBeUndefined();
    expect(languageOf('.gitignore')).toBeUndefined();
    expect(languageOf('my.dir/README')).toBeUndefined();
    expect(languageOf('main.rs')).toBeUndefined();
  });
});

describe('highlightLines', () => {
  it('splits the highlighted text back into lines, keeping each line’s text', () => {
    const text = 'const s = "a<&>b";\n\nlet n = 1;';
    const lines = highlightLines(text, 'typescript');
    expect(lines.map((l) => l.map((t) => t.text).join(''))).toEqual(text.split('\n'));
    expect(kinds(lines[0])).toEqual(['keyword:const', 'string:"a<&>b"']);
    expect(lines[1]).toEqual([]);
    expect(kinds(lines[2])).toEqual(['keyword:let', 'number:1']);
  });

  it('colours each line of a multi-line comment as the comment', () => {
    const lines = highlightLines('/* one\n   two\n   three */ x', 'javascript');
    expect(kinds(lines[0])).toEqual(['comment:/* one']);
    expect(kinds(lines[1])).toEqual(['comment:   two']);
    expect(kinds(lines[2])).toEqual(['comment:   three */']);
  });
});

describe('highlightHunks', () => {
  const hunk: DiffHunk = {
    oldStart: 1,
    newStart: 1,
    lines: [
      { kind: 'context', text: 'x = 1', old: 1, new: 1 },
      { kind: 'deleted', text: '"""old', old: 2 },
      { kind: 'deleted', text: 'doc"""', old: 3 },
      { kind: 'added', text: '# a comment', new: 2 },
      { kind: 'added', text: 'still code', new: 3 },
    ],
  };

  it('highlights deleted lines with the old side and the others with the new side', () => {
    const [h] = highlightHunks('a.py', [hunk]);
    expect(h.lines.map((l) => l.tokens?.map((t) => t.text).join(''))).toEqual(hunk.lines.map((l) => l.text));
    expect(kinds(h.lines[0].tokens)).toEqual(['number:1']);
    // The old side's docstring spans both deleted lines; on the new side, the comment ends with its line.
    expect(kinds(h.lines[1].tokens)).toEqual(['string:"""old']);
    expect(kinds(h.lines[2].tokens)).toEqual(['string:doc"""']);
    expect(kinds(h.lines[3].tokens)).toEqual(['comment:# a comment']);
    expect(kinds(h.lines[4].tokens)).toEqual([]);
  });

  it('leaves an unknown language, and a file with no extension, plain', () => {
    expect(highlightHunks('main.rs', [hunk])).toEqual([hunk]);
    expect(highlightHunks('Dockerfile', [hunk])).toEqual([hunk]);
  });
});

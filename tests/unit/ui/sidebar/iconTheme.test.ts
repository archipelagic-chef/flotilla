import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));
const { buildIconMap, cssId, parseJsonc } = await import('../../../../src/ui/sidebar/iconTheme');

describe('parseJsonc', () => {
  it('reads JSON with comments and trailing commas, leaving strings alone', () => {
    expect(parseJsonc('{ // note\n "a": "http://x/*y*/", /* block */ "b": [1, 2,], }')).toEqual({ a: 'http://x/*y*/', b: [1, 2] });
    expect(parseJsonc('{"c": "quote \\" // still string"}')).toEqual({ c: 'quote " // still string' });
  });
});

describe('buildIconMap', () => {
  const theme = {
    file: 'default',
    folder: 'folder',
    fileExtensions: { TS: 'ts-icon', 'test.ts': 'test-icon' },
    fileNames: { 'package.json': 'npm' },
    languageIds: { typescript: 'lang-ts', markdown: 'md' },
    folderNames: { src: 'src-folder' },
    light: { file: 'default-light', fileExtensions: { ts: 'ts-light' } },
  };
  const languages = { extensions: { ts: 'typescript', md: 'markdown' }, filenames: { 'readme.md': 'markdown' } };

  it('lower-cases names and lets theme extensions win over language ids', () => {
    const map = buildIconMap(theme, false, languages);
    expect(map.file).toBe('default');
    expect(map.fileExtensions).toMatchObject({ ts: 'ts-icon', 'test.ts': 'test-icon', md: 'md' });
    expect(map.fileNames).toMatchObject({ 'package.json': 'npm', 'readme.md': 'md' });
    expect(map.folderNames).toEqual({ src: 'src-folder' });
  });

  it('uses the light variants in light themes', () => {
    const map = buildIconMap(theme, true, languages);
    expect(map.file).toBe('default-light');
    expect(map.fileExtensions.ts).toBe('ts-light');
  });

  it('makes icon ids safe as CSS class names', () => {
    expect(cssId('_ts_light')).toBe('fi-_ts_light');
    expect(cssId('a.b c')).toBe('fi-a_2eb_20c');
  });
});

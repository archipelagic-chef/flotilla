import { describe, expect, it } from 'vitest';
import { copyName, isSelfOrInside, nameProblem } from '../../../../src/ui/sidebar/fileNames';

describe('nameProblem', () => {
  it.each(['a.ts', 'src/new/b.ts', '.env', 'with space.md', 'a\\b.ts'])('accepts %s', (name) => expect(nameProblem(name)).toBeUndefined());
  it.each([
    ['', /must be provided/],
    ['   ', /must be provided/],
    ['/abs', /relative/],
    ['../up', /not a valid name/],
    ['a//b', /not a valid name/],
    ['bad:name', /not allowed/],
    ['con', /reserved/],
    ['nul.txt', /reserved/],
    ['trailing.', /can't end/],
  ])('rejects %j', (name, problem) => expect(nameProblem(name)).toMatch(problem));
});

describe('copyName', () => {
  it('names copies like the Explorer', () => {
    expect(copyName('a.ts', new Set())).toBe('a.ts');
    expect(copyName('a.ts', new Set(['a.ts']))).toBe('a copy.ts');
    expect(copyName('a.ts', new Set(['a.ts', 'a copy.ts']))).toBe('a copy 2.ts');
    expect(copyName('src', new Set(['src']))).toBe('src copy');
    expect(copyName('.env', new Set(['.env']))).toBe('.env copy');
  });
});

describe('isSelfOrInside', () => {
  it('detects moving a folder into itself', () => {
    expect(isSelfOrInside('/r/src', '/r/src')).toBe(true);
    expect(isSelfOrInside('/r/src', '/r/src/a')).toBe(true);
    expect(isSelfOrInside('/r/src', '/r/srcx')).toBe(false);
    expect(isSelfOrInside('/r/src', '/r')).toBe(false);
  });
});
